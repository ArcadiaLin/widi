import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";

/**
 * Pseudo-async tool results.
 *
 * A backgroundable tool call settles immediately with a job handle (t0), then
 * the eventual outcome is delivered as a separate message injected later (t1).
 * The LLM protocol forbids a deferred tool_result, so t1 is injected as a
 * normal user message via `harness.prompt()` at the agent's next idle boundary
 * (the orchestrator buffers and routes settlements; pi's harness has no entry
 * point for injecting a custom message and driving a run from it).
 *
 * This module owns the message/result shapes and their identities (t0 handle,
 * t1 message text) plus the `BackgroundJobTable` that tracks live jobs and
 * publishes their lifecycle changes. The timeout race lives in the tool
 * adapter; the t1 router lives in the orchestrator.
 */

/** Terminal outcome of a background job. */
export type BackgroundJobStatus = "completed" | "failed" | "cancelled";

/** Default rolling cap for a background job's output buffer: 256 KiB. */
export const DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES = 256 * 1024;

/**
 * Bounded rolling tail of a background job's output.
 *
 * A backgrounded tool feeds its output straight in via {@link append}; read_job
 * pulls the current tail via {@link read}. Bytes accumulate in a chunk queue
 * capped at a byte budget: once appending exceeds the cap, data is dropped from
 * the head — whole chunks first, then a partial slice of the boundary chunk —
 * until the total is back within budget.
 *
 * Deliberately simple: no line counting, no truncation metadata, no disk. The
 * head drop can slice the first UTF-8 character mid-sequence; that is acceptable
 * for a progress peek, and decoding emits a replacement character rather than
 * throwing.
 */
export class BackgroundJobOutput {
	private readonly _chunks: Buffer[] = [];
	private _byteLength = 0;
	private readonly _maxBytes: number;

	constructor(maxBytes: number = DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES) {
		this._maxBytes = maxBytes;
	}

	/** Append a chunk of output, trimming from the head to stay within the cap. */
	append(chunk: Buffer | string): void {
		const buffer =
			typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
		if (buffer.length === 0) return;
		this._chunks.push(buffer);
		this._byteLength += buffer.length;
		this._trim();
	}

	/** Current tail decoded as UTF-8. */
	read(): string {
		return Buffer.concat(this._chunks, this._byteLength).toString("utf-8");
	}

	private _trim(): void {
		while (this._byteLength > this._maxBytes) {
			const head = this._chunks[0];
			if (this._byteLength - head.length >= this._maxBytes) {
				this._chunks.shift();
				this._byteLength -= head.length;
				continue;
			}
			// Dropping the whole head would fall under the cap; keep just its tail so
			// the buffer holds exactly the last _maxBytes bytes. Copy instead of
			// subarray: a view would pin the full parent allocation of an oversized
			// chunk for as long as it stays at the head of a quiet job.
			const overflow = this._byteLength - this._maxBytes;
			this._chunks[0] = Buffer.from(head.subarray(overflow));
			this._byteLength -= overflow;
			break;
		}
	}
}

/**
 * Structured details attached to the immediate t0 tool result of a backgrounded
 * call. `backgrounded: true` marks the result as a job handle rather than the
 * tool's real output.
 */
export interface BackgroundJobStartedDetails {
	readonly jobId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly backgrounded: true;
}

/**
 * Build the immediate t0 tool result for a call that was moved to the
 * background. The text tells the model the handle-first result is not the real
 * output and that the outcome will arrive later as a separate message, so it
 * must not block on it.
 */
export function createBackgroundJobStartedResult(input: {
	jobId: string;
	toolCallId: string;
	toolName: string;
}): AgentToolResult<BackgroundJobStartedDetails> {
	const details: BackgroundJobStartedDetails = {
		jobId: input.jobId,
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		backgrounded: true,
	};
	const text =
		`Tool call ${input.toolCallId} (${input.toolName}) is still running and has ` +
		`moved to the background as job ${input.jobId}. It keeps running; its result ` +
		`will arrive later as a separate background job result message that references ` +
		`job ${input.jobId}. Do not block waiting on it: continue with other work and ` +
		`react to that later message when it arrives. Use read_job to inspect its ` +
		`live output, wait_for_jobs to block until it settles, or kill_job to ` +
		`terminate it.`;
	return { content: [{ type: "text", text }], details };
}

function formatBackgroundJobResultText(input: {
	jobId: string;
	toolCallId: string;
	toolName: string;
	status: BackgroundJobStatus;
	resultText: string;
}): string {
	const header = `Background job ${input.jobId} (started by tool call ${input.toolCallId}, tool ${input.toolName}) ${input.status}:`;
	const body = input.resultText.trim();
	return body ? `${header}\n\n${body}` : header;
}

