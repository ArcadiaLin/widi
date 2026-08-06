/**
 * Pseudo-async tool results: the background job domain.
 *
 * A backgroundable tool call settles immediately with a job handle (t0), then
 * the eventual outcome is delivered as a separate message injected later (t1).
 * The LLM protocol forbids a deferred tool_result, so t1 is injected as a normal
 * user message: the runtime hands each settlement to its host, which arbitrates
 * the harness method from the target's live delivery phase.
 *
 * The modules behind this barrel are one runtime and the things it cannot hold
 * without mixing unrelated invariants:
 *
 * - `background.ts` - the runtime: the only place job state changes, the only
 *   authority on who may change it, and the owner of every ordering rule.
 * - `types.ts` - the whole vocabulary: lifecycle, capabilities, ports, records.
 * - `output.ts` - one job's byte stream and its two bounded windows.
 * - `job-persistence.ts` - the records, the `core:jobs` namespace that holds
 *   them, and one agent's history bound to its branch.
 * - `messages.ts` - the two texts a job puts in front of the model (t0, t1).
 *
 * What is deliberately elsewhere: the deadline race that decides whether a call
 * is backgrounded at all lives in the tool adapter, and the delivery policy for
 * a settled job's t1 - interception, merging, prompt versus steer - belongs to
 * whoever implements `deliverResult`.
 */

export type { JsonValue } from "../../utils/json.ts";
export { BackgroundJobRuntime } from "./background.ts";
export {
	applyJobRecord,
	boundJobRecord,
	createJobsNamespace,
	JOB_OUTPUT_DIR_NAME,
	JOBS_FORMAT_VERSION,
	JOBS_NAMESPACE,
	JobHistoryStorage,
	jobOutputFileName,
	MAX_JOB_CHAIN_LENGTH,
	planJobClosures,
	reduceJobRecords,
	SessionJobStore,
	toJobRecord,
} from "./job-persistence.ts";
export {
	type BackgroundJobStartedDetails,
	backgroundJobResultHeaderPrefix,
	backgroundJobToolLabel,
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
	type BackgroundJobChange,
	type BackgroundJobEvent,
	type BackgroundJobExecution,
	type BackgroundJobHost,
	type BackgroundJobLifecycleState,
	type BackgroundJobOrigin,
	type BackgroundJobOutcome,
	type BackgroundJobOutputWriter,
	type BackgroundJobPersistenceHealth,
	type BackgroundJobReadResult,
	type BackgroundJobReport,
	type BackgroundJobReportSnapshot,
	type BackgroundJobRuntimeOptions,
	type BackgroundJobRuntimePorts,
	type BackgroundJobSettlement,
	type BackgroundJobSettler,
	type BackgroundJobSnapshot,
	type BackgroundJobStatus,
	type BackgroundJobTransition,
	type BackgroundJobWatch,
	type CreateExternalJobInput,
	DEFAULT_BACKGROUND_JOB_PROGRESS_THROTTLE_MS,
	DEFAULT_BACKGROUND_JOB_REPORT_THROTTLE_MS,
	type JobBranchPort,
	type JobCloseCause,
	type JobClosedRecord,
	type JobHistory,
	type JobHistoryEntry,
	type JobHistoryState,
	type JobRecord,
	type JobRejection,
	type JobResult,
	type JobSealRequest,
	type JobSettledRecord,
	type JobStartedRecord,
	MAX_BACKGROUND_JOB_REPORT_BYTES,
	MAX_BACKGROUND_JOB_REPORT_KIND_BYTES,
	MAX_BACKGROUND_JOB_REPORT_SUMMARY_BYTES,
	MAX_PERSISTED_JOB_MESSAGE_BYTES,
	MAX_PERSISTED_JOB_OUTPUT_BYTES,
	type ObservableBackgroundJobState,
	type OwnerAttachment,
	type SessionJobStoreOptions,
	type StartLocalJobInput,
} from "./types.ts";
