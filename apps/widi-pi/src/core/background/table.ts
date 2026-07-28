/**
 * The live registry of an agent's background jobs, and the single source of
 * truth for their state.
 *
 * Every mutation goes through this class, so the invariants that make a job
 * safe to observe hold in one place: a job is invisible until t0, it settles at
 * most once, an abort is idempotent, and emissions are throttled rather than
 * per-byte. The table also owns each job's `AbortController`, which is what
 * decouples a job's lifetime from the tool call that started it.
 *
 * It is deliberately synchronous and free of IO: durability is a projection
 * built from its events, never a step inside a mutation.
 */

import type {
	BackgroundJob,
	BackgroundJobChange,
	BackgroundJobChangeListener,
	BackgroundJobOrigin,
	BackgroundJobOutcome,
	BackgroundJobPhase,
	BackgroundJobProgressListener,
	BackgroundJobReportListener,
	BackgroundJobSettleResult,
} from "./job.ts";
import { stopReasonFromOutcome } from "./messages.ts";
import {
	BackgroundJobOutput,
	DEFAULT_BACKGROUND_JOB_INCREMENT_MAX_BYTES,
	DEFAULT_BACKGROUND_JOB_OUTPUT_CEILING_BYTES,
	DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES,
} from "./output.ts";
import type {
	BackgroundJobReport,
	BackgroundJobReportSnapshot,
} from "./report.ts";
import { createReportSnapshot, validateBackgroundJobReport } from "./report.ts";

/** Default minimum spacing between a job's progress emissions: 100 ms. */
export const DEFAULT_BACKGROUND_JOB_PROGRESS_THROTTLE_MS = 100;

/** Default minimum spacing between structured report emissions: 100 ms. */
export const DEFAULT_BACKGROUND_JOB_REPORT_THROTTLE_MS = 100;

const LOCAL_ORIGIN: BackgroundJobOrigin = Object.freeze({ kind: "local" });

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
	/** Last accepted report revision; 0 means the job has no report. */
	reportRevision: number;
	/** Latest accepted structured report. */
	report?: BackgroundJobReportSnapshot;
	/** True when a report update is waiting for its throttled emission. */
	reportDirty: boolean;
	/** Trailing throttle timer for structured report emission. */
	reportTimer?: ReturnType<typeof setTimeout>;
	/** Epoch ms of the last structured report emission. */
	lastReportAt: number;
	readonly view: BackgroundJob;
}

export interface BackgroundJobTableOptions {
	/** Injectable id factory. Defaults to a monotonic `job-N` counter. */
	readonly createId?: () => string;
	/** Minimum spacing between a job's progress emissions. */
	readonly progressThrottleMs?: number;
	/** Minimum spacing between a job's structured report emissions. */
	readonly reportThrottleMs?: number;
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
 * through `create`/`setReport`/`background`/`settle`/`abort`. Lifecycle
 * mutations (from t0 onward) emit {@link BackgroundJobChange} on `onChange`;
 * output growth is signalled separately on `onProgress`, and structured
 * latest-value reports on `onReport`.
 */
export class BackgroundJobTable {
	private readonly _jobs = new Map<string, JobRecord>();
	private readonly _changeListeners = new Set<BackgroundJobChangeListener>();
	private readonly _progressListeners =
		new Set<BackgroundJobProgressListener>();
	private readonly _reportListeners = new Set<BackgroundJobReportListener>();
	private readonly _createId: () => string;
	private readonly _progressThrottleMs: number;
	private readonly _reportThrottleMs: number;
	private readonly _outputCeilingBytes: number;
	private readonly _incrementMaxBytes: number;
	private _counter = 0;

