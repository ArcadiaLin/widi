/**
 * The background job runtime: one owner for the whole pseudo-async tool result
 * lifecycle.
 *
 * A backgroundable tool call races a deadline. If the deadline wins, the call
 * settles immediately with a job handle (t0) and the still-running work keeps
 * going; its eventual outcome is injected later as a separate message (t1),
 * because the protocol has no deferred tool_result. Everything between those
 * two points - acceptance, abort, settlement, the durable history, the per-owner
 * ordering of what observers see - is this class.
 *
 * It is deliberately not a lane. A background job is one operation with a single
 * attempt that writes no conversation tree: its only footprint on the session is
 * one t1 delivered through the owner's ordinary input path. So there is no leaf,
 * no navigation, no per-job model config, no attempt counter, and no step/tool
 * event nesting. Where a rule here matches `packages/agent/docs/harness-v2.md`,
 * it is the same rule for the same reason; where one is absent, that equation is
 * the reason.
 *
 * Boundaries this class holds and must keep holding:
 *
 * - It never reads an agent record, an agent status, or any host map. Agent
 *   lifecycle reaches it only as `attachAgent`/`detachAgent`. An attachment is
 *   not a source of truth about whether an agent is alive; it answers exactly
 *   one question, "is this capability handle the current generation?".
 * - It never decides whether an owner can receive a message. Delivery is a
 *   request through `deliverResult`, and the host's delivery phase decides the
 *   rest.
 * - Live jobs are not agent business. A job outstanding does not make its owner
 *   busy, so nothing here feeds an idle judgement; the live count is
 *   information for consumers, never a criterion.
 *
 * State is the reduction of the records, not something the records shadow: the
 * live path feeds this reducer in-memory transitions and the same records go to
 * the journal, so `listJobs` and `history` cannot disagree about a job.
 *
 * Plan: `notes/plan/background-runtime.md`.
 */

import { formatError } from "../../utils/errors.ts";
import { utf8ByteLength } from "../../utils/text.ts";
import {
	formatBackgroundJobResultMessageText,
	stopReasonFromOutcome,
} from "./messages.ts";
import {
	BackgroundJobOutput,
	DEFAULT_BACKGROUND_JOB_INCREMENT_MAX_BYTES,
	DEFAULT_BACKGROUND_JOB_OUTPUT_CEILING_BYTES,
	DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES,
} from "./output.ts";
import {
	BACKGROUND_JOB_JOURNAL_SCHEMA_VERSION,
	type BackgroundJobChange,
	type BackgroundJobEvent,
	type BackgroundJobExecution,
	type BackgroundJobHost,
	type BackgroundJobJournal,
	type BackgroundJobJournalRecord,
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
	type JobResult,
	MAX_BACKGROUND_JOB_REPORT_BYTES,
	MAX_BACKGROUND_JOB_REPORT_KIND_BYTES,
	MAX_BACKGROUND_JOB_REPORT_SUMMARY_BYTES,
	type ObservableBackgroundJobState,
	type OwnerAttachment,
	type PersistedBackgroundJob,
	type StartLocalJobInput,
} from "./types.ts";

const LOCAL_ORIGIN: BackgroundJobOrigin = Object.freeze({ kind: "local" });

/**
 * Everything the runtime holds for one attached agent.
 *
 * It outlives `detachAgent` by exactly as long as its tail takes to drain: the
 * journal is here, and a job cancelled by the detach still has history to write.
 * `detached` is what makes that window safe - from the moment it is set, no
 * capability resolves against this scope and nothing is published or delivered.
 */
