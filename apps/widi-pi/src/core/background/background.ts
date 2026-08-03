/**
 * The background job runtime: one owner for the whole pseudo-async tool result
 * lifecycle.
 *
 * A backgroundable tool call races a deadline. If the deadline wins, the call
 * settles with a job handle (t0) and the still-running work keeps going; its
 * outcome is injected later as a separate message (t1), because the protocol
 * has no deferred tool_result. Everything in between is this class.
 *
 * It is deliberately not a lane: one operation, one attempt, no conversation
 * tree, so no leaf, no navigation, no per-job model config, no attempt counter.
 *
 * Three boundaries it must keep. It never reads an agent record or any host map
 * - lifecycle reaches it only as attach/detach, and an attachment answers "is
 * this handle current?", never "is the agent alive". It never decides whether
 * an owner can receive a message. And a live job never makes its owner busy.
 *
 * Plan: `notes/plan/background-runtime.md`.
 */

import { formatError } from "../../utils/errors.ts";
import { utf8ByteLength } from "../../utils/text.ts";
import { jobOutputFileName, type SessionJobStore } from "./job-persistence.ts";
import { formatBackgroundJobResultMessageText, stopReasonFromOutcome } from "./messages.ts";
import {
	BackgroundJobOutput,
	DEFAULT_BACKGROUND_JOB_INCREMENT_MAX_BYTES,
	DEFAULT_BACKGROUND_JOB_OUTPUT_CEILING_BYTES,
	DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES,
} from "./output.ts";
import {
	type BackgroundJobChange,
	type BackgroundJobEvent,
	type BackgroundJobExecution,
	type BackgroundJobHost,
	type BackgroundJobLifecycleState,
	type BackgroundJobOrigin,
	type BackgroundJobOutcome,
	type BackgroundJobPersistenceHealth,
	type BackgroundJobReadResult,
	type BackgroundJobReport,
	type BackgroundJobReportSnapshot,
	type BackgroundJobRuntimeOptions,
	type BackgroundJobRuntimePorts,
	type BackgroundJobSettler,
	type BackgroundJobSnapshot,
	type BackgroundJobWatch,
	type CreateExternalJobInput,
	DEFAULT_BACKGROUND_JOB_PROGRESS_THROTTLE_MS,
	DEFAULT_BACKGROUND_JOB_REPORT_THROTTLE_MS,
	type JobHistoryEntry,
	type JobRecord,
	type JobResult,
	MAX_BACKGROUND_JOB_REPORT_BYTES,
	MAX_BACKGROUND_JOB_REPORT_KIND_BYTES,
	MAX_BACKGROUND_JOB_REPORT_SUMMARY_BYTES,
	type ObservableBackgroundJobState,
	type OwnerAttachment,
	type StartLocalJobInput,
} from "./types.ts";

const LOCAL_ORIGIN: BackgroundJobOrigin = Object.freeze({ kind: "local" });

/**
 * Everything the runtime holds for one attached agent. It outlives
 * `detachAgent` by as long as its tail takes to drain, because a job the detach
 * cancelled still has history to write; `detached` is what makes that window
 * safe, since nothing resolves, publishes, or delivers once it is set.
 */
interface AttachmentState {
	readonly agentId: string;
	readonly sessionId: string;
	/** Bumped on every re-attach of the same agent id; guards stale handles. */
	readonly generation: number;
	/** Absent for an ephemeral owner, and until `openOwnerStore` resolves. */
	store?: SessionJobStore;
	/** Downgraded to `degraded` by the first failed write, never restored. */
	health: BackgroundJobPersistenceHealth;
	/** True once the degradation was reported, so it is said once. */
	degradedReported: boolean;
	/** Set the moment `detachAgent` runs, before any job is cancelled. */
	detached: boolean;
	/** Job ids this agent owns, candidates included, in creation order. */
	readonly owned: Set<string>;
	/** Job ids this agent owes an outcome as external settler. */
	readonly owed: Set<string>;
	/** Live local subscribers, fed in the same order as published events. */
	readonly watchers: Set<(change: BackgroundJobChange) => void>;
	/**
	 * Serialized side effects: append, flush, event, t1 request. One chain per
	 * owner is what makes `abort_requested` observably precede `settled` even
	 * when the abort signal settles the job synchronously.
	 */
	tail: Promise<void>;
	/** The capability bundle handed out for this attachment. */
	readonly attachment: OwnerAttachment;
}

/**
 * A job in any state, observable or not. Candidates (`foreground`, `accepting`)
 * live in the same table as backgrounded jobs so there is one place to look up
 * an id; only the observable ones are ever handed out.
 */
