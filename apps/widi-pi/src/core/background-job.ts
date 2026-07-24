import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";

/**
 * Pseudo-async tool results.
 *
 * A backgroundable tool call settles immediately with a job handle (t0), then
 * the eventual outcome is delivered as a separate message injected later (t1).
 * The LLM protocol forbids a deferred tool_result, so t1 is injected as a
 * normal user message via `harness.steer()` into the agent's active run when it
 * is still running, or `harness.prompt()` at the next idle boundary otherwise
 * (the orchestrator buffers and routes settlements).
 *
 * This module owns the message/result shapes and their identities (t0 handle,
 * t1 message text) plus the `BackgroundJobTable` that tracks live jobs, streams
 * their output as bounded increments, and publishes their lifecycle changes.
 * The timeout race lives in the tool adapter; the t1 router and the progress
 * pump live in the orchestrator.
 */

/** Terminal outcome of a background job. */
export type BackgroundJobStatus = "completed" | "failed" | "cancelled";

/** Default rolling cap for a background job's output tail: 1 MiB. */
export const DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES = 1024 * 1024;

/**
 * Default cap on the unforwarded progress-increment buffer: 1 MiB. Bounds the
 * bytes held between two progress drains so a producer that outpaces the emit
 * pump cannot grow memory without limit; overflow drops from the head and is
 * counted as `progressDroppedBytes`, leaving a detectable gap in the byte
 * stream.
 */
export const DEFAULT_BACKGROUND_JOB_INCREMENT_MAX_BYTES = 1024 * 1024;

/**
 * Default cooperative circuit-breaker ceiling on the total output a single
 * background job streams through `context.job.output`: 16 MiB. Since the
 * rolling tail and increment buffer are both bounded, memory is already safe;
 * this ceiling instead requests termination of a runaway producer (for example
 * a command stuck streaming forever) that would otherwise burn CPU
 * indefinitely. It cannot limit output a tool does not append here, nor the
 * size of the tool's eventual result.
 */
export const DEFAULT_BACKGROUND_JOB_OUTPUT_CEILING_BYTES = 16 * 1024 * 1024;

/** Default minimum spacing between a job's progress emissions: 100 ms. */
export const DEFAULT_BACKGROUND_JOB_PROGRESS_THROTTLE_MS = 100;

/**
 * A drained progress increment: the contiguous run of new output bytes since
 * the previous drain, addressed by absolute byte offsets into the job's total
 * output stream. When the increment buffer overflowed and dropped from the head
 * between drains, `startByte` jumps past the previous `endByte`; the gap size is
 * reflected in the monotonically growing `progressDroppedBytes`.
 */
export interface BackgroundJobOutputIncrement {
	/**
	 * Retained output bytes for this increment, encoded as Base64. Decoding this
	 * value yields exactly `endByte - startByte` bytes; consumers must not treat
	 * each increment as an independently decodable UTF-8 string because a
	 * character may span two increments.
	 */
	readonly chunk: string;
	/** Absolute offset of the first byte in `chunk`. */
	readonly startByte: number;
	/** Absolute offset just past the last byte in `chunk` (equals totalBytesSeen). */
	readonly endByte: number;
	/** Total bytes ever appended to the job at drain time. */
	readonly totalBytesSeen: number;
	/** Cumulative bytes dropped from the increment buffer and never forwarded. */
	readonly progressDroppedBytes: number;
}

/**
 * Bounded rolling tail plus a bounded forward increment of a background job's
 * output.
 *
 * A backgrounded tool feeds its output straight in via {@link append}. Two
 * independent windows are maintained over that one stream:
 *
 * - the rolling tail ({@link read}) is the last `maxBytes` bytes, a point-in-time
 *   peek for read_job; older bytes are dropped from the head to stay in budget.
 * - the increment buffer ({@link drainIncrement}) is the run of bytes not yet
 *   forwarded to progress listeners; it is drained (and cleared) on each emit,
 *   and capped separately so a fast producer between drains cannot grow memory
 *   without bound.
 *
 * The rolling tail can slice a UTF-8 character mid-sequence at a head drop; that
 * is acceptable for a progress peek, and decoding emits a replacement character
 * rather than throwing. Progress increments remain byte-exact because they are
 * returned as Base64 rather than decoded independently.
 */
export class BackgroundJobOutput {
	private readonly _chunks: Buffer[] = [];
	private _byteLength = 0;
	private readonly _maxBytes: number;