interface AttachmentState {
	readonly agentId: string;
	readonly sessionId: string;
	/** Bumped on every re-attach of the same agent id; guards stale handles. */
	readonly generation: number;
	/** Absent for an ephemeral owner, and until `openOwnerJournal` resolves. */
	journal?: BackgroundJobJournal;
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
	 * Serialized side-effect tail: journal append, report flush, progress flush,
	 * lifecycle event, t1 request. One chain per owner is what makes
	 * `abort_requested` observably precede `settled` even when the abort signal
	 * settles the job synchronously, and what keeps a slow owner from holding up
	 * another.
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
interface JobRecord {
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
	private readonly _jobs = new Map<string, JobRecord>();
	/** Distinguishes `job-N` of this process from the same id in a journal. */
	private readonly _epoch: string;
	private readonly _createJobId: () => string;
	private readonly _progressThrottleMs: number;
	private readonly _reportThrottleMs: number;
	private readonly _outputCeilingBytes: number;
	private readonly _incrementMaxBytes: number;
	/**
	 * Runtime-wide, not per-agent. Ids never restart while the process lives, so
	 * a disposed owner's `job-3` cannot collide with a new attachment's, and the
	 * cross-agent settler index can key on the id alone.
	 */
	private _nextJobId = 0;
	private _nextGeneration = 0;

	constructor(
		ports: BackgroundJobRuntimePorts,
		options: BackgroundJobRuntimeOptions = {},
	) {
		this._ports = ports;
		this._epoch = options.epoch ?? createEpochId();
		this._createJobId =
			options.createJobId ?? (() => `job-${++this._nextJobId}`);
		this._progressThrottleMs =
			options.progressThrottleMs ?? DEFAULT_BACKGROUND_JOB_PROGRESS_THROTTLE_MS;
		this._reportThrottleMs =
			options.reportThrottleMs ?? DEFAULT_BACKGROUND_JOB_REPORT_THROTTLE_MS;
		this._outputCeilingBytes =
			options.outputCeilingBytes ?? DEFAULT_BACKGROUND_JOB_OUTPUT_CEILING_BYTES;
		this._incrementMaxBytes =
			options.incrementMaxBytes ?? DEFAULT_BACKGROUND_JOB_INCREMENT_MAX_BYTES;
	}

	/** Id stamped on every journal record written by this process. */
	get epoch(): string {
		return this._epoch;
	}

	/**
	 * Bring an agent into scope and hand back the two capabilities bound to this
	 * attachment: what it may do to its own jobs, and what it may settle for
	 * others. Opening the owner journal is the only IO here; an owner with no
	 * session directory attaches as `ephemeral` and simply keeps no history.
	 *
	 * Called before the agent can run. A second attach of the same agent id is a
	 * new generation: it inherits nothing, and in particular does not become the
	 * settler of jobs the previous generation owed.
	 */
	async attachAgent(input: {
		agentId: string;
		sessionId: string;
	}): Promise<OwnerAttachment> {
		this.detachAgent(input.agentId);
		const state = this._createAttachment(input.agentId, input.sessionId);
		// Registered before the await: a tool that starts a job in the same tick
		// must find its scope, and a detach arriving during the open must be able
		// to invalidate it.
		this._attachments.set(input.agentId, state);
		try {
			const journal = await this._ports.openOwnerJournal({
				agentId: input.agentId,
				sessionId: input.sessionId,
			});
			// The attachment may have been detached, or replaced by a newer
			// generation, while the journal was opening. Either way this journal
			// belongs to nobody.
			if (this._attachments.get(input.agentId) !== state) {
				return state.attachment;
			}
			if (journal) {
				state.journal = journal;
				state.health = journal.corrupted ? "degraded" : "durable";
				state.degradedReported = journal.corrupted;
				if (journal.corrupted) {
					await this._diagnose({
						severity: "warning",
						code: "background.journal_corrupted",
						message: `The background job journal for agent ${input.agentId} has a malformed record, so its job history is incomplete.`,
						agentId: input.agentId,
					});
				}
			}
		} catch (error) {
			// A journal that cannot be opened degrades the history, not the agent:
			// jobs keep running, they just stop being recoverable across a restart.
			state.health = "degraded";
			state.degradedReported = true;
			await this._diagnose({
				severity: "warning",
				code: "background.journal_unavailable",
				message: `Cannot record background jobs for agent ${input.agentId}: ${formatError(error)}`,
				agentId: input.agentId,
			});
		}
		return state.attachment;
	}