interface LiveJob {
	readonly id: string;
	readonly ownerId: string;
	readonly ownerGeneration: number;
	readonly origin: BackgroundJobOrigin;
	/** Generation of the settler attachment at creation, for external jobs. */
	readonly settlerGeneration?: number;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly name?: string;
	readonly description?: string;
	readonly controller: AbortController;
	readonly output: BackgroundJobOutput;
	state: BackgroundJobLifecycleState;
	readonly startedAt: number;
	backgroundedAt?: number;
	endedAt?: number;
	stopReason?: string;
	report?: BackgroundJobReportSnapshot;
	/** Last accepted report revision; 0 means the job has no report. */
	reportRevision: number;
	/** True when a report update has not reached observers yet. */
	reportDirty: boolean;
	reportTimer?: ReturnType<typeof setTimeout>;
	reportQueued: boolean;
	lastReportAt: number;
	progressTimer?: ReturnType<typeof setTimeout>;
	progressQueued: boolean;
	lastProgressAt: number;
	/** Per-job monotonic progress emission counter. */
	progressSequence: number;
	/** True once the output ceiling fired for this job. */
	ceilingTripped: boolean;
}

export class BackgroundJobRuntime {
	private readonly _ports: BackgroundJobRuntimePorts;
	/** Attached agents by id; the only lifecycle fact this class holds. */
	private readonly _attachments = new Map<string, AttachmentState>();
	/** Every job, candidates included, keyed by the runtime-wide id. */
	private readonly _jobs = new Map<string, LiveJob>();
	private readonly _createJobId: () => string;
	private readonly _progressThrottleMs: number;
	private readonly _reportThrottleMs: number;
	private readonly _outputCeilingBytes: number;
	private readonly _incrementMaxBytes: number;
	/** Runtime-wide: ids never restart, so the settler index can key on one. */
	private _nextJobId = 0;
	private _nextGeneration = 0;

	constructor(ports: BackgroundJobRuntimePorts, options: BackgroundJobRuntimeOptions = {}) {
		this._ports = ports;
		this._createJobId = options.createJobId ?? (() => `job-${++this._nextJobId}`);
		this._progressThrottleMs = options.progressThrottleMs ?? DEFAULT_BACKGROUND_JOB_PROGRESS_THROTTLE_MS;
		this._reportThrottleMs = options.reportThrottleMs ?? DEFAULT_BACKGROUND_JOB_REPORT_THROTTLE_MS;
		this._outputCeilingBytes = options.outputCeilingBytes ?? DEFAULT_BACKGROUND_JOB_OUTPUT_CEILING_BYTES;
		this._incrementMaxBytes = options.incrementMaxBytes ?? DEFAULT_BACKGROUND_JOB_INCREMENT_MAX_BYTES;
	}

	/**
	 * Bring an agent into scope and hand back its two capabilities. An owner with
	 * no session directory attaches as `ephemeral` and keeps no history. A second
	 * attach of the same id is a new generation: it inherits nothing, and does
	 * not become the settler of jobs the previous generation owed.
	 */
	async attachAgent(input: { agentId: string; sessionId: string }): Promise<OwnerAttachment> {
		this.detachAgent(input.agentId);
		const state = this._createAttachment(input.agentId, input.sessionId);
		// Registered before the await: a tool starting a job in the same tick must
		// find its scope, and a detach during the open must invalidate it.
		this._attachments.set(input.agentId, state);
		try {
			const store = await this._ports.openOwnerStore({ agentId: input.agentId, sessionId: input.sessionId });
			// Detached or superseded while the store was opening: it belongs to
			// nobody.
			if (this._attachments.get(input.agentId) !== state) {
				return state.attachment;
			}
			if (store) {
				state.store = store;
				state.health = store.truncated ? "degraded" : "durable";
				state.degradedReported = store.truncated;
				if (store.truncated) {
					await this._diagnose({
						severity: "warning",
						code: "background.history_incomplete",
						message: `The background job history for agent ${input.agentId} could not be read back in full, so earlier jobs are missing from it.`,
						agentId: input.agentId,
					});
				}
			}
		} catch (error) {
			// A store that cannot be opened degrades the history, not the agent:
			// jobs keep running, they just stop being recoverable across a restart.
			state.health = "degraded";
			state.degradedReported = true;
			await this._diagnose({
				severity: "warning",
				code: "background.history_unavailable",
				message: `Cannot record background jobs for agent ${input.agentId}: ${formatError(error)}`,
				agentId: input.agentId,
			});
		}
		return state.attachment;
	}

	/**
	 * Take an agent out of scope: invalidate the attachment synchronously, then
	 * force-cancel the jobs it owned and the external jobs it owed, so nothing is
	 * left waiting on a settler that will never write it. A detached owner gets
	 * no events and no t1, but history is still written, which is why the scope
	 * is dropped only once its tail has drained.
	 *
	 * Ordering is contract: the host calls this after marking the agent disposing
	 * and before any other teardown.
	 */
	detachAgent(agentId: string): void {
		const state = this._attachments.get(agentId);
		if (!state || state.detached) return;
		state.detached = true;
		state.watchers.clear();
		for (const jobId of [...state.owned]) {
			const record = this._jobs.get(jobId);
			if (record) this._forceCancel(record, `Agent ${agentId} was disposed.`);
		}
		// Work this agent owed to other agents cannot be settled now. Cancelling
		// the owner's job reports that through the owner's normal t1 path; the
		// owner itself stays live.
		for (const jobId of [...state.owed]) {
			const record = this._jobs.get(jobId);
			if (record) {
				this._forceCancel(record, `Settler agent ${agentId} was disposed before it reported a result.`);
			}
		}
		void state.tail.then(() => {
			// A re-attach may already own this id; only the scope that was detached
			// is dropped.
			if (this._attachments.get(agentId) === state) {
				this._attachments.delete(agentId);
			}
		});
	}

