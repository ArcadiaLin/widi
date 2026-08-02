/**
 * The vocabulary of the background job domain: what a job is, who may act on
 * one, what gets written down, and what the runtime needs from its host.
 *
 * Two distinctions carry the domain and are why these types sit together: a job
 * candidate is not a job (a call that settles before its deadline was never
 * observable and leaves no trace anywhere), and execution state is not
 * persistence health (a `degraded` history does not stop a job from aborting,
 * settling, or delivering its result).
 *
 * Ids stay opaque strings: `core/types.ts` already depends on this domain, so
 * naming `AgentId` here would close a cycle for no gain.
 */

import type { AgentToolResult } from "@widi/agent-core";
import type { JsonValue } from "../../utils/json.ts";
import type { CoreDiagnostic } from "../diagnostics.ts";
import type { NamespaceProjection } from "../persistence/index.ts";
import type { JobHistoryStorage, SessionJobStore } from "./job-persistence.ts";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Every state a job passes through, including the two that are private.
 *
 * `foreground` and `accepting` belong to a candidate, not a job: the model has
 * no handle and an inline settlement ends the story. Only from `backgrounded`
 * on is the job something anyone else can name, which is also the point from
 * which it owes exactly one terminal outcome and one live t1 delivery attempt.
 * `abort_requested` says the runtime fired the signal, not that the executor
 * stopped; the confirmation is the settlement.
 */
export type BackgroundJobLifecycleState =
	| "foreground"
	| "accepting"
	| "backgrounded"
	| "abort_requested"
	| BackgroundJobStatus;

/** Terminal execution state. A job reaches exactly one, at most once. */
export type BackgroundJobStatus = "completed" | "failed" | "cancelled";

/** The states an observer can ever see: candidates are never handed out. */
export type ObservableBackgroundJobState = Exclude<
	BackgroundJobLifecycleState,
	"foreground" | "accepting"
>;

/** Not states: `settled` names the transition into any terminal state. */
export type BackgroundJobTransition =
	| "backgrounded"
	| "abort_requested"
	| "settled";

/**
 * Whether a job has a local executor, and if not, who may settle it. `local`
 * holds its own promise, so one place settles it and watches the abort signal.
 * `external` has no such promise - the outcome is written from outside by the
 * named settler - which is why settlement needs authorization and why an abort
 * has to be completed by the runtime itself.
 */
export type BackgroundJobOrigin =
	| { readonly kind: "local" }
	| { readonly kind: "external"; readonly settlerId: string };

/** Terminal outcome recorded when a job's underlying work settles. */
export interface BackgroundJobOutcome {
	readonly status: BackgroundJobStatus;
	/** Present when the tool resolved. */
	readonly result?: AgentToolResult<unknown>;
	/** Present when the tool rejected. */
	readonly error?: unknown;
}

/**
 * Immutable view of a job. Snapshots are the only shape that leaves the
 * runtime: the live record holds an abort controller and a growing buffer, and
 * handing those out is how observers start mutating state that is not theirs.
 */
export interface BackgroundJobSnapshot {
	/** Runtime-wide job handle the model holds from t0. */
	readonly jobId: string;
	/** Agent that owns the job and will read its t1. */
	readonly ownerAgentId: string;
	readonly origin: BackgroundJobOrigin;
	readonly toolCallId: string;
	readonly toolName: string;
	/** Short label the caller named this job with, when the tool takes one. */
	readonly name?: string;
	/** Human-readable label for the job; absent when the tool supplied none. */
	readonly description?: string;
	/** Latest structured tool-owned report, when one has been published. */
	readonly report?: BackgroundJobReportSnapshot;
	/** State at snapshot time. One field, not a phase plus a status. */
	readonly state: ObservableBackgroundJobState;
	/** Abort, failure, or cancellation reason; absent for normal completion. */
	readonly stopReason?: string;
	/** Epoch ms when the job's tool call began. */
	readonly startedAt: number;
	/** Epoch ms when the job became observable at t0. */
	readonly backgroundedAt: number;
	/** Epoch ms when the job settled; absent while live. */
	readonly endedAt?: number;
	/** Total bytes ever appended to the job's output. */
	readonly totalBytesSeen: number;
	/** Total bytes dropped from the rolling tail. */
	readonly tailDroppedBytes: number;
	/** Cumulative bytes dropped from the progress buffer and never forwarded. */
	readonly progressDroppedBytes: number;
}