	/**
	 * Take an agent out of scope and reconcile everything that depended on it.
	 * Invalidates the attachment synchronously, then forced-cancels the jobs it
	 * owned (firing their abort signals) and the external jobs it owed, so no job
	 * is left waiting on a settler that will never write it.
	 *
	 * A detached owner gets no events and no t1: a result cannot be read by an
	 * agent that is going away, and its observers are already released. History
	 * is still written, which is why the scope is dropped only once its tail has
	 * drained. Owners of jobs this agent merely owed are live, so those settle
	 * and deliver normally.
	 *
	 * Ordering is part of the contract: the host must call this after it has
	 * marked the agent as disposing and before any other teardown, so the whole
	 * "release the observers before aborting" sensitivity lives at this one call
	 * site instead of spread through a dispose sequence.
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
				this._forceCancel(
					record,
					`Settler agent ${agentId} was disposed before it reported a result.`,
				);
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

	/**
	 * Owner-scoped capability for `agentId`: start/create jobs, list, read,
	 * watch, abort. Identity is closed over, never taken from a model-controlled
	 * payload. Absent when the agent is not attached.
	 */
	hostFor(agentId: string): BackgroundJobHost | undefined {
		return this._current(agentId)?.attachment.host;
	}

	/**
	 * Settler-scoped capability for `agentId`: write the outcome of an external
	 * job owned by someone else. Absent when the agent is not attached.
	 */
	settlerFor(agentId: string): BackgroundJobSettler | undefined {
		return this._current(agentId)?.attachment.settler;
	}

	/**
	 * Observable jobs owned by `agentId`, oldest first. Candidates that were
	 * never accepted into the background are not jobs and never appear here.
	 */
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
	 * Current rolling output tail of one job, without blocking or disturbing it.
	 * Rejects rather than returning an empty read when the id is unknown or still
	 * a candidate, so a caller can tell "nothing yet" from "not a job".
	 */
	readJobOutput(
		agentId: string,
		jobId: string,
	): JobResult<{ read: BackgroundJobReadResult }> {
		const record = this._jobs.get(jobId);
		if (!record || record.ownerId !== agentId) {
			return { ok: false, reason: "unknown_job" };
		}
		if (!isObservable(record.state)) {
			return { ok: false, reason: "not_backgrounded" };
		}
		return {
			ok: true,
			read: { job: this._snapshot(record), output: record.output.read() },
		};
	}

	/**
	 * Request an abort. Synchronous and idempotent: it commits the
	 * `abort_requested` state and fires the signal, and the confirmation arrives
	 * later as the job's settlement. An external job has no executor watching the
	 * signal, so its abort forms the terminal `cancelled` directly.
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

	/**
	 * Number of live jobs an agent owns. Reported alongside agent state for
	 * consumers; it is not, and must not become, part of any judgement about
	 * whether the agent itself is busy.
	 */
	liveJobCount(agentId: string): number {
		return this.listJobs(agentId).length;
	}

	/**
	 * Every job this session has on record, including runs before this process.
	 * Replay is history and diagnostics only: it materializes no live job and
	 * resumes no work.
	 */
	history(agentId: string): readonly PersistedBackgroundJob[] {
		return this._current(agentId)?.journal?.history() ?? [];
	}

	/**
	 * Jobs this session recorded under an earlier epoch: exactly the t0 handles
	 * whose owning runtime no longer exists. Whether each still owes the model a
	 * message is not decided here - the session history is the authority on what
	 * the model was actually told - so this is the input to the host's resume
	 * reconciliation and nothing more. It materializes no live job.
	 */
	carriedOverJobs(agentId: string): readonly PersistedBackgroundJob[] {
		return this._current(agentId)?.journal?.carriedOverJobs() ?? [];
	}