	/** Owner-scoped capability. Identity is closed over, never taken from input. */
	hostFor(agentId: string): BackgroundJobHost | undefined {
		return this._current(agentId)?.attachment.host;
	}

	/** Settler-scoped capability: write the outcome of someone else's job. */
	settlerFor(agentId: string): BackgroundJobSettler | undefined {
		return this._current(agentId)?.attachment.settler;
	}

	/** Observable jobs owned by `agentId`, oldest first. Candidates never appear. */
	listJobs(agentId: string): readonly BackgroundJobSnapshot[] {
		const state = this._current(agentId);
		if (!state) return [];
		const jobs: BackgroundJobSnapshot[] = [];
		for (const jobId of state.owned) {
			const record = this._jobs.get(jobId);
			if (record && isObservable(record.state)) {
				jobs.push(this._snapshot(record));
			}
		}
		return jobs;
	}

	/**
	 * Current rolling output tail of one job. Rejects rather than reading empty
	 * for an unknown id, so a caller can tell "nothing yet" from "not a job".
	 */
	readJobOutput(agentId: string, jobId: string): JobResult<{ read: BackgroundJobReadResult }> {
		const record = this._jobs.get(jobId);
		if (!record || record.ownerId !== agentId) {
			return { ok: false, reason: "unknown_job" };
		}
		if (!isObservable(record.state)) {
			return { ok: false, reason: "not_backgrounded" };
		}
		return { ok: true, read: { job: this._snapshot(record), output: record.output.read() } };
	}

	/**
	 * Request an abort. Synchronous and idempotent; the confirmation arrives later
	 * as the job's settlement.
	 */
	abortJob(agentId: string, jobId: string, reason?: string): JobResult {
		const record = this._jobs.get(jobId);
		if (!record || record.ownerId !== agentId) {
			return { ok: false, reason: "unknown_job" };
		}
		if (!isObservable(record.state)) {
			return { ok: false, reason: "not_backgrounded" };
		}
		this._requestAbort(record, reason);
		return { ok: true };
	}

	/** Information for consumers, never a criterion for whether an agent is busy. */
	liveJobCount(agentId: string): number {
		return this.listJobs(agentId).length;
	}

	/** Every job on record, earlier runs included. It materializes no live job. */
	history(agentId: string): readonly JobHistoryEntry[] {
		return this._current(agentId)?.store?.history() ?? [];
	}

	/**
	 * Jobs the branch had open when this runtime attached: the t0 handles whose
	 * executor no longer exists. Whether each still owes the model a message is
	 * the session history's answer, so this is only the input to the host's
	 * resume reconciliation.
	 */
	carriedOverJobs(agentId: string): readonly JobHistoryEntry[] {
		return this._current(agentId)?.store?.carriedOverJobs() ?? [];
	}

	/**
	 * Settle a job from outside its owner. A forwarding seam for hosts that hold
	 * an id rather than a capability, under the same authorization.
	 */
	settleJob(agentId: string, jobId: string, outcome: BackgroundJobOutcome, settledBy: string): JobResult {
		const settler = this._current(settledBy);
		if (!settler) return { ok: false, reason: "stale_attachment" };
		return this._settleExternal(settler.agentId, settler.generation, agentId, jobId, outcome);
	}

	// -- attachment ---------------------------------------------------------

	/** The agent's live scope, or nothing once it has been detached. */
	private _current(agentId: string): AttachmentState | undefined {
		const state = this._attachments.get(agentId);
		return state && !state.detached ? state : undefined;
	}

	/** Both must hold: the agent is attached, and this handle is its current one. */
	private _resolve(agentId: string, generation: number): AttachmentState | undefined {
		const state = this._current(agentId);
		return state?.generation === generation ? state : undefined;
	}

	private _createAttachment(agentId: string, sessionId: string): AttachmentState {
		const generation = ++this._nextGeneration;
		// Capabilities resolve by (agentId, generation) on every call rather than
		// closing over the state, which keeps the guard a single expression.
		const health = () => this._attachments.get(agentId)?.health ?? "ephemeral";
		return {
			agentId,
			sessionId,
			generation,
			health: "ephemeral",
			degradedReported: false,
			detached: false,
			owned: new Set(),
			owed: new Set(),
			watchers: new Set(),
			tail: Promise.resolve(),
			attachment: {
				agentId,
				sessionId,
				generation,
				get persistenceHealth(): BackgroundJobPersistenceHealth {
					return health();
				},
				host: this._createHost(agentId, generation),
				settler: this._createSettler(agentId, generation),
			},
		};
	}