	private readonly _incChunks: Buffer[] = [];
	private _incByteLength = 0;
	private _incStartOffset = 0;
	private readonly _incMaxBytes: number;

	private _totalBytesSeen = 0;
	private _progressDroppedBytes = 0;
	private readonly _onAppend?: () => void;

	constructor(
		maxBytes: number = DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES,
		options: {
			onAppend?: () => void;
			incrementMaxBytes?: number;
		} = {},
	) {
		this._maxBytes = maxBytes;
		this._incMaxBytes =
			options.incrementMaxBytes ?? DEFAULT_BACKGROUND_JOB_INCREMENT_MAX_BYTES;
		this._onAppend = options.onAppend;
	}

	/** Total bytes ever appended, including bytes since dropped from either window. */
	get totalBytesSeen(): number {
		return this._totalBytesSeen;
	}

	/** Total bytes dropped from the rolling tail to keep it within its cap. */
	get tailDroppedBytes(): number {
		return this._totalBytesSeen - this._byteLength;
	}

	/** Cumulative bytes dropped from the progress buffer and never forwarded. */
	get progressDroppedBytes(): number {
		return this._progressDroppedBytes;
	}

	/**
	 * @deprecated Use {@link progressDroppedBytes}. Kept while existing event
	 * consumers migrate to the two explicit counters.
	 */
	get droppedBytes(): number {
		return this.progressDroppedBytes;
	}

	/** Append a chunk of output, feeding both the rolling tail and the increment. */
	append(chunk: Buffer | string): void {
		const buffer =
			typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
		if (buffer.length === 0) return;
		this._totalBytesSeen += buffer.length;

		this._chunks.push(buffer);
		this._byteLength += buffer.length;
		this._byteLength = trimHead(this._chunks, this._byteLength, this._maxBytes);

		if (this._incByteLength === 0) {
			this._incStartOffset = this._totalBytesSeen - buffer.length;
		}
		this._incChunks.push(buffer);
		this._incByteLength += buffer.length;
		const beforeTrim = this._incByteLength;
		this._incByteLength = trimHead(
			this._incChunks,
			this._incByteLength,
			this._incMaxBytes,
		);
		const dropped = beforeTrim - this._incByteLength;
		if (dropped > 0) {
			this._incStartOffset += dropped;
			this._progressDroppedBytes += dropped;
		}

		this._onAppend?.();
	}

	/** Current tail decoded as UTF-8. */
	read(): string {
		return Buffer.concat(this._chunks, this._byteLength).toString("utf-8");
	}

	/**
	 * Drain and clear the unforwarded increment. Returns undefined when nothing
	 * new has been appended since the previous drain, so a progress pump can skip
	 * emitting an empty event.
	 */
	drainIncrement(): BackgroundJobOutputIncrement | undefined {
		if (this._incByteLength === 0) return undefined;
		const startByte = this._incStartOffset;
		const chunk = Buffer.concat(this._incChunks, this._incByteLength).toString(
			"base64",
		);
		const endByte = startByte + this._incByteLength;
		this._incChunks.length = 0;
		this._incByteLength = 0;
		this._incStartOffset = endByte;
		return {
			chunk,
			startByte,
			endByte,
			totalBytesSeen: this._totalBytesSeen,
			progressDroppedBytes: this._progressDroppedBytes,
		};
	}
}

/**
 * Trim `chunks` from the head until the running byte total is back within
 * `maxBytes`, slicing the boundary chunk rather than pinning an oversized parent
 * allocation. Returns the new total.
 */
