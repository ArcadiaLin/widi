/**
 * Pseudo-async tool results: the background job domain.
 *
 * A backgroundable tool call settles immediately with a job handle (t0), then
 * the eventual outcome is delivered as a separate message injected later (t1).
 * The LLM protocol forbids a deferred tool_result, so t1 is injected as a
 * normal user message: the orchestrator hands each settlement to `sendMessage`,
 * which arbitrates the harness method from the target's live delivery phase.
 *
 * The modules behind this barrel split that domain by ownership rather than by
 * lifecycle stage:
 *
 * - `job.ts` - what a job is, and the vocabulary every observer shares.
 * - `output.ts` - the job's byte stream and its two bounded windows.
 * - `report.ts` - the tool-owned structured latest-value register.
 * - `table.ts` - the live registry, the only place job state mutates.
 * - `messages.ts` - the two texts a job puts in front of the model (t0, t1).
 * - `external-jobs.ts` - the cross-table index of jobs owed by another settler.
 * - `store.ts` - the durable projection into the session directory.
 *
 * What is deliberately elsewhere: the deadline race that decides whether a call
 * is backgrounded at all lives in the tool adapter, and the t1 router and
 * progress pump live in the orchestrator.
 */

export {
	type ExternalJobDependency,
	ExternalJobDependencyIndex,
} from "./external-jobs.ts";
export {
	type BackgroundJob,
	type BackgroundJobChange,
	type BackgroundJobChangeListener,
	type BackgroundJobOrigin,
	type BackgroundJobOutcome,
	type BackgroundJobPhase,
	type BackgroundJobProgressListener,
	type BackgroundJobReportListener,
	type BackgroundJobSettlement,
	type BackgroundJobSettleResult,
	type BackgroundJobSnapshot,
	type BackgroundJobStatus,
	type BackgroundJobTransition,
	snapshotBackgroundJob,
} from "./job.ts";
export {
	type BackgroundJobStartedDetails,
	backgroundJobResultHeaderPrefix,
	createBackgroundJobStartedResult,
	formatBackgroundJobResultMessageText,
	formatBackgroundJobResultText,
	formatInterruptedBackgroundJobResultText,
} from "./messages.ts";
export {
	BackgroundJobOutput,
	type BackgroundJobOutputIncrement,
	DEFAULT_BACKGROUND_JOB_INCREMENT_MAX_BYTES,
	DEFAULT_BACKGROUND_JOB_OUTPUT_CEILING_BYTES,
	DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES,
} from "./output.ts";
export {
	type BackgroundJobReport,
	type BackgroundJobReportSnapshot,
	type JsonValue,
	MAX_BACKGROUND_JOB_REPORT_BYTES,
	MAX_BACKGROUND_JOB_REPORT_KIND_BYTES,
	MAX_BACKGROUND_JOB_REPORT_SUMMARY_BYTES,
	validateBackgroundJobReport,
} from "./report.ts";
export {
	BACKGROUND_JOBS_DIR_NAME,
	BACKGROUND_JOBS_FILE_NAME,
	BackgroundJobStore,
	type BackgroundJobStoreOptions,
	MAX_PERSISTED_JOB_MESSAGE_BYTES,
	MAX_PERSISTED_JOB_OUTPUT_BYTES,
	type PersistedBackgroundJob,
} from "./store.ts";
export {
	BackgroundJobTable,
	type BackgroundJobTableOptions,
	DEFAULT_BACKGROUND_JOB_PROGRESS_THROTTLE_MS,
	DEFAULT_BACKGROUND_JOB_REPORT_THROTTLE_MS,
} from "./table.ts";