	private _createHost(agentId: string, generation: number): BackgroundJobHost {
		return {
			startLocal: (input) => {
				const state = this._resolve(agentId, generation);
				return state
					? { ok: true, execution: this._startLocal(state, input) }
					: { ok: false, reason: "stale_attachment" };
			},
			createExternal: (input) => this._createExternal(agentId, generation, input),
			list: () => (this._resolve(agentId, generation) ? this.listJobs(agentId) : []),
			read: (jobId) =>
				this._resolve(agentId, generation)
					? this.readJobOutput(agentId, jobId)
					: { ok: false, reason: "stale_attachment" },
			watch: () => this._watch(agentId, generation),
			abort: (jobId, reason) =>
				this._resolve(agentId, generation)
					? this.abortJob(agentId, jobId, reason)
					: { ok: false, reason: "stale_attachment" },
		};
	}

	private _createSettler(agentId: string, generation: number): BackgroundJobSettler {
		return {
			settle: (input) => this._settleExternal(agentId, generation, input.ownerAgentId, input.jobId, input.outcome),
		};
	}

	/**
	 * Snapshot and start buffering in one step, so a caller can list and subscribe
	 * without a gap. Nothing is dropped and nothing arrives twice.
	 */
	private _watch(agentId: string, generation: number): BackgroundJobWatch {
		const state = this._resolve(agentId, generation);
		const jobs = state ? this.listJobs(agentId) : [];
		const buffered: BackgroundJobChange[] = [];
		let listener: ((change: BackgroundJobChange) => void) | undefined;
		const watcher = (change: BackgroundJobChange) => {
			if (listener) listener(change);
			else buffered.push(change);
		};
		state?.watchers.add(watcher);
		return {
			jobs,
			start: (next) => {
				listener = next;
				for (const change of buffered.splice(0)) next(change);
				return () => {
					listener = undefined;
					state?.watchers.delete(watcher);
				};
			},
		};
	}

	// -- job creation -------------------------------------------------------

	private _startLocal(state: AttachmentState, input: StartLocalJobInput): BackgroundJobExecution {
		const record = this._createRecord(state, input, LOCAL_ORIGIN);
		return {
			jobId: record.id,
			signal: record.controller.signal,
			output: record.output,
			setReport: (report) => this._setReport(record, report),
			acceptBackground: () => this._acceptBackground(record),
			settle: (outcome) => {
				const disposition = this._settle(record, outcome);
				return disposition === "ignored" ? { ok: false, reason: "unknown_job" } : { ok: true, disposition };
			},
		};
	}

	/**
	 * Create a job another agent will settle, returning only once it has a durable
	 * head: an assignment whose job left no trace is how a task ends up owed by
	 * nobody. The settler is validated on both sides of the append, because that
	 * await is exactly where it can be disposed.
	 */
	private async _createExternal(
		agentId: string,
		generation: number,
		input: CreateExternalJobInput,
	): Promise<JobResult<{ job: BackgroundJobSnapshot }>> {
		const state = this._resolve(agentId, generation);
		if (!state) return { ok: false, reason: "stale_attachment" };
		const settler = this._current(input.settlerAgentId);
		if (!settler) return { ok: false, reason: "stale_attachment" };
		const record = this._createRecord(
			state,
			input,
			Object.freeze({ kind: "external", settlerId: input.settlerAgentId }),
			settler.generation,
		);
		settler.owed.add(record.id);
		record.state = "accepting";
		const committed = await this._commitBackgrounded(state, record);
		if (!committed.ok) return committed;
		if (this._resolve(input.settlerAgentId, settler.generation) === undefined) {
			this._forceCancel(record, `Settler agent ${input.settlerAgentId} was disposed before the assignment was sent.`);
			return { ok: false, reason: "stale_attachment" };
		}
		return committed;
	}

	private _createRecord(
		state: AttachmentState,
		input: StartLocalJobInput,
		origin: BackgroundJobOrigin,
		settlerGeneration?: number,
	): LiveJob {
		const id = this._createJobId();
		const startedAt = Date.now();
		const controller = new AbortController();
		const output = new BackgroundJobOutput(DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES, {
			incrementMaxBytes: this._incrementMaxBytes,
			onAppend: () => this._onOutputAppend(id),
		});
		const initialReport =
			input.report === undefined
				? undefined
				: freezeReportSnapshot(validateBackgroundJobReport(input.report), 1, startedAt);
		const record: LiveJob = {
			id,
			ownerId: state.agentId,
			ownerGeneration: state.generation,
			// Detached and frozen: the origin is the settlement authority, and the
			// caller's input object must not be able to rename the settler.
			origin,
			settlerGeneration,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			name: input.name,
			description: input.description,
			controller,
			output,
			state: "foreground",
			startedAt,
			report: initialReport,
			reportRevision: initialReport?.revision ?? 0,
			reportDirty: false,
			reportQueued: false,
			lastReportAt: 0,
			progressQueued: false,
			lastProgressAt: 0,
			progressSequence: 0,
			ceilingTripped: false,
		};
		this._jobs.set(id, record);
		state.owned.add(id);
		return record;
	}