/** A job that reached a terminal outcome, with the outcome it reached. */
export interface BackgroundJobSettlement {
	readonly job: BackgroundJobSnapshot;
	readonly outcome: BackgroundJobOutcome;
}

/** One observable lifecycle change, as delivered to a watcher. */
export type BackgroundJobChange =
	| {
			readonly transition: "backgrounded" | "abort_requested";
			readonly job: BackgroundJobSnapshot;
	  }
	| ({ readonly transition: "settled" } & BackgroundJobSettlement);

// ---------------------------------------------------------------------------
// Structured report
// ---------------------------------------------------------------------------

/**
 * Tool-owned, replace-only structured report describing a job's current work.
 * Output bytes say what a job printed; a report says what it is doing, in a
 * shape a consumer can render without parsing text.
 */
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

/** Accepted latest value of a job's report. Revisions are per job, monotonic. */
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

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * What every capability method returns. A refusal is a value, so the caller has
 * to handle it; a rejected promise from any of them is a bug, not an outcome.
 */
export type JobResult<T = unknown> =
	| ({ readonly ok: true } & T)
	| { readonly ok: false; readonly reason: JobRejection };

/**
 * Why a capability call did nothing. One vocabulary, so the tool layer derives
 * its model-facing wording from this list instead of each caller inventing its
 * own translation of a `false`.
 */
export type JobRejection =
	/** No such id, or the job is terminal and out of the live index. */
	| "unknown_job"
	/** Still a candidate: the caller should not have had this id at all. */
	| "not_backgrounded"
	/** External settlement from someone other than the recorded settler. */
	| "not_settler"
	/** The capability's attachment was superseded or detached. */
	| "stale_attachment"
	/** Only where a caller must distinguish a persistence downgrade. */
	| "degraded";

// ---------------------------------------------------------------------------
// Scoped capabilities
// ---------------------------------------------------------------------------

/**
 * How much of a job's history this owner can promise.
 *
 * - `ephemeral`: no session directory; the job lives and dies with the process.
 * - `durable`: the history is open and the required records are landing.
 * - `degraded`: a write failed, or the history could not be read back in full.
 *   Live behavior is unchanged - this is a claim about the record, not the job.
 */
export type BackgroundJobPersistenceHealth =
	| "ephemeral"
	| "durable"
	| "degraded";

/**
 * One agent's scope, handed out by `attachAgent` and dead after `detachAgent`.
 * Both capabilities close over this identity, so no model-controlled payload
 * ever names the agent it acts as.
 *
 * The generation answers exactly one question - "is this handle the current
 * one?" - and deliberately not "is the agent alive". A re-attached agent gets a
 * new generation, inherits no jobs, and does not become the settler of anything
 * its previous generation was assigned.
 */
export interface OwnerAttachment {
	readonly agentId: string;
	readonly sessionId: string;
	readonly generation: number;
	/** Live: an attachment that starts `durable` can become `degraded`. */
	readonly persistenceHealth: BackgroundJobPersistenceHealth;
	/** What this agent may do to its own jobs. */
	readonly host: BackgroundJobHost;
	/** What this agent may settle for other agents. */
	readonly settler: BackgroundJobSettler;
}

/** What a tool needs to start a job it will settle itself. */
export interface StartLocalJobInput {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly name?: string;
	readonly description?: string;
	readonly report?: BackgroundJobReport;
}

/** What an assigning tool needs to create a job someone else will settle. */
export interface CreateExternalJobInput extends StartLocalJobInput {
	/** The agent authorized to write this job's outcome. */
	readonly settlerAgentId: string;
}

