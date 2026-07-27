/**
 * What a background job is, and the vocabulary its observers share.
 *
 * A job is the identity a pseudo-async tool call takes on once its deadline
 * passes: the model holds the handle, the table owns the state, and everything
 * else - surfaces, extensions, the result router, the durable store - works
 * from the types here. They carry no behavior, so nothing has to depend on the
 * table just to speak about a job.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { BackgroundJobOutput } from "./output.ts";
import type { BackgroundJobReportSnapshot } from "./report.ts";

/** Terminal outcome of a background job. */
export type BackgroundJobStatus = "completed" | "failed" | "cancelled";

/** Lifecycle phase of a live background job before it settles. */
export type BackgroundJobPhase = "running" | "backgrounded";

/**
 * Whether a job has a local executor, and if not, who is allowed to settle it.
 *
 * `local` is the ordinary case: the tool call that created the job holds its
 * promise, so exactly one place settles it and that same place observes the
 * abort signal. `external` has no such promise - the outcome is written from
 * outside by the named settler. Both of the divergences below follow from that
 * one structural fact rather than from any notion of what the work is:
 * settlement must be authorized against `settlerId` because it no longer
 * arrives through a handle the table gave out, and an abort must be completed
 * by the table because no executor is watching the signal to confirm it.
 *
 * Delegated multi-agent work is just an external job whose settler is another
 * agent. The job id is the whole task identity; nothing here models a task.
 */
export type BackgroundJobOrigin =
	| { readonly kind: "local" }
	| { readonly kind: "external"; readonly settlerId: string };

/** Public, read-only view of a background job. */
export interface BackgroundJob {
	/** Runtime-local job handle returned to the model at t0. */
	readonly id: string;
	/** Who settles this job. */
	readonly origin: BackgroundJobOrigin;
	/** Id of the tool call that started the job. */
	readonly toolCallId: string;
	/** Name of the tool that started the job. */
	readonly toolName: string;
	/** Human-readable label for the job (for bash, the command); may be absent. */
	readonly description?: string;
	/** Latest structured tool-owned report, when the tool published one. */
	readonly report?: BackgroundJobReportSnapshot;
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
 * Listener invoked when the latest structured report of a backgrounded job
 * changes. Bursts are coalesced; `report.revision` identifies the exact latest
 * value observed by this emission.
 */
export type BackgroundJobReportListener = (
	job: BackgroundJob,
	report: BackgroundJobReportSnapshot,
) => void;

/**
 * Immutable, serializable view of a job at the moment of a change. Carried on
 * orchestrator events and query results instead of the live `BackgroundJob`
 * view, which holds a signal and a live output buffer.
 */
export interface BackgroundJobSnapshot {
	/** Runtime-local job handle returned to the model at t0. */
	readonly jobId: string;
	/** Who settles this job: the local tool call, or a named external settler. */
	readonly origin: BackgroundJobOrigin;
	/** Id of the tool call that started the job. */
	readonly toolCallId: string;
	/** Name of the tool that started the job. */
	readonly toolName: string;
	/** Human-readable label for the job; absent when the tool supplied none. */
	readonly description?: string;
	/** Latest structured tool-owned report, when one has been published. */
	readonly report?: BackgroundJobReportSnapshot;
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
		origin: job.origin,
		toolCallId: job.toolCallId,
		toolName: job.toolName,
		description: job.description,
		report: job.report,
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
 * Result of `BackgroundJobTable.settle`.
 * - `backgrounded`: the job had been moved to the background; a `settled`
 *   change fired.
 * - `inline`: the job settled before the deadline; the adapter returns the
 *   result inline and no change fires.
 * - `ignored`: the job was already settled or unknown.
 * - `denied`: an `external` job was settled by someone other than its named
 *   settler; nothing changed, and the caller must surface the refusal rather
 *   than retrying as a different identity.
 */
export type BackgroundJobSettleResult =
	| "backgrounded"
	| "inline"
	| "ignored"
	| "denied";