	// -- acceptance ---------------------------------------------------------

	/**
	 * Take a local candidate into the background. Synchronous, so registration
	 * completes before the caller's first await. The head record is enqueued
	 * rather than awaited, which is the one place this runtime does not yet meet
	 * its own persistence contract.
	 */
	private _acceptBackground(record: LiveJob): JobResult<{ job: BackgroundJobSnapshot }> {
		const state = this._resolve(record.ownerId, record.ownerGeneration);
		if (!state) return { ok: false, reason: "stale_attachment" };
		if (isTerminal(record.state)) return { ok: false, reason: "unknown_job" };
		if (record.state !== "foreground") {
			return { ok: false, reason: "not_backgrounded" };
		}
		record.state = "backgrounded";
		record.backgroundedAt = Date.now();
		record.lastReportAt = record.backgroundedAt;
		const job = this._snapshot(record);
		void this._enqueue(state, async () => {
			await this._write(state, this._startedRecord(state, record));
			await this._publishChange(state, { transition: "backgrounded", job });
		});
		// Output from the pre-t0 window becomes observable only after the
		// backgrounded event: nobody sees a job before its handle exists.
		if (record.output.totalBytesSeen > 0) this._scheduleProgress(record);
		return { ok: true, job };
	}

	/**
	 * Unlike the local path this awaits the append: nothing has been returned to a
	 * model yet, so a failure here means the job never existed.
	 */
	private async _commitBackgrounded(
		state: AttachmentState,
		record: LiveJob,
	): Promise<JobResult<{ job: BackgroundJobSnapshot }>> {
		record.state = "backgrounded";
		record.backgroundedAt = Date.now();
		record.lastReportAt = record.backgroundedAt;
		const job = this._snapshot(record);
		const head = this._startedRecord(state, record);
		try {
			await this._enqueue(state, () => this._append(state, head));
		} catch (error) {
			record.state = "cancelled";
			this._discard(record);
			await this._degrade(state, error);
			return { ok: false, reason: "degraded" };
		}
		void this._enqueue(state, () => this._publishChange(state, { transition: "backgrounded", job }));
		return { ok: true, job };
	}

	// -- abort and settlement ----------------------------------------------

	/**
	 * Accept an abort request. State and signal commit synchronously while the
	 * event goes on the owner's tail, which keeps `abort_requested` ahead of the
	 * `settled` a synchronous signal handler can produce. Nothing is recorded: a
	 * request does not change whether the job is owed.
	 */
	private _requestAbort(record: LiveJob, reason?: string): void {
		if (isTerminal(record.state)) return;
		record.stopReason ??= reason;
		const state = this._attachments.get(record.ownerId);
		const announce = record.state === "backgrounded" && !record.controller.signal.aborted;
		if (announce) {
			record.state = "abort_requested";
			if (state) {
				const job = this._snapshot(record);
				void this._enqueue(state, async () => {
					await this._publishChange(state, { transition: "abort_requested", job });
				});
			}
		}
		record.controller.abort();
		// An external job has no executor watching the signal, so nothing would ever
		// confirm the abort. Complete it here rather than leave it stuck.
		if (record.origin.kind === "external" && !isTerminal(record.state)) {
			this._settle(record, { status: "cancelled" });
		}
	}

	/** Abort and settle in one step, for a scope that is going away. */
	private _forceCancel(record: LiveJob, reason: string): void {
		if (isTerminal(record.state)) return;
		record.stopReason ??= reason;
		record.controller.abort();
		this._settle(record, { status: "cancelled" });
	}

	/**
	 * Commit a terminal outcome, at most once, then run the settlement tail: final
	 * report, final progress, terminal record, terminal event, t1 request - in
	 * that order, which is why `settled` is a barrier. `inline` means the job
	 * settled inside the pre-t0 window and was never observable at all.
	 */
	private _settle(record: LiveJob, outcome: BackgroundJobOutcome): "inline" | "backgrounded" | "ignored" {
		if (isTerminal(record.state)) return "ignored";
		const observable = isObservable(record.state);
		record.endedAt = Date.now();
		record.stopReason ??= stopReasonFromOutcome(outcome);
		record.state = outcome.status;
		this._clearTimers(record);
		this._discard(record);
		if (!observable) return "inline";
		// A detached scope still counts: it holds the store, so history lands even
		// though nothing will be published or delivered.
		const state = this._attachments.get(record.ownerId);
		if (!state) return "backgrounded";
		const job = this._snapshot(record);
		const messageText = formatBackgroundJobResultMessageText({ job, outcome });
		const outputTail = record.output.read();
		const endedAt = record.endedAt;
		const stopReason = record.stopReason;
		void this._enqueue(state, async () => {
			await this._flushReport(state, record);
			await this._flushProgress(state, record);
			await this._write(state, {
				kind: "settled",
				toolCallId: record.toolCallId,
				status: outcome.status,
				...(stopReason === undefined ? undefined : { stopReason }),
				endedAt,
				messageText,
				...(outputTail.length === 0 ? undefined : { outputTail }),
			});
			await this._publishChange(state, { transition: "settled", job, outcome });
			if (state.detached) return;
			try {
				await this._ports.deliverResult({ ownerAgentId: record.ownerId, jobId: record.id, body: messageText });
			} catch (error) {
				// The port owns delivery policy, retries included. Reaching here means
				// the owner can never take this result.
				await this._diagnose({
					severity: "warning",
					code: "background.result_delivery_failed",
					message: `The result of background job ${record.id} could not be handed to agent ${record.ownerId}: ${formatError(error)}`,
					agentId: record.ownerId,
				});
			}
		});
		return "backgrounded";
	}