function trimHead(
	chunks: Buffer[],
	byteLength: number,
	maxBytes: number,
): number {
	while (byteLength > maxBytes) {
		const head = chunks[0];
		if (byteLength - head.length >= maxBytes) {
			chunks.shift();
			byteLength -= head.length;
			continue;
		}
		// Dropping the whole head would fall under the cap; keep just its tail so
		// the buffer holds exactly the last maxBytes bytes. Copy instead of
		// subarray: a view would pin the full parent allocation of an oversized
		// chunk for as long as it stays at the head of a quiet job.
		const overflow = byteLength - maxBytes;
		chunks[0] = Buffer.from(head.subarray(overflow));
		byteLength -= overflow;
		break;
	}
	return byteLength;
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
 * outcome: the tool's text content when it resolved, otherwise the error, the
 * stop reason, or a short cancellation note.
 */
export function formatBackgroundJobResultMessageText(
	settlement: BackgroundJobSettlement,
): string {
	return formatBackgroundJobResultText({
		jobId: settlement.job.id,
		toolCallId: settlement.job.toolCallId,
		toolName: settlement.job.toolName,
		status: settlement.outcome.status,
		resultText: extractBackgroundJobOutcomeText(settlement),
	});
}

function extractBackgroundJobOutcomeText(
	settlement: BackgroundJobSettlement,
): string {
	const { outcome, job } = settlement;
	if (outcome.result) {
		return outcome.result.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("");
	}
	const errorText =
		outcome.error === undefined ? undefined : errorToText(outcome.error);
	// An explicit stop reason explains why cancellation was requested, while the
	// tool error can still contain useful partial output. Preserve both unless
	// settlement derived the reason directly from that same error.
	if (job.stopReason !== undefined && job.stopReason.length > 0) {
		return errorText && errorText !== job.stopReason
			? `${job.stopReason}\n\n${errorText}`
			: job.stopReason;
	}
	if (outcome.status === "cancelled" && errorText === undefined) {
		return "The job was cancelled before it produced a result.";
	}
	if (errorText !== undefined) return errorText;
	return "";
}

function errorToText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Fill the terminal reason when no earlier abort supplied a more specific one. */
function stopReasonFromOutcome(
	outcome: BackgroundJobOutcome,
): string | undefined {
	if (outcome.status === "completed") return undefined;
	if (outcome.error !== undefined) return errorToText(outcome.error);
	return outcome.status === "cancelled"
		? "The job was cancelled."
		: "The job failed.";
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
	/** Human-readable label for the job (for bash, the command); may be absent. */
	readonly description?: string;
	/** Abort signal handed to the tool's execute; abort via `BackgroundJobTable.abort`. */
	readonly signal: AbortSignal;
	/** Current lifecycle phase. */
	readonly phase: BackgroundJobPhase;
	/** Epoch ms when the job was created (its tool call began). */
	readonly startedAt: number;
	/** Epoch ms when the job moved to the background (t0); absent while running. */
	readonly backgroundedAt?: number;
	/** Epoch ms when the job settled; absent while live. */
	readonly endedAt?: number;
	/** Abort, failure, or cancellation reason; absent for normal completion. */
	readonly stopReason?: string;
	/**
	 * Live rolling tail plus forward increment of the job's output. A
	 * backgrounded tool appends its output stream here; read_job pulls the tail
	 * and the progress pump drains increments. Its lifetime is the job's: it is
	 * garbage-collected with the record when the job settles.
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
 * Listener invoked when a backgrounded job has produced new output, throttled to
 * at most one call per `progressThrottleMs`. Best-effort: it signals that an
 * increment is available to drain, not the increment itself; the consumer pulls
 * the coalesced bytes via {@link BackgroundJob.output}.
 */
export type BackgroundJobProgressListener = (job: BackgroundJob) => void;

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
	/** Human-readable label for the job; absent when the tool supplied none. */
	readonly description?: string;
	/** Lifecycle phase at snapshot time. */
	readonly phase: BackgroundJobPhase;
	/** Terminal outcome, present once the job settled. */
	readonly status?: BackgroundJobStatus;
	/** Reason for an abort/terminal status, when recorded. */
	readonly stopReason?: string;
	/** Epoch ms when the job was created. */
	readonly startedAt: number;
	/** Epoch ms when the job moved to the background (t0); absent while running. */
	readonly backgroundedAt?: number;
	/** Epoch ms when the job settled; absent while live. */
	readonly endedAt?: number;
	/** Total bytes ever appended to the job's output. */
	readonly totalBytesSeen: number;
	/**
	 * @deprecated Alias of `progressDroppedBytes`; use the explicit counters.
	 */
	readonly droppedBytes: number;
	/** Total bytes dropped from the rolling tail. */
	readonly tailDroppedBytes?: number;
	/** Cumulative bytes dropped from the progress buffer and never forwarded. */
	readonly progressDroppedBytes?: number;
}

export function snapshotBackgroundJob(
	job: BackgroundJob,
	overrides: { status?: BackgroundJobStatus } = {},
): BackgroundJobSnapshot {
	return {
		jobId: job.id,
		toolCallId: job.toolCallId,
		toolName: job.toolName,
		description: job.description,
		phase: job.phase,
		status: overrides.status,
		stopReason: job.stopReason,
		startedAt: job.startedAt,
		backgroundedAt: job.backgroundedAt,
		endedAt: job.endedAt,
		totalBytesSeen: job.output.totalBytesSeen,
		droppedBytes: job.output.progressDroppedBytes,
		tailDroppedBytes: job.output.tailDroppedBytes,
		progressDroppedBytes: job.output.progressDroppedBytes,
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
	startedAt: number;
	backgroundedAt?: number;
	endedAt?: number;
	stopReason?: string;
	/** Trailing throttle timer for progress emission; unref'd so it never holds the process open. */
	progressTimer?: ReturnType<typeof setTimeout>;
	/** Epoch ms of the last progress emission, for throttle spacing. */
	lastProgressAt: number;
	/** True once the circuit-breaker ceiling has fired for this job. */
	ceilingTripped: boolean;
	readonly view: BackgroundJob;
}

export interface BackgroundJobTableOptions {
	/** Injectable id factory. Defaults to a monotonic `job-N` counter. */
	readonly createId?: () => string;
	/** Minimum spacing between a job's progress emissions. */
	readonly progressThrottleMs?: number;
	/**
	 * Cooperative ceiling on bytes appended through the job output; 0 disables
	 * it. This does not cap an eventual tool result.
	 */
	readonly outputCeilingBytes?: number;
	/** Cap on a job's unforwarded progress-increment buffer. */
	readonly incrementMaxBytes?: number;
}

/**
 * Tracks live pseudo-async background jobs.
 *
 * A `backgroundable` tool call races a deadline in the tool adapter. If the
 * deadline wins, the call is moved to the background: the adapter settles the
 * tool call immediately with a job handle (t0), and the still-running promise
 * keeps going. When it finally settles, the table notifies change listeners so a
 * router (later stage) can inject the outcome as a separate message (t1). While
 * it runs, output appended to the job's buffer drives throttled progress
 * notifications so surfaces and extensions can stream or persist it.
 *
 * The table owns each job's `AbortController`, so a job's lifetime is decoupled
 * from the tool call that started it: once t0 returns, the original tool_use is
 * closed and its run signal no longer governs the background work. It also owns
 * the cooperative circuit breaker: streamed output crossing
 * `outputCeilingBytes` requests that the job abort once. A tool must both append
 * its streaming bytes and honor the abort signal for this to terminate its work.
 *
 * The table is the single source of truth for job state: every mutation goes
 * through `create`/`background`/`settle`/`abort`, and every observable mutation
 * (from t0 onward) emits exactly one {@link BackgroundJobChange} on the single
 * `onChange` channel; output growth is signalled separately on `onProgress`.
 */
export class BackgroundJobTable {
	private readonly _jobs = new Map<string, JobRecord>();
	private readonly _changeListeners = new Set<BackgroundJobChangeListener>();
	private readonly _progressListeners =
		new Set<BackgroundJobProgressListener>();
	private readonly _createId: () => string;
	private readonly _progressThrottleMs: number;
	private readonly _outputCeilingBytes: number;
	private readonly _incrementMaxBytes: number;
	private _counter = 0;

	constructor(options: BackgroundJobTableOptions = {}) {
		this._createId = options.createId ?? (() => `job-${++this._counter}`);
		this._progressThrottleMs =
			options.progressThrottleMs ?? DEFAULT_BACKGROUND_JOB_PROGRESS_THROTTLE_MS;
		this._outputCeilingBytes =
			options.outputCeilingBytes ?? DEFAULT_BACKGROUND_JOB_OUTPUT_CEILING_BYTES;
		this._incrementMaxBytes =
			options.incrementMaxBytes ?? DEFAULT_BACKGROUND_JOB_INCREMENT_MAX_BYTES;
	}

	/** Register a new job in the `running` phase and return its public view. */
	create(input: {
		toolCallId: string;
		toolName: string;
		description?: string;
	}): BackgroundJob {
		const id = this._createId();
		const controller = new AbortController();
		const output = new BackgroundJobOutput(
			DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES,
			{
				incrementMaxBytes: this._incrementMaxBytes,
				onAppend: () => this._onJobAppend(id),
			},
		);
		const record: JobRecord = {
			controller,
			phase: "running",
			settled: false,
			startedAt: Date.now(),
			lastProgressAt: 0,
			ceilingTripped: false,
			view: {
				id,
				toolCallId: input.toolCallId,
				toolName: input.toolName,
				description: input.description,
				signal: controller.signal,
				output,
				get phase() {
					return record.phase;
				},
				get startedAt() {
					return record.startedAt;
				},
				get backgroundedAt() {
					return record.backgroundedAt;
				},
				get endedAt() {
					return record.endedAt;
				},
				get stopReason() {
					return record.stopReason;
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
		if (!record || record.settled || record.phase !== "running") return false;
		record.phase = "backgrounded";
		record.backgroundedAt = Date.now();
		this._emitChange({ transition: "backgrounded", job: record.view });
		// Output may have accumulated during the pre-t0 synchronous window. Make
		// it observable only after the backgrounded lifecycle event, preserving
		// the rule that surfaces never see a job before its handle exists.
		if (record.view.output.totalBytesSeen > 0) {
			this._scheduleProgress(record);
		}
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
		record.endedAt = Date.now();
		record.stopReason ??= stopReasonFromOutcome(outcome);
		this._clearProgressTimer(record);
		this._jobs.delete(id);
		if (record.phase !== "backgrounded") return "inline";
		this._emitChange({ transition: "settled", job: record.view, outcome });
		return "backgrounded";
	}

	/**
	 * Abort a live job, optionally recording a reason (a kill note or a
	 * circuit-breaker trip) surfaced on the job's snapshot and its t1 message. The
	 * tool's execute observes the abort via its signal. For a backgrounded job the
	 * first abort emits an `aborting` change before the signal fires, so it always
	 * precedes the resulting `settled`; repeated aborts are silent. A
	 * `running`-phase abort (the pre-t0 sync window) emits nothing: the job is not
	 * observable yet and settles inline.
	 */
	abort(id: string, reason?: string): void {
		const record = this._jobs.get(id);
		if (!record) return;
		if (reason !== undefined && record.stopReason === undefined) {
			record.stopReason = reason;
		}
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

	/** Subscribe to throttled per-job output-progress notifications. */
	onProgress(listener: BackgroundJobProgressListener): () => void {
		this._progressListeners.add(listener);
		return () => this._progressListeners.delete(listener);
	}

	/**
	 * Handle an output append: trip the cooperative streaming circuit breaker
	 * when the total crosses the ceiling, then schedule a throttled progress
	 * notification only after t0 made the job observable.
	 */
	private _onJobAppend(id: string): void {
		const record = this._jobs.get(id);
		if (!record || record.settled) return;
		if (
			!record.ceilingTripped &&
			this._outputCeilingBytes > 0 &&
			record.view.output.totalBytesSeen > this._outputCeilingBytes
		) {
			record.ceilingTripped = true;
			this.abort(id, ceilingReason(this._outputCeilingBytes));
			return;
		}
		if (record.phase === "backgrounded") {
			this._scheduleProgress(record);
		}
	}

	/**
	 * Fire a progress notification for a job, throttled to `progressThrottleMs`.
	 * A burst within one window is coalesced into a single trailing emission; the
	 * listener drains the accumulated increment when it runs.
	 */
	private _scheduleProgress(record: JobRecord): void {
		if (this._progressListeners.size === 0) return;
		if (record.progressTimer !== undefined) return;
		const elapsed = Date.now() - record.lastProgressAt;
		if (elapsed >= this._progressThrottleMs) {
			this._emitProgress(record);
			return;
		}
		record.progressTimer = setTimeout(() => {
			record.progressTimer = undefined;
			if (record.settled) return;
			this._emitProgress(record);
		}, this._progressThrottleMs - elapsed);
		record.progressTimer.unref?.();
	}

	private _emitProgress(record: JobRecord): void {
		record.lastProgressAt = Date.now();
		for (const listener of this._progressListeners) {
			try {
				listener(record.view);
			} catch {
				// Listener failures are the consumer's responsibility, not the
				// table's; isolate them so one bad listener cannot drop the others.
			}
		}
	}

	private _clearProgressTimer(record: JobRecord): void {
		if (record.progressTimer !== undefined) {
			clearTimeout(record.progressTimer);
			record.progressTimer = undefined;
		}
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

/** Terminal `stopReason` recorded when a job trips the output ceiling. */
function ceilingReason(ceilingBytes: number): string {
	const mib = Math.floor(ceilingBytes / (1024 * 1024));
	return (
		`Output limit exceeded: the job produced more than ${mib} MiB and was ` +
		`terminated. Redirect large output to a file (for example \`command > out.txt\`) ` +
		`and inspect it in slices instead.`
	);
}
