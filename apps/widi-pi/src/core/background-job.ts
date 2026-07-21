import type {
	AgentToolResult,
	CustomMessage,
} from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";

/**
 * Pseudo-async tool results (see docs/pseudo-async-tools.md).
 *
 * A backgroundable tool call settles immediately with a job handle (t0), then
 * the eventual outcome is delivered as a separate message injected later (t1).
 * The LLM protocol forbids a deferred tool_result, so t1 is a normal custom
 * message, not a second tool_result: pi's `convertToLlm` maps `role: "custom"`
 * into a user message, so the model sees the outcome in context.
 *
 * This module owns the message/result shapes and their identities (t0 handle,
 * t1 message) plus the `BackgroundJobTable` that tracks live jobs. The timeout
 * race lives in the tool adapter; the phase-aware router that consumes settled
 * jobs lands in a later stage.
 */

/** Stable customType for background job result messages. */
export const BACKGROUND_JOB_RESULT_CUSTOM_TYPE = "widi:background_job_result";

/** Terminal outcome of a background job. */
export type BackgroundJobStatus = "completed" | "failed" | "cancelled";

/**
 * Structured payload carried on a background job result message.
 *
 * `toolCallId` correlates the t1 message back to the tool call that started the
 * job at t0, so the model (and UI) can link the outcome to its origin.
 */
export interface BackgroundJobResultDetails {
	/** Runtime-local job handle returned at t0. */
	readonly jobId: string;
	/** Id of the tool call that started the job. */
	readonly toolCallId: string;
	/** Name of the tool that started the job. */
	readonly toolName: string;
	/** Terminal outcome of the job. */
	readonly status: BackgroundJobStatus;
}

export interface CreateBackgroundJobResultMessageInput
	extends BackgroundJobResultDetails {
	/**
	 * Model-facing result text. Rendered into the message body under a
	 * self-describing header so the model can act on it out of band.
	 */
	readonly resultText: string;
	/** Message timestamp in epoch milliseconds. Defaults to now. */
	readonly timestamp?: number;
}

/**
 * Build the t1 message for a finished background job.
 *
 * The body is self-describing: by the time it arrives the conversation has
 * moved on, so it restates the job handle, origin tool call, and status before
 * the result text.
 */
export function createBackgroundJobResultMessage(
	input: CreateBackgroundJobResultMessageInput,
): CustomMessage<BackgroundJobResultDetails> {
	const details: BackgroundJobResultDetails = {
		jobId: input.jobId,
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		status: input.status,
	};
	return {
		role: "custom",
		customType: BACKGROUND_JOB_RESULT_CUSTOM_TYPE,
		content: formatBackgroundJobResultText(input),
		display: true,
		details,
		timestamp: input.timestamp ?? Date.now(),
	};
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
		`react to that later message when it arrives.`;
	return { content: [{ type: "text", text }], details };
}

/** Narrow an arbitrary custom message payload to background job result details. */
export function isBackgroundJobResultDetails(
	data: unknown,
): data is BackgroundJobResultDetails {
	if (typeof data !== "object" || data === null) return false;
	const record = data as Record<string, unknown>;
	return (
		typeof record.jobId === "string" &&
		typeof record.toolCallId === "string" &&
		typeof record.toolName === "string" &&
		(record.status === "completed" ||
			record.status === "failed" ||
			record.status === "cancelled")
	);
}

function formatBackgroundJobResultText(
	input: CreateBackgroundJobResultMessageInput,
): string {
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
}

/** Terminal outcome recorded when a job's underlying promise settles. */
export interface BackgroundJobOutcome {
	readonly status: BackgroundJobStatus;
	/** Present when the tool resolved. */
	readonly result?: AgentToolResult<unknown>;
	/** Present when the tool rejected. */
	readonly error?: unknown;
}

/** Settlement event delivered to result listeners for backgrounded jobs. */
export interface BackgroundJobSettlement {
	readonly job: BackgroundJob;
	readonly outcome: BackgroundJobOutcome;
}

/** Listener invoked when a backgrounded job settles. */
export type BackgroundJobResultListener = (
	settlement: BackgroundJobSettlement,
) => void;

/** Listener invoked when a job is moved to the background. */
export type BackgroundJobStartedListener = (job: BackgroundJob) => void;

/**
 * Result of {@link BackgroundJobTable.settle}.
 * - `backgrounded`: the job had been moved to the background; listeners fired.
 * - `inline`: the job settled before the deadline; the adapter returns the
 *   result inline and no listeners fire.
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
 */
export class BackgroundJobTable {
	private readonly _jobs = new Map<string, JobRecord>();
	private readonly _listeners = new Set<BackgroundJobResultListener>();
	private readonly _backgroundListeners =
		new Set<BackgroundJobStartedListener>();
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
		for (const listener of this._backgroundListeners) {
			try {
				listener(record.view);
			} catch {
				// Isolate observer failures, same as _notify.
			}
		}
		return true;
	}

	/**
	 * Record a job's terminal outcome. Fires result listeners only when the job
	 * had been backgrounded; a job that settled while still `running` returns
	 * `inline` and is delivered by the adapter's inline return instead.
	 */
	settle(id: string, outcome: BackgroundJobOutcome): BackgroundJobSettleResult {
		const record = this._jobs.get(id);
		if (!record || record.settled) return "ignored";
		record.settled = true;
		this._jobs.delete(id);
		if (record.phase !== "backgrounded") return "inline";
		this._notify({ job: record.view, outcome });
		return "backgrounded";
	}

	/** Abort a live job. The tool's execute observes the abort via its signal. */
	abort(id: string): void {
		this._jobs.get(id)?.controller.abort();
	}

	/** Subscribe to settlement events for backgrounded jobs. Returns an unsubscribe. */
	onResult(listener: BackgroundJobResultListener): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	/** Subscribe to jobs being moved to the background. Returns an unsubscribe. */
	onBackground(listener: BackgroundJobStartedListener): () => void {
		this._backgroundListeners.add(listener);
		return () => this._backgroundListeners.delete(listener);
	}

	private _notify(settlement: BackgroundJobSettlement): void {
		for (const listener of this._listeners) {
			try {
				listener(settlement);
			} catch {
				// Listener failures are the router's responsibility, not the table's;
				// isolate them so one bad listener cannot drop the others.
			}
		}
	}
}