	private _settleExternal(
		settlerId: string,
		settlerGeneration: number,
		ownerAgentId: string,
		jobId: string,
		outcome: BackgroundJobOutcome,
	): JobResult {
		if (!this._resolve(settlerId, settlerGeneration)) {
			return { ok: false, reason: "stale_attachment" };
		}
		const record = this._jobs.get(jobId);
		if (!record || record.ownerId !== ownerAgentId) {
			return { ok: false, reason: "unknown_job" };
		}
		if (record.origin.kind !== "external" || record.origin.settlerId !== settlerId) {
			return { ok: false, reason: "not_settler" };
		}
		// Matching the id is not enough: a re-attached agent must not inherit the
		// authority its predecessor was assigned.
		if (record.settlerGeneration !== settlerGeneration) {
			return { ok: false, reason: "stale_attachment" };
		}
		if (!isObservable(record.state)) {
			return { ok: false, reason: "not_backgrounded" };
		}
		return this._settle(record, outcome) === "ignored" ? { ok: false, reason: "unknown_job" } : { ok: true };
	}

	/** Drop a job from the live indexes. Its record stays readable to the tail. */
	private _discard(record: LiveJob): void {
		this._jobs.delete(record.id);
		this._attachments.get(record.ownerId)?.owned.delete(record.id);
		if (record.origin.kind === "external") {
			this._attachments.get(record.origin.settlerId)?.owed.delete(record.id);
		}
	}

	// -- report -------------------------------------------------------------

	private _setReport(record: LiveJob, report: BackgroundJobReport): JobResult {
		if (isTerminal(record.state)) {
			return { ok: false, reason: "unknown_job" };
		}
		// An invalid report is a bug in the calling tool, not a lifecycle outcome,
		// so it throws where that tool can see it.
		const value = validateBackgroundJobReport(report);
		record.reportRevision += 1;
		record.report = freezeReportSnapshot(value, record.reportRevision, Date.now());
		if (isObservable(record.state)) {
			record.reportDirty = true;
			this._scheduleReport(record);
		}
		return { ok: true };
	}

	/**
	 * Emit at most once per throttle window. A burst collapses into one emission
	 * carrying the newest revision: the report is a latest-value register.
	 */
	private _scheduleReport(record: LiveJob): void {
		if (record.reportTimer !== undefined) return;
		const elapsed = Date.now() - record.lastReportAt;
		if (elapsed >= this._reportThrottleMs) {
			this._queueReport(record);
			return;
		}
		record.reportTimer = setTimeout(() => {
			record.reportTimer = undefined;
			if (isTerminal(record.state)) return;
			this._queueReport(record);
		}, this._reportThrottleMs - elapsed);
		record.reportTimer.unref?.();
	}

	private _queueReport(record: LiveJob): void {
		const state = this._attachments.get(record.ownerId);
		if (!state || record.reportQueued) return;
		record.reportQueued = true;
		void this._enqueue(state, async () => {
			record.reportQueued = false;
			await this._flushReport(state, record);
		});
	}

	private async _flushReport(state: AttachmentState, record: LiveJob): Promise<void> {
		const report = record.report;
		if (!record.reportDirty || report === undefined) return;
		record.reportDirty = false;
		record.lastReportAt = Date.now();
		// Reports are not recorded: high frequency, droppable, and only meaningful
		// to a process that is still running.
		if (state.detached) return;
		await this._publish({
			type: "job_report",
			agentId: record.ownerId,
			jobId: record.id,
			report,
			changedAt: new Date(report.updatedAt).toISOString(),
			operationRef: record.toolCallId,
		});
	}

	// -- output and progress ------------------------------------------------

	/**
	 * Trip the cooperative circuit breaker when the total crosses the ceiling,
	 * then schedule a progress emission - only once t0 made the job observable.
	 */
	private _onOutputAppend(jobId: string): void {
		const record = this._jobs.get(jobId);
		if (!record || isTerminal(record.state)) return;
		if (
			!record.ceilingTripped &&
			this._outputCeilingBytes > 0 &&
			record.output.totalBytesSeen > this._outputCeilingBytes
		) {
			record.ceilingTripped = true;
			this._requestAbort(record, ceilingReason(this._outputCeilingBytes));
			return;
		}
		if (isObservable(record.state)) this._scheduleProgress(record);
	}