/**
 * Model-facing text for a settled background job, ready to inject as a user
 * message (t1). Reuses the self-describing header and derives the body from the
 * outcome: the tool's text content when it resolved, otherwise the error or a
 * short cancellation note.
 */
export function formatBackgroundJobResultMessageText(
	settlement: BackgroundJobSettlement,
): string {
	return formatBackgroundJobResultText({
		jobId: settlement.job.id,
		toolCallId: settlement.job.toolCallId,
		toolName: settlement.job.toolName,
		status: settlement.outcome.status,
		resultText: extractBackgroundJobOutcomeText(settlement.outcome),
	});
}

function extractBackgroundJobOutcomeText(
	outcome: BackgroundJobOutcome,
): string {
	if (outcome.result) {
		return outcome.result.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("");
	}
	if (outcome.status === "cancelled" && outcome.error === undefined) {
		return "The job was cancelled before it produced a result.";
	}
	if (outcome.error !== undefined) return errorToText(outcome.error);
	return "";
}

function errorToText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Lifecycle phase of a live background job before it settles. */
export type BackgroundJobPhase = "running" | "backgrounded";

/** Public, read-only view of a background job. */
export interface BackgroundJob {
	/** Runtime-local job handle returned to the model at t0. */
	readonly id: string;
	/** Id of the tool call that started the job. */
	readonly toolCallId: string;
	/** Name of the tool that started the job. */
	readonly toolName: string;
	/** Abort signal handed to the tool's execute; abort via `BackgroundJobTable.abort`. */
	readonly signal: AbortSignal;
	/** Current lifecycle phase. */
	readonly phase: BackgroundJobPhase;
	/**
	 * Live rolling tail of the job's output. A backgrounded tool appends its
	 * output stream here; read_job pulls the current tail. Its lifetime is the
	 * job's: it is garbage-collected with the record when the job settles.
	 */
	readonly output: BackgroundJobOutput;
}

/** Terminal outcome recorded when a job's underlying promise settles. */
export interface BackgroundJobOutcome {
	readonly status: BackgroundJobStatus;
	/** Present when the tool resolved. */
	readonly result?: AgentToolResult<unknown>;
	/** Present when the tool rejected. */
	readonly error?: unknown;
}

/** Settlement of a backgrounded job: the payload of a `settled` change. */
export interface BackgroundJobSettlement {
	readonly job: BackgroundJob;
	readonly outcome: BackgroundJobOutcome;
}

/**
 * Lifecycle change of a job in its observable world, which starts at t0: a job
 * that settles inline (before its deadline) never produces a change, because
 * neither the model nor any surface ever saw its handle.
 *
 * - `backgrounded`: the deadline won; the tool call settled with a t0 handle.
 * - `aborting`: an abort was requested for a backgrounded job (`abort()`);
 *   emitted once, before the job's signal fires. The confirmation arrives as
 *   its `settled` change.
 * - `settled`: the job reached a terminal outcome. Fires the t1 routing.
 */
export type BackgroundJobChange =
	| { readonly transition: "backgrounded"; readonly job: BackgroundJob }
	| { readonly transition: "aborting"; readonly job: BackgroundJob }
	| ({ readonly transition: "settled" } & BackgroundJobSettlement);

/** Phase or abort-request state a change reports. */
export type BackgroundJobTransition = BackgroundJobChange["transition"];

/** Listener invoked on every observable job lifecycle change. */
export type BackgroundJobChangeListener = (change: BackgroundJobChange) => void;

/**
 * Immutable, serializable view of a job at the moment of a change. Carried on
 * orchestrator events and query results instead of the live `BackgroundJob`
 * view, which holds a signal and a live output buffer.
 */
export interface BackgroundJobSnapshot {
	/** Runtime-local job handle returned to the model at t0. */
	readonly jobId: string;
	/** Id of the tool call that started the job. */
	readonly toolCallId: string;
	/** Name of the tool that started the job. */
	readonly toolName: string;
	/** Lifecycle phase at snapshot time. */
	readonly phase: BackgroundJobPhase;
	/** Terminal outcome, present once the job settled. */
	readonly status?: BackgroundJobStatus;
}

export function snapshotBackgroundJob(
	job: BackgroundJob,
	status?: BackgroundJobStatus,
): BackgroundJobSnapshot {
	return {
		jobId: job.id,
		toolCallId: job.toolCallId,
		toolName: job.toolName,
		phase: job.phase,
		status,
	};
}

/**
 * Result of {@link BackgroundJobTable.settle}.
 * - `backgrounded`: the job had been moved to the background; a `settled`
 *   change fired.
 * - `inline`: the job settled before the deadline; the adapter returns the
 *   result inline and no change fires.
 * - `ignored`: the job was already settled or unknown.
 */