/** A pull read of a job's rolling output tail, with the job it belongs to. */
export interface BackgroundJobReadResult {
	readonly job: BackgroundJobSnapshot;
	/** Bounded rolling tail; a progress peek, never the job's result. */
	readonly output: string;
}

/**
 * An atomic subscription: `jobs` is the snapshot taken when `watch()` returned,
 * and changes from that instant are buffered until `start` installs a listener,
 * which then receives them in order before going live. That is what makes a
 * wait correct without depending on there being no `await` between listing and
 * subscribing. The waiting policy itself stays in the tool layer.
 */
export interface BackgroundJobWatch {
	readonly jobs: readonly BackgroundJobSnapshot[];
	/** Flush the buffer to `listener`, then stream live. Returns unsubscribe. */
	start(listener: (change: BackgroundJobChange) => void): () => void;
}

/** Owner-scoped capability: everything an agent may do to its own jobs. */
export interface BackgroundJobHost {
	/**
	 * Begin a candidate the caller will settle through the returned handle. It
	 * refuses rather than throwing when the attachment is stale, because "the
	 * agent was disposed mid-call" is an ordinary outcome for a tool, not a bug.
	 */
	startLocal(
		input: StartLocalJobInput,
	): JobResult<{ execution: BackgroundJobExecution }>;
	/**
	 * Create a job another agent will settle. Async because the job must have a
	 * durable head before the assignment goes out: an assignment whose job left
	 * no record is how a task ends up owed by nobody.
	 */
	createExternal(
		input: CreateExternalJobInput,
	): Promise<JobResult<{ job: BackgroundJobSnapshot }>>;
	/** Observable jobs owned by this agent, oldest first. */
	list(): readonly BackgroundJobSnapshot[];
	read(jobId: string): JobResult<{ read: BackgroundJobReadResult }>;
	watch(): BackgroundJobWatch;
	abort(jobId: string, reason?: string): JobResult;
}

/**
 * The handle a backgroundable tool call holds for its own job. It is the only
 * way to settle a local job: nothing settles by naming an id, so a tool cannot
 * write an outcome into a call that is not its own.
 */
export interface BackgroundJobExecution {
	readonly jobId: string;
	/** Fires on abort, ceiling trip, or owner detach. */
	readonly signal: AbortSignal;
	readonly output: BackgroundJobOutputWriter;
	setReport(report: BackgroundJobReport): JobResult;
	/**
	 * Take the job into the background: the deadline won, and the caller is about
	 * to return a t0 handle. Synchronous, so registration completes before the
	 * caller's first await.
	 */
	acceptBackground(): JobResult<{ job: BackgroundJobSnapshot }>;
	/**
	 * Record the terminal outcome. `inline` means the job never reached the
	 * background, so the caller returns the result as an ordinary tool result and
	 * nothing was ever observable.
	 */
	settle(
		outcome: BackgroundJobOutcome,
	): JobResult<{ disposition: "inline" | "backgrounded" }>;
}

/**
 * Settler-scoped capability: write the outcome of a job owned by someone else.
 * Authorization is the settler attachment recorded on the job, generation
 * included, so a resumed agent cannot settle what its predecessor was assigned.
 */
export interface BackgroundJobSettler {
	settle(input: {
		readonly ownerAgentId: string;
		readonly jobId: string;
		readonly outcome: BackgroundJobOutcome;
	}): JobResult;
}

/** Write-only view of a job's output stream, as given to a running tool. */
export interface BackgroundJobOutputWriter {
	append(chunk: Buffer | string): void;
}

// ---------------------------------------------------------------------------
// Domain events
// ---------------------------------------------------------------------------

/**
 * What the runtime publishes. These are domain facts; mapping them onto
 * `OrchestratorEvent` is the host's job, which is why they carry no surface
 * concepts and no orchestrator types.
 *
 * Per owner they are strictly ordered, and `settled` is a barrier: the job's
 * final progress increment and report are published ahead of it.
 */