	private _scheduleProgress(record: LiveJob): void {
		if (record.progressTimer !== undefined) return;
		const elapsed = Date.now() - record.lastProgressAt;
		if (elapsed >= this._progressThrottleMs) {
			this._queueProgress(record);
			return;
		}
		record.progressTimer = setTimeout(() => {
			record.progressTimer = undefined;
			if (isTerminal(record.state)) return;
			this._queueProgress(record);
		}, this._progressThrottleMs - elapsed);
		record.progressTimer.unref?.();
	}

	/**
	 * One coalesced drain per job: while it is queued further ticks are no-ops, so
	 * a producer faster than the emit pump cannot grow the queue.
	 */
	private _queueProgress(record: LiveJob): void {
		const state = this._attachments.get(record.ownerId);
		if (!state || record.progressQueued) return;
		record.progressQueued = true;
		void this._enqueue(state, async () => {
			record.progressQueued = false;
			await this._flushProgress(state, record);
		});
	}

	private async _flushProgress(state: AttachmentState, record: LiveJob): Promise<void> {
		const increment = record.output.drainIncrement();
		if (!increment) return;
		record.lastProgressAt = Date.now();
		const sequence = record.progressSequence++;
		if (state.detached) return;
		await this._publish({
			type: "job_progress",
			agentId: record.ownerId,
			jobId: record.id,
			sequence,
			chunk: increment.chunk,
			startByte: increment.startByte,
			endByte: increment.endByte,
			totalBytesSeen: increment.totalBytesSeen,
			progressDroppedBytes: increment.progressDroppedBytes,
			observedAt: new Date().toISOString(),
			operationRef: record.toolCallId,
		});
	}

	private _clearTimers(record: LiveJob): void {
		if (record.progressTimer !== undefined) {
			clearTimeout(record.progressTimer);
			record.progressTimer = undefined;
		}
		if (record.reportTimer !== undefined) {
			clearTimeout(record.reportTimer);
			record.reportTimer = undefined;
		}
	}

	// -- side-effect tail ---------------------------------------------------

	/**
	 * Chain a side effect onto the owner's tail. The returned promise reflects this
	 * task; the chain itself absorbs failures so one cannot stall the rest.
	 */
	private _enqueue(state: AttachmentState, task: () => Promise<void>): Promise<void> {
		const result = state.tail.then(task);
		state.tail = result.catch(() => {});
		return result;
	}

	private _startedRecord(state: AttachmentState, record: LiveJob): JobRecord {
		return {
			kind: "started",
			toolCallId: record.toolCallId,
			jobId: record.id,
			ownerAgentId: record.ownerId,
			sessionId: state.sessionId,
			toolName: record.toolName,
			...(record.name === undefined ? undefined : { name: record.name }),
			...(record.description === undefined ? undefined : { description: record.description }),
			origin: record.origin,
			startedAt: record.startedAt,
			backgroundedAt: record.backgroundedAt ?? record.startedAt,
			outputFile: jobOutputFileName(record.toolCallId),
		};
	}

	/** Append, or throw. Used where a failure must change what the caller does. */
	private async _append(state: AttachmentState, record: JobRecord): Promise<void> {
		if (!state.store) return;
		await state.store.append(record);
	}

	/**
	 * Append after t0, where liveness outweighs the history: a job the model was
	 * told about cannot be un-backgrounded because a write failed.
	 */
	private async _write(state: AttachmentState, record: JobRecord): Promise<void> {
		try {
			await this._append(state, record);
		} catch (error) {
			await this._degrade(state, error);
		}
	}

	private async _degrade(state: AttachmentState, error: unknown): Promise<void> {
		state.health = "degraded";
		if (state.degradedReported) return;
		state.degradedReported = true;
		await this._diagnose({
			severity: "warning",
			code: "background.history_write_failed",
			message: `Background jobs for agent ${state.agentId} are no longer being recorded; results of jobs still running will not survive a restart: ${formatError(error)}`,
			agentId: state.agentId,
		});
	}

	private async _publishChange(state: AttachmentState, change: BackgroundJobChange): Promise<void> {
		if (state.detached) return;
		// Local watchers first and synchronously: a waiting tool must not learn of a
		// settlement later than a surface does.
		for (const watcher of state.watchers) {
			try {
				watcher(change);
			} catch {
				// One watcher's failure cannot drop the others or the event after it.
			}
		}
		await this._publish({
			type: "job_changed",
			agentId: state.agentId,
			job: change.job,
			transition: change.transition,
			liveCount: this.liveJobCount(state.agentId),
			changedAt: new Date().toISOString(),
		});
	}

	private async _publish(event: BackgroundJobEvent): Promise<void> {
		try {
			await this._ports.publish(event);
		} catch {
			// A consumer that throws cannot break this owner's ordering.
		}
	}