	constructor(options: BackgroundJobTableOptions = {}) {
		this._createId = options.createId ?? (() => `job-${++this._counter}`);
		this._progressThrottleMs =
			options.progressThrottleMs ?? DEFAULT_BACKGROUND_JOB_PROGRESS_THROTTLE_MS;
		this._reportThrottleMs =
			options.reportThrottleMs ?? DEFAULT_BACKGROUND_JOB_REPORT_THROTTLE_MS;
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
		report?: BackgroundJobReport;
		/** Defaults to a job settled by the local tool call that created it. */
		origin?: BackgroundJobOrigin;
	}): BackgroundJob {
		const startedAt = Date.now();
		const initialReport =
			input.report === undefined
				? undefined
				: createReportSnapshot(
						validateBackgroundJobReport(input.report),
						1,
						startedAt,
					);
		const id = this._createId();
		// Detached and frozen: the origin is the settlement authority, and a
		// caller that kept its object must not be able to name a different
		// settler later - or rewrite the origin on snapshots already published to
		// surfaces.
		const origin: BackgroundJobOrigin =
			input.origin === undefined
				? LOCAL_ORIGIN
				: Object.freeze({ ...input.origin });
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
			startedAt,
			lastProgressAt: 0,
			ceilingTripped: false,
			reportRevision: initialReport?.revision ?? 0,
			report: initialReport,
			reportDirty: false,
			lastReportAt: 0,
			view: {
				id,
				origin,
				toolCallId: input.toolCallId,
				toolName: input.toolName,
				description: input.description,
				signal: controller.signal,
				output,
				get report() {
					return record.report;
				},
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
	 * Replace a live job's structured report. Returns false when the job has
	 * already settled or is unknown; invalid reports throw before changing the
	 * current value.
	 */
	setReport(id: string, report: BackgroundJobReport): boolean {
		const record = this._jobs.get(id);
		if (!record || record.settled) return false;
		const value = validateBackgroundJobReport(report);
		record.reportRevision += 1;
		record.report = createReportSnapshot(
			value,
			record.reportRevision,
			Date.now(),
		);
		if (record.phase === "backgrounded") {
			record.reportDirty = true;
			this._scheduleReport(record);
		}
		return true;
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
		record.lastReportAt = record.backgroundedAt;
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
	 *
	 * `settledBy` authorizes an external settlement: an `external` job has no
	 * local promise, so its outcome is written by the named settler and only by
	 * that settler. Local jobs ignore it - their settler is the tool call the
	 * table already handed the job to.
	 */
	settle(
		id: string,
		outcome: BackgroundJobOutcome,
		options: { settledBy?: string } = {},
	): BackgroundJobSettleResult {
		const record = this._jobs.get(id);
		if (!record || record.settled) return "ignored";
		const origin = record.view.origin;
		if (origin.kind === "external" && options.settledBy !== origin.settlerId) {
			return "denied";
		}
		return this._settle(id, record, outcome);
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
		// An external job has no executor watching the signal, so nothing would
		// ever confirm the abort. Complete the transition here instead of leaving
		// the job stuck in `aborting` forever.
		if (record.view.origin.kind === "external" && !record.settled) {
			this._settle(id, record, { status: "cancelled" });
		}
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

	/** Subscribe to throttled latest-value structured report updates. */
	onReport(listener: BackgroundJobReportListener): () => void {
		this._reportListeners.add(listener);
		return () => this._reportListeners.delete(listener);
	}

	private _settle(
		id: string,
		record: JobRecord,
		outcome: BackgroundJobOutcome,
	): BackgroundJobSettleResult {
		record.settled = true;
		record.endedAt = Date.now();
		record.stopReason ??= stopReasonFromOutcome(outcome);
		this._flushReport(record);
		this._clearProgressTimer(record);
		this._jobs.delete(id);
		if (record.phase !== "backgrounded") return "inline";
		this._emitChange({ transition: "settled", job: record.view, outcome });
		return "backgrounded";
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

	private _scheduleReport(record: JobRecord): void {
		if (this._reportListeners.size === 0) return;
		if (record.reportTimer !== undefined) return;
		const elapsed = Date.now() - record.lastReportAt;
		if (elapsed >= this._reportThrottleMs) {
			this._emitReport(record);
			return;
		}
		record.reportTimer = setTimeout(() => {
			record.reportTimer = undefined;
			if (record.settled) return;
			this._emitReport(record);
		}, this._reportThrottleMs - elapsed);
		record.reportTimer.unref?.();
	}

	private _flushReport(record: JobRecord): void {
		if (record.reportTimer !== undefined) {
			clearTimeout(record.reportTimer);
			record.reportTimer = undefined;
		}
		if (record.phase === "backgrounded" && record.reportDirty) {
			this._emitReport(record);
		}
	}

	private _emitReport(record: JobRecord): void {
		const report = record.report;
		if (!record.reportDirty || report === undefined) return;
		record.reportDirty = false;
		record.lastReportAt = Date.now();
		for (const listener of this._reportListeners) {
			try {
				listener(record.view, report);
			} catch {
				// A report observer cannot interfere with job execution or other
				// observers.
			}
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

function ceilingReason(ceilingBytes: number): string {
	const mib = Math.floor(ceilingBytes / (1024 * 1024));
	return (
		`Output limit exceeded: the job produced more than ${mib} MiB and was ` +
		`terminated. Redirect large output to a file (for example \`command > out.txt\`) ` +
		`and inspect it in slices instead.`
	);
}