export type BackgroundJobEvent =
	| {
			readonly type: "job_changed";
			readonly agentId: string;
			readonly job: BackgroundJobSnapshot;
			readonly transition: BackgroundJobTransition;
			/** Observable jobs the owner has left, counted at the change. */
			readonly liveCount: number;
			/** ISO timestamp of the change. */
			readonly changedAt: string;
	  }
	| {
			readonly type: "job_progress";
			readonly agentId: string;
			readonly jobId: string;
			/** Per-job monotonic emission counter, from 0. */
			readonly sequence: number;
			/** Base64; a UTF-8 character may span two increments. */
			readonly chunk: string;
			readonly startByte: number;
			readonly endByte: number;
			readonly totalBytesSeen: number;
			readonly progressDroppedBytes: number;
			readonly observedAt: string;
			/** The originating tool call, for correlation with the timeline. */
			readonly operationRef: string;
	  }
	| {
			readonly type: "job_report";
			readonly agentId: string;
			readonly jobId: string;
			readonly report: BackgroundJobReportSnapshot;
			readonly changedAt: string;
			readonly operationRef: string;
	  };

// ---------------------------------------------------------------------------
// Durable records
// ---------------------------------------------------------------------------

/** Why a runtime closed a job the executor never answered for. */
export type JobCloseCause =
	| "resume"
	| "navigate"
	| "dispose"
	| "fork"
	| "abort";

export interface JobStartedRecord {
	readonly kind: "started";
	/** The key. Unique within a session, unlike the process-local `jobId`. */
	readonly toolCallId: string;
	readonly jobId: string;
	readonly ownerAgentId: string;
	readonly sessionId: string;
	readonly toolName: string;
	readonly name?: string;
	readonly description?: string;
	readonly origin: BackgroundJobOrigin;
	readonly startedAt: number;
	readonly backgroundedAt: number;
	/** File name inside the namespace's output directory, never a path. */
	readonly outputFile: string;
}

export interface JobSettledRecord {
	readonly kind: "settled";
	readonly toolCallId: string;
	readonly status: BackgroundJobStatus;
	readonly stopReason?: string;
	readonly endedAt: number;
	/** The exact t1 text, bounded before it is stored. */
	readonly messageText: string;
	readonly outputTail?: string;
}

export interface JobClosedRecord {
	readonly kind: "closed";
	readonly toolCallId: string;
	readonly cause: JobCloseCause;
	readonly closedAt: number;
	readonly stopReason?: string;
}

/**
 * The two terminal kinds are deliberately not one: `settled` is the executor's
 * answer, `closed` is a runtime declaring the answer will never come.
 */
export type JobRecord = JobStartedRecord | JobSettledRecord | JobClosedRecord;

export type JobHistoryState = "open" | "settled" | "closed";

/** One job, reduced from every record on the chain that named it. */
export interface JobHistoryEntry {
	readonly toolCallId: string;
	readonly jobId: string;
	readonly ownerAgentId: string;
	readonly sessionId: string;
	readonly toolName: string;
	readonly name?: string;
	readonly description?: string;
	readonly origin: BackgroundJobOrigin;
	readonly startedAt: number;
	readonly backgroundedAt: number;
	readonly outputFile: string;
	readonly state: JobHistoryState;
	/** Present only for `settled`: the executor's own outcome. */
	readonly status?: BackgroundJobStatus;
	/** Present only for `closed`: who declared it over and why. */
	readonly cause?: JobCloseCause;
	readonly stopReason?: string;
	readonly endedAt?: number;
	readonly messageText?: string;
	readonly outputTail?: string;
}

/** What one state root resolves to. */
export interface JobHistory {
	/** Oldest job first, by when it entered the background. */
	readonly jobs: readonly JobHistoryEntry[];
	/** The walk stopped before the chain's first record. */
	readonly truncated: boolean;
}

export interface JobClosurePlanRequest {
	readonly jobs: readonly JobHistoryEntry[];
	/** Tool call ids this runtime still holds an executor for. */
	readonly recognized: ReadonlySet<string>;
	readonly cause: JobCloseCause;
	readonly closedAt: number;
	readonly stopReason?: string;
}