	/**
	 * Settle a job from outside its owner, naming the settler explicitly. The
	 * authorization is the one {@link settlerFor} enforces, so this is a
	 * forwarding seam for hosts that hold an id rather than a capability, not a
	 * second policy.
	 */
	settleJob(
		agentId: string,
		jobId: string,
		outcome: BackgroundJobOutcome,
		settledBy: string,
	): JobResult {
		const settler = this._current(settledBy);
		if (!settler) return { ok: false, reason: "stale_attachment" };
		return this._settleExternal(
			settler.agentId,
			settler.generation,
			agentId,
			jobId,
			outcome,
		);
	}

	// -- attachment ---------------------------------------------------------

	/** The agent's live scope, or nothing once it has been detached. */
	private _current(agentId: string): AttachmentState | undefined {
		const state = this._attachments.get(agentId);
		return state && !state.detached ? state : undefined;
	}

	/**
	 * Resolve a capability's scope. Both facts have to match: the agent is still
	 * attached, and this handle belongs to the attachment that is current rather
	 * than to a previous generation of the same id.
	 */
	private _resolve(
		agentId: string,
		generation: number,
	): AttachmentState | undefined {
		const state = this._current(agentId);
		return state?.generation === generation ? state : undefined;
	}

	private _createAttachment(
		agentId: string,
		sessionId: string,
	): AttachmentState {
		const generation = ++this._nextGeneration;
		// The capabilities resolve their scope by (agentId, generation) on every
		// call rather than closing over the state object. That is what makes the
		// generation guard a single expression instead of a check repeated in each
		// method - and it keeps this construction free of a placeholder cycle.
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
			createExternal: (input) =>
				this._createExternal(agentId, generation, input),
			list: () =>
				this._resolve(agentId, generation) ? this.listJobs(agentId) : [],
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

	private _createSettler(
		agentId: string,
		generation: number,
	): BackgroundJobSettler {
		return {
			settle: (input) =>
				this._settleExternal(
					agentId,
					generation,
					input.ownerAgentId,
					input.jobId,
					input.outcome,
				),
		};
	}

	/**
	 * Capture a snapshot and start buffering in one step, so a caller can list
	 * and subscribe without a gap. Changes between here and `start` are held and
	 * replayed in order; nothing is dropped and nothing arrives twice.
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

	private _startLocal(
		state: AttachmentState,
		input: StartLocalJobInput,
	): BackgroundJobExecution {
		const record = this._createRecord(state, input, LOCAL_ORIGIN);
		return {
			jobId: record.id,
			signal: record.controller.signal,
			output: record.output,
			setReport: (report) => this._setReport(record, report),
			acceptBackground: () => this._acceptBackground(record),
			settle: (outcome) => {
				const disposition = this._settle(record, outcome);
				return disposition === "ignored"
					? { ok: false, reason: "unknown_job" }
					: { ok: true, disposition };
			},
		};
	}

	/**
	 * Create a job another agent will settle, and return only once it has a
	 * durable head. The assignment must not go out before the record exists: an
	 * assignment whose job left no trace is how a task ends up owed by nobody.
	 *
	 * The settler attachment is validated twice - before the append and after -
	 * because the await in between is exactly where a settler can be disposed.
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
			this._forceCancel(
				record,
				`Settler agent ${input.settlerAgentId} was disposed before the assignment was sent.`,
			);
			return { ok: false, reason: "stale_attachment" };
		}
		return committed;
	}

	private _createRecord(
		state: AttachmentState,
		input: StartLocalJobInput,
		origin: BackgroundJobOrigin,
		settlerGeneration?: number,
	): JobRecord {
		const id = this._createJobId();
		const startedAt = Date.now();
		const controller = new AbortController();
		const output = new BackgroundJobOutput(
			DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES,
			{
				incrementMaxBytes: this._incrementMaxBytes,
				onAppend: () => this._onOutputAppend(id),
			},
		);
		const initialReport =
			input.report === undefined
				? undefined
				: freezeReportSnapshot(
						validateBackgroundJobReport(input.report),
						1,
						startedAt,
					);
		const record: JobRecord = {
			id,
			ownerId: state.agentId,
			ownerGeneration: state.generation,
			// Detached and frozen: the origin is the settlement authority, and a
			// caller that kept its input object must not be able to name a
			// different settler afterwards.
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
	 * Take a local candidate into the background: the deadline won and the caller
	 * is about to return a t0 handle.
	 *
	 * Synchronous, so registration completes before the caller's first await. The
	 * head record is enqueued rather than awaited, which is the one place this
	 * runtime does not yet meet its own persistence contract: putting a durable
	 * head ahead of t0 is a deliberate later change, and it changes this
	 * signature.
	 */
	private _acceptBackground(
		record: JobRecord,
	): JobResult<{ job: BackgroundJobSnapshot }> {
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
			await this._write(state, this._headRecord(state, record));
			await this._publishChange(state, { transition: "backgrounded", job });
		});
		// Output may have accumulated during the pre-t0 synchronous window. Make it
		// observable only after the backgrounded event, preserving the rule that
		// nobody sees a job before its handle exists.
		if (record.output.totalBytesSeen > 0) this._scheduleProgress(record);
		return { ok: true, job };
	}