	private async _diagnose(diagnostic: Parameters<BackgroundJobRuntimePorts["diagnose"]>[0]): Promise<void> {
		try {
			await this._ports.diagnose(diagnostic);
		} catch {
			// A diagnostic that cannot be reported is not worth failing a job for.
		}
	}

	// -- snapshots ----------------------------------------------------------

	private _snapshot(record: LiveJob): BackgroundJobSnapshot {
		return {
			jobId: record.id,
			ownerAgentId: record.ownerId,
			origin: record.origin,
			toolCallId: record.toolCallId,
			toolName: record.toolName,
			...(record.name === undefined ? undefined : { name: record.name }),
			...(record.description === undefined ? undefined : { description: record.description }),
			...(record.report === undefined ? undefined : { report: record.report }),
			state: record.state as ObservableBackgroundJobState,
			...(record.stopReason === undefined ? undefined : { stopReason: record.stopReason }),
			startedAt: record.startedAt,
			backgroundedAt: record.backgroundedAt ?? record.startedAt,
			...(record.endedAt === undefined ? undefined : { endedAt: record.endedAt }),
			totalBytesSeen: record.output.totalBytesSeen,
			tailDroppedBytes: record.output.tailDroppedBytes,
			progressDroppedBytes: record.output.progressDroppedBytes,
		};
	}
}

function isTerminal(state: BackgroundJobLifecycleState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}

function isObservable(state: BackgroundJobLifecycleState): boolean {
	return state === "backgrounded" || state === "abort_requested";
}

function ceilingReason(ceilingBytes: number): string {
	const mib = Math.floor(ceilingBytes / (1024 * 1024));
	return (
		`Output limit exceeded: the job produced more than ${mib} MiB and was ` +
		`terminated. Redirect large output to a file (for example \`command > out.txt\`) ` +
		`and inspect it in slices instead.`
	);
}

/**
 * Validate, detach, and deeply freeze a tool-published report: later mutation of
 * the tool's input object cannot change the job without a new revision.
 */
function validateBackgroundJobReport(report: BackgroundJobReport): BackgroundJobReport {
	if (typeof report !== "object" || report === null) {
		throw new TypeError("Background job report must be an object.");
	}
	assertBoundedReportText(report.kind, "Background job report kind", MAX_BACKGROUND_JOB_REPORT_KIND_BYTES);
	if (!Number.isInteger(report.schemaVersion) || report.schemaVersion < 1) {
		throw new TypeError("Background job report schemaVersion must be a positive integer.");
	}
	if (report.summary !== undefined) {
		assertBoundedReportText(report.summary, "Background job report summary", MAX_BACKGROUND_JOB_REPORT_SUMMARY_BYTES);
	}
	const progress = report.progress;
	if (progress !== undefined) {
		if (typeof progress !== "object" || progress === null) {
			throw new TypeError("Background job report progress must be an object.");
		}
		assertNonNegativeReportInteger(progress.completed, "Background job report progress completed");
		if (progress.total !== undefined) {
			assertNonNegativeReportInteger(progress.total, "Background job report progress total");
			if (progress.completed > progress.total) {
				throw new RangeError("Background job report progress completed cannot exceed total.");
			}
		}
	}
	const normalized: BackgroundJobReport = {
		kind: report.kind,
		schemaVersion: report.schemaVersion,
		...(report.summary === undefined ? undefined : { summary: report.summary }),
		...(progress === undefined
			? undefined
			: {
					progress: {
						completed: progress.completed,
						...(progress.total === undefined ? undefined : { total: progress.total }),
					},
				}),
		...(report.data === undefined ? undefined : { data: report.data }),
	};
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(normalized);
	} catch (error) {
		const message = error instanceof Error ? `: ${error.message}` : "";
		throw new TypeError(`Background job report must be JSON serializable${message}.`);
	}
	if (serialized === undefined) {
		throw new TypeError("Background job report must be JSON serializable.");
	}
	if (utf8ByteLength(serialized) > MAX_BACKGROUND_JOB_REPORT_BYTES) {
		throw new RangeError(
			`Background job report exceeds ${MAX_BACKGROUND_JOB_REPORT_BYTES} UTF-8 bytes when serialized.`,
		);
	}
	const detached = JSON.parse(serialized) as BackgroundJobReport;
	deepFreeze(detached);
	return detached;
}

function assertBoundedReportText(value: string, label: string, maxBytes: number): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${label} must be a non-empty string.`);
	}
	if (utf8ByteLength(value) > maxBytes) {
		throw new RangeError(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
	}
}

function assertNonNegativeReportInteger(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new TypeError(`${label} must be a non-negative integer.`);
	}
}

function deepFreeze(value: unknown): void {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return;
	}
	for (const child of Object.values(value)) deepFreeze(child);
	Object.freeze(value);
}

/** Freeze a validated report value into the job's next revision. */
function freezeReportSnapshot(
	value: BackgroundJobReport,
	revision: number,
	updatedAt: number,
): BackgroundJobReportSnapshot {
	return Object.freeze({ revision, updatedAt, value });
}