/**
 * The branch, as this namespace is allowed to see it. Already scoped to one
 * agent and to `core:jobs`, so neither appears in a signature.
 */
export interface JobBranchPort {
	/** This namespace's state on the branch; undefined when it names none. */
	projection(): Promise<NamespaceProjection | undefined>;
	/** Ask the branch's owner to record this root. The object must be durable. */
	commit(stateRoot: string | null): Promise<void>;
}

export interface SessionJobStoreOptions {
	readonly storage: JobHistoryStorage;
	readonly branch: JobBranchPort;
}

export interface JobSealRequest {
	readonly cause: JobCloseCause;
	/** Tool call ids this runtime still holds an executor for. */
	readonly recognized: ReadonlySet<string>;
	readonly stopReason?: string;
	readonly closedAt?: number;
}

/**
 * Cap on the stored t1 text of a settled job: 64 KiB. The text may be replayed
 * into a session, so it is bounded by what is reasonable to re-inject rather
 * than by what the tool produced.
 */
export const MAX_PERSISTED_JOB_MESSAGE_BYTES = 64 * 1024;

/** Cap on the stored final output tail of a settled job: 32 KiB. */
export const MAX_PERSISTED_JOB_OUTPUT_BYTES = 32 * 1024;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** A settled job's t1, ready to be handed to the owner's input path. */
export interface BackgroundJobDelivery {
	readonly ownerAgentId: string;
	readonly jobId: string;
	/** The rendered t1 text; the runtime owns the wording. */
	readonly body: string;
}

/**
 * What the host says about an accepted delivery. `entryId` is the provisioned
 * id of the queued entry - the thing that would turn "was this t1 delivered?"
 * from a text search into an existence check. Nothing produces or reads it yet;
 * it is declared so the day the input path can provision one, no shape changes.
 */
export interface BackgroundJobDeliveryReceipt {
	readonly entryId?: string;
}

/**
 * Everything the runtime needs from outside itself - and nothing more. There is
 * no port for "is this agent reachable" on purpose: the runtime asks for a
 * delivery and the host decides.
 */
export interface BackgroundJobRuntimePorts {
	/**
	 * Open the owner's job history, or resolve undefined for an agent with no
	 * session directory. Creates nothing eagerly.
	 */
	openOwnerStore(owner: {
		readonly agentId: string;
		readonly sessionId: string;
	}): Promise<SessionJobStore | undefined>;
	/**
	 * Hand a settled job's text to its owner. Delivery policy - interception,
	 * merging, prompt versus steer - belongs to the host; the runtime only says
	 * that this owner has a result to read.
	 */
	deliverResult(
		delivery: BackgroundJobDelivery,
	): Promise<BackgroundJobDeliveryReceipt>;
	publish(event: BackgroundJobEvent): Promise<void>;
	/** Report a fact without depending on whoever collects it. */
	diagnose(diagnostic: CoreDiagnostic): Promise<void>;
}

/** Default minimum spacing between a job's progress emissions: 100 ms. */
export const DEFAULT_BACKGROUND_JOB_PROGRESS_THROTTLE_MS = 100;

/** Default minimum spacing between structured report emissions: 100 ms. */
export const DEFAULT_BACKGROUND_JOB_REPORT_THROTTLE_MS = 100;

export interface BackgroundJobRuntimeOptions {
	/** Injectable id factory. Defaults to a runtime-wide `job-N` counter. */
	readonly createJobId?: () => string;
	readonly progressThrottleMs?: number;
	readonly reportThrottleMs?: number;
	/**
	 * Cooperative ceiling on bytes streamed through a job's output; 0 disables
	 * it. It requests termination of a runaway producer and does not cap the
	 * tool's eventual result.
	 */
	readonly outputCeilingBytes?: number;
	/** Cap on a job's unforwarded progress-increment buffer. */
	readonly incrementMaxBytes?: number;
}
