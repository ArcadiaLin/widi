/**
 * The structured report a tool may publish about its background job: a
 * latest-value register, not a log.
 *
 * Output bytes say what a job printed; a report says what it is doing, in a
 * shape a consumer can render without parsing text. It is replace-only and
 * bounded, so a surface can always show the current value without replaying
 * history, and a runaway producer cannot turn it into a stream.
 */

/** JSON-compatible value accepted inside a structured background job report. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

/** Tool-owned, replace-only structured report describing a job's current work. */
export interface BackgroundJobReport {
	/** Renderer/consumer discriminator, for example `widi.plan`. */
	readonly kind: string;
	/** Schema version scoped to `kind`. */
	readonly schemaVersion: number;
	/** Short dynamic fallback for consumers that do not know `kind`. */
	readonly summary?: string;
	/** Optional generic progress that every consumer can render. */
	readonly progress?: {
		readonly completed: number;
		readonly total?: number;
	};
	/** Kind-specific JSON data. */
	readonly data?: JsonValue;
}

/** Immutable latest-value register stored on a background job. */
export interface BackgroundJobReportSnapshot {
	/** Per-job monotonic revision, starting at 1. */
	readonly revision: number;
	/** Epoch ms when this revision was accepted. */
	readonly updatedAt: number;
	/** Validated, detached, deeply frozen report value. */
	readonly value: BackgroundJobReport;
}

/** Maximum serialized size of one structured report: 64 KiB. */
export const MAX_BACKGROUND_JOB_REPORT_BYTES = 64 * 1024;

/** Maximum UTF-8 size of a structured report discriminator. */
export const MAX_BACKGROUND_JOB_REPORT_KIND_BYTES = 128;

/** Maximum UTF-8 size of a structured report summary. */
export const MAX_BACKGROUND_JOB_REPORT_SUMMARY_BYTES = 4 * 1024;

/**
 * Validate, detach, and deeply freeze a tool-published report. JSON
 * round-tripping gives snapshots transport-safe value semantics: later
 * mutation of the tool's input object cannot change the job without a new
 * revision.
 */
export function validateBackgroundJobReport(
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
	if (
		Buffer.byteLength(serialized, "utf-8") > MAX_BACKGROUND_JOB_REPORT_BYTES
	) {
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
	if (Buffer.byteLength(value, "utf-8") > maxBytes) {
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
export function createReportSnapshot(
	value: BackgroundJobReport,
	revision: number,
	updatedAt: number,
): BackgroundJobReportSnapshot {
	return Object.freeze({ revision, updatedAt, value });
}