	/**
	 * Commit an external job's background state behind a durable head. Unlike the
	 * local path this awaits the append, because nothing has been returned to a
	 * model yet: a failure here means the job never existed.
	 */
	private async _commitBackgrounded(
		state: AttachmentState,
		record: JobRecord,
	): Promise<JobResult<{ job: BackgroundJobSnapshot }>> {
		record.state = "backgrounded";
		record.backgroundedAt = Date.now();
		record.lastReportAt = record.backgroundedAt;
		const job = this._snapshot(record);
		const head = this._headRecord(state, record);
		try {
			await this._enqueue(state, () => this._append(state, head));
		} catch (error) {
			record.state = "cancelled";
			this._discard(record);
			await this._degrade(state, error);
			return { ok: false, reason: "degraded" };
		}
		void this._enqueue(state, () =>
			this._publishChange(state, { transition: "backgrounded", job }),
		);
		return { ok: true, job };
	}

	// -- abort and settlement ----------------------------------------------

	/**
	 * Accept an abort request. The state commits synchronously and the signal
	 * fires immediately, so a tool watching it can stop; the journal record and
	 * the event go on the owner's tail, which is what keeps `abort_requested`
	 * ahead of the `settled` a synchronous signal handler can produce.
	 */
	private _requestAbort(record: JobRecord, reason?: string): void {
		if (isTerminal(record.state)) return;
		record.stopReason ??= reason;
		const state = this._attachments.get(record.ownerId);
		const announce =
			record.state === "backgrounded" && !record.controller.signal.aborted;
		if (announce) {
			record.state = "abort_requested";
			if (state) {
				const job = this._snapshot(record);
				const at = Date.now();
				const stopReason = record.stopReason;
				void this._enqueue(state, async () => {
					await this._write(state, {
						type: "job_abort_requested",
						schemaVersion: BACKGROUND_JOB_JOURNAL_SCHEMA_VERSION,
						epoch: this._epoch,
						jobId: record.id,
						at,
						...(stopReason === undefined ? undefined : { stopReason }),
					});
					await this._publishChange(state, {
						transition: "abort_requested",
						job,
					});
				});
			}
		}
		record.controller.abort();
		// An external job has no executor watching the signal, so nothing would
		// ever confirm the abort. Complete the transition here rather than leaving
		// the job stuck in `abort_requested` forever.
		if (record.origin.kind === "external" && !isTerminal(record.state)) {
			this._settle(record, { status: "cancelled" });
		}
	}