export type BackgroundJobSettleResult = "backgrounded" | "inline" | "ignored";

interface JobRecord {
	readonly controller: AbortController;
	phase: BackgroundJobPhase;
	settled: boolean;
	readonly view: BackgroundJob;
}

export interface BackgroundJobTableOptions {
	/** Injectable id factory. Defaults to a monotonic `job-N` counter. */
	readonly createId?: () => string;
}

/**
 * Tracks live pseudo-async background jobs.
 *
 * A `backgroundable` tool call races a deadline in the tool adapter. If the
 * deadline wins, the call is moved to the background: the adapter settles the
 * tool call immediately with a job handle (t0), and the still-running promise
 * keeps going. When it finally settles, the table notifies result listeners so
 * a router (later stage) can inject the outcome as a separate message (t1).
 *
 * The table owns each job's `AbortController`, so a job's lifetime is decoupled
 * from the tool call that started it: once t0 returns, the original tool_use is
 * closed and its run signal no longer governs the background work.
 *
 * The table is the single source of truth for job state: every mutation goes
 * through `create`/`background`/`settle`/`abort`, and every observable mutation
 * (from t0 onward) emits exactly one {@link BackgroundJobChange} on the single
 * `onChange` channel.
 */
export class BackgroundJobTable {
	private readonly _jobs = new Map<string, JobRecord>();
	private readonly _changeListeners = new Set<BackgroundJobChangeListener>();
	private readonly _createId: () => string;
	private _counter = 0;

	constructor(options: BackgroundJobTableOptions = {}) {
		this._createId = options.createId ?? (() => `job-${++this._counter}`);
	}

	/** Register a new job in the `running` phase and return its public view. */
	create(input: { toolCallId: string; toolName: string }): BackgroundJob {
		const id = this._createId();
		const controller = new AbortController();
		const record: JobRecord = {
			controller,
			phase: "running",
			settled: false,
			view: {
				id,
				toolCallId: input.toolCallId,
				toolName: input.toolName,
				signal: controller.signal,
				output: new BackgroundJobOutput(),
				get phase() {
					return record.phase;
				},
			},
		};
		this._jobs.set(id, record);
		return record.view;
	}

	/** Look up a live job by id. */
	get(id: string): BackgroundJob | undefined {
		return this._jobs.get(id)?.view;
	}

	/** List all live jobs (running or backgrounded). */
	list(): BackgroundJob[] {
		return Array.from(this._jobs.values(), (record) => record.view);
	}

	/**
	 * Move a running job to the background (the deadline won the race).
	 * Returns false when the job already settled inline, so the adapter knows to
	 * fall back to returning the inline result.
	 */
	background(id: string): boolean {
		const record = this._jobs.get(id);
		if (!record || record.settled) return false;
		record.phase = "backgrounded";
		this._emitChange({ transition: "backgrounded", job: record.view });
		return true;
	}

	/**
	 * Record a job's terminal outcome. Emits a `settled` change only when the job
	 * had been backgrounded; a job that settled while still `running` returns
	 * `inline` and is delivered by the adapter's inline return instead.
	 */
	settle(id: string, outcome: BackgroundJobOutcome): BackgroundJobSettleResult {
		const record = this._jobs.get(id);
		if (!record || record.settled) return "ignored";
		record.settled = true;
		this._jobs.delete(id);
		if (record.phase !== "backgrounded") return "inline";
		this._emitChange({ transition: "settled", job: record.view, outcome });
		return "backgrounded";
	}

	/**
	 * Abort a live job. The tool's execute observes the abort via its signal. For
	 * a backgrounded job the first abort emits an `aborting` change before the
	 * signal fires, so it always precedes the resulting `settled`; repeated
	 * aborts are silent. A `running`-phase abort (the pre-t0 sync window) emits
	 * nothing: the job is not observable yet and settles inline.
	 */
	abort(id: string): void {
		const record = this._jobs.get(id);
		if (!record) return;
		if (record.phase === "backgrounded" && !record.controller.signal.aborted) {
			this._emitChange({ transition: "aborting", job: record.view });
		}
		record.controller.abort();
	}

	/** Subscribe to observable job lifecycle changes. Returns an unsubscribe. */
	onChange(listener: BackgroundJobChangeListener): () => void {
		this._changeListeners.add(listener);
		return () => this._changeListeners.delete(listener);
	}

	private _emitChange(change: BackgroundJobChange): void {
		for (const listener of this._changeListeners) {
			try {
				listener(change);
			} catch {
				// Listener failures are the consumer's responsibility, not the
				// table's; isolate them so one bad listener cannot drop the others.
			}
		}
	}
}