	/** Abort and settle in one step, for a scope that is going away. */
	private _forceCancel(record: JobRecord, reason: string): void {
		if (isTerminal(record.state)) return;
		record.stopReason ??= reason;
		record.controller.abort();
		this._settle(record, { status: "cancelled" });
	}

	/**
	 * Commit a job's terminal outcome, at most once, then run the settlement tail:
	 * final report, final progress, terminal record, terminal event, t1 request -
	 * in that order, which is why `settled` is a barrier rather than just another
	 * event.
	 *
	 * `inline` means the job never became observable: it settled inside the
	 * pre-t0 window, so there is nothing to record, nothing to emit, and no t1 -
	 * the caller returns the outcome as an ordinary tool result.
	 */
	private _settle(
		record: JobRecord,
		outcome: BackgroundJobOutcome,
	): "inline" | "backgrounded" | "ignored" {
		if (isTerminal(record.state)) return "ignored";
		const observable = isObservable(record.state);
		record.endedAt = Date.now();
		record.stopReason ??= stopReasonFromOutcome(outcome);
		record.state = outcome.status;
		this._clearTimers(record);
		this._discard(record);
		if (!observable) return "inline";
		// The scope is looked up including a detached one: it holds the journal, so
		// history still lands even though nothing will be published or delivered.
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
				type: "job_settled",
				schemaVersion: BACKGROUND_JOB_JOURNAL_SCHEMA_VERSION,
				epoch: this._epoch,
				jobId: record.id,
				status: outcome.status,
				...(stopReason === undefined ? undefined : { stopReason }),
				endedAt,
				messageText,
				...(outputTail.length === 0 ? undefined : { outputTail }),
			});
			await this._publishChange(state, {
				transition: "settled",
				job,
				outcome,
			});
			if (state.detached) return;
			try {
				await this._ports.deliverResult({
					ownerAgentId: record.ownerId,
					jobId: record.id,
					body: messageText,
				});
			} catch (error) {
				// The port owns delivery policy, including its retries. Reaching here
				// means the owner can never take this result, and the tail has to
				// survive saying so.
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
		if (
			record.origin.kind !== "external" ||
			record.origin.settlerId !== settlerId
		) {
			return { ok: false, reason: "not_settler" };
		}
		// Matching the id is not enough: a re-attached agent carries the same id as
		// the one this job was assigned to, and must not inherit its authority.
		if (record.settlerGeneration !== settlerGeneration) {
			return { ok: false, reason: "stale_attachment" };
		}
		if (!isObservable(record.state)) {
			return { ok: false, reason: "not_backgrounded" };
		}
		return this._settle(record, outcome) === "ignored"
			? { ok: false, reason: "unknown_job" }
			: { ok: true };
	}

	/** Drop a job from the live indexes. Its record stays readable to the tail. */
	private _discard(record: JobRecord): void {
		this._jobs.delete(record.id);
		this._attachments.get(record.ownerId)?.owned.delete(record.id);
		if (record.origin.kind === "external") {
			this._attachments.get(record.origin.settlerId)?.owed.delete(record.id);
		}
	}

	// -- report -------------------------------------------------------------

	private _setReport(
		record: JobRecord,
		report: BackgroundJobReport,
	): JobResult {
		if (isTerminal(record.state)) {
			return { ok: false, reason: "unknown_job" };
		}
		// An invalid report is a bug in the calling tool, not a lifecycle outcome,
		// so it throws where that tool can see it instead of degrading into a
		// refusal the tool would have to interpret.
		const value = validateBackgroundJobReport(report);
		record.reportRevision += 1;
		record.report = freezeReportSnapshot(
			value,
			record.reportRevision,
			Date.now(),
		);
		if (isObservable(record.state)) {
			record.reportDirty = true;
			this._scheduleReport(record);
		}
		return { ok: true };
	}

	/**
	 * Emit the latest report value, at most once per throttle window. A burst
	 * collapses into one emission carrying the newest revision: the report is a
	 * latest-value register, so intermediate revisions cost writes and tell
	 * nobody anything new.
	 */
	private _scheduleReport(record: JobRecord): void {
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

	private _queueReport(record: JobRecord): void {
		const state = this._attachments.get(record.ownerId);
		if (!state || record.reportQueued) return;
		record.reportQueued = true;
		void this._enqueue(state, async () => {
			record.reportQueued = false;
			await this._flushReport(state, record);
		});
	}

	private async _flushReport(
		state: AttachmentState,
		record: JobRecord,
	): Promise<void> {
		const report = record.report;
		if (!record.reportDirty || report === undefined) return;
		record.reportDirty = false;
		record.lastReportAt = Date.now();
		await this._write(state, {
			type: "job_reported",
			schemaVersion: BACKGROUND_JOB_JOURNAL_SCHEMA_VERSION,
			epoch: this._epoch,
			jobId: record.id,
			report,
		});
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
	 * Handle an output append: trip the cooperative streaming circuit breaker when
	 * the total crosses the ceiling, then schedule a throttled progress emission -
	 * but only once t0 has made the job observable.
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

	private _scheduleProgress(record: JobRecord): void {
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
	 * Queue one coalesced drain per job. While it is queued further ticks are
	 * no-ops: their bytes accumulate in the increment buffer and go out together,
	 * so a producer faster than the emit pump cannot grow the queue.
	 */
	private _queueProgress(record: JobRecord): void {
		const state = this._attachments.get(record.ownerId);
		if (!state || record.progressQueued) return;
		record.progressQueued = true;
		void this._enqueue(state, async () => {
			record.progressQueued = false;
			await this._flushProgress(state, record);
		});
	}

	private async _flushProgress(
		state: AttachmentState,
		record: JobRecord,
	): Promise<void> {
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

	private _clearTimers(record: JobRecord): void {
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
	 * Chain a side effect onto the owner's tail. The returned promise reflects
	 * this task, so a caller that must know the outcome can await it; the chain
	 * itself absorbs the failure, because one failed effect must not stall every
	 * later one.
	 */
	private _enqueue(
		state: AttachmentState,
		task: () => Promise<void>,
	): Promise<void> {
		const result = state.tail.then(task);
		state.tail = result.catch(() => {});
		return result;
	}

	private _headRecord(
		state: AttachmentState,
		record: JobRecord,
	): BackgroundJobJournalRecord {
		return {
			type: "job_backgrounded",
			schemaVersion: BACKGROUND_JOB_JOURNAL_SCHEMA_VERSION,
			epoch: this._epoch,
			jobId: record.id,
			ownerAgentId: record.ownerId,
			sessionId: state.sessionId,
			toolCallId: record.toolCallId,
			toolName: record.toolName,
			...(record.name === undefined ? undefined : { name: record.name }),
			...(record.description === undefined
				? undefined
				: { description: record.description }),
			origin: record.origin,
			startedAt: record.startedAt,
			backgroundedAt: record.backgroundedAt ?? record.startedAt,
		};
	}

	/** Append, or throw. Used where a failure must change what the caller does. */
	private async _append(
		state: AttachmentState,
		record: BackgroundJobJournalRecord,
	): Promise<void> {
		if (!state.journal) return;
		await state.journal.append(record);
	}

	/**
	 * Append after t0, where liveness outweighs the journal: a job the model was
	 * already told about cannot be un-backgrounded because a write failed, so the
	 * owner degrades and the lifecycle continues.
	 */
	private async _write(
		state: AttachmentState,
		record: BackgroundJobJournalRecord,
	): Promise<void> {
		try {
			await this._append(state, record);
		} catch (error) {
			await this._degrade(state, error);
		}
	}

	private async _degrade(
		state: AttachmentState,
		error: unknown,
	): Promise<void> {
		state.health = "degraded";
		if (state.degradedReported) return;
		state.degradedReported = true;
		await this._diagnose({
			severity: "warning",
			code: "background.journal_write_failed",
			message: `Background jobs for agent ${state.agentId} are no longer being recorded; results of jobs still running will not survive a restart: ${formatError(error)}`,
			agentId: state.agentId,
		});
	}

	private async _publishChange(
		state: AttachmentState,
		change: BackgroundJobChange,
	): Promise<void> {
		if (state.detached) return;
		// Local watchers first, and synchronously: a waiting tool is part of this
		// process and must not learn of a settlement later than a surface does.
		for (const watcher of state.watchers) {
			try {
				watcher(change);
			} catch {
				// One watcher's failure is its own; it cannot drop the others or the
				// event that follows.
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
			// Publishing is the host's problem once it has the event; a consumer that
			// throws cannot be allowed to break this owner's ordering.
		}
	}

	private async _diagnose(
		diagnostic: Parameters<BackgroundJobRuntimePorts["diagnose"]>[0],
	): Promise<void> {
		try {
			await this._ports.diagnose(diagnostic);
		} catch {
			// A diagnostic that cannot be reported is not worth failing a job for.
		}
	}

	// -- snapshots ----------------------------------------------------------

	private _snapshot(record: JobRecord): BackgroundJobSnapshot {
		return {
			jobId: record.id,
			ownerAgentId: record.ownerId,
			origin: record.origin,
			toolCallId: record.toolCallId,
			toolName: record.toolName,
			...(record.name === undefined ? undefined : { name: record.name }),
			...(record.description === undefined
				? undefined
				: { description: record.description }),
			...(record.report === undefined ? undefined : { report: record.report }),
			state: record.state as ObservableBackgroundJobState,
			...(record.stopReason === undefined
				? undefined
				: { stopReason: record.stopReason }),
			startedAt: record.startedAt,
			backgroundedAt: record.backgroundedAt ?? record.startedAt,
			...(record.endedAt === undefined
				? undefined
				: { endedAt: record.endedAt }),
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

function createEpochId(): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
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
 * Validate, detach, and deeply freeze a tool-published report. JSON
 * round-tripping gives snapshots transport-safe value semantics: later mutation
 * of the tool's input object cannot change the job without a new revision.
 */
function validateBackgroundJobReport(
	report: BackgroundJobReport,
): BackgroundJobReport {
	if (typeof report !== "object" || report === null) {
		throw new TypeError("Background job report must be an object.");
	}
	assertBoundedReportText(
		report.kind,
		"Background job report kind",
		MAX_BACKGROUND_JOB_REPORT_KIND_BYTES,
	);
	if (!Number.isInteger(report.schemaVersion) || report.schemaVersion < 1) {
		throw new TypeError(
			"Background job report schemaVersion must be a positive integer.",
		);
	}
	if (report.summary !== undefined) {
		assertBoundedReportText(
			report.summary,
			"Background job report summary",
			MAX_BACKGROUND_JOB_REPORT_SUMMARY_BYTES,
		);
	}
	const progress = report.progress;
	if (progress !== undefined) {
		if (typeof progress !== "object" || progress === null) {
			throw new TypeError("Background job report progress must be an object.");
		}
		assertNonNegativeReportInteger(
			progress.completed,
			"Background job report progress completed",
		);
		if (progress.total !== undefined) {
			assertNonNegativeReportInteger(
				progress.total,
				"Background job report progress total",
			);
			if (progress.completed > progress.total) {
				throw new RangeError(
					"Background job report progress completed cannot exceed total.",
				);
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
						...(progress.total === undefined
							? undefined
							: { total: progress.total }),
					},
				}),
		...(report.data === undefined ? undefined : { data: report.data }),
	};
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(normalized);
	} catch (error) {
		const message = error instanceof Error ? `: ${error.message}` : "";
		throw new TypeError(
			`Background job report must be JSON serializable${message}.`,
		);
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

function assertBoundedReportText(
	value: string,
	label: string,
	maxBytes: number,
): void {
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
