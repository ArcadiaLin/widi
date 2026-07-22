import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentProfile } from "./agent-profile.js";
import type {
	BackgroundJobSnapshot,
	BackgroundJobTransition,
} from "./background-job.ts";
import type { OrchestratorDiagnostic } from "./diagnostics.ts";
import type {
	ExtensionMessage,
	ExtensionStatus,
} from "./extension/presentation.ts";
import type { HumanRequestEvent } from "./human-request.ts";

export type RuntimeModel = Model<Api>;

/** Runtime-local agent identity allocated by the orchestrator. */
export type AgentId = string;

export type AgentLifecycleStatus =
	| "creating"
	| "running"
	| "idle"
	| "unavailable"
	| "disposed";

export interface AgentToolsSnapshot {
	readonly toolNames: string[];
	readonly activeToolNames: string[];
}

export type OrchestratorEvent =
	| {
			readonly type: "agent_harness_event";
			agentId: AgentId;
			event: AgentHarnessEvent;
	  }
	| {
			readonly type: "agent_status_changed";
			agentId: AgentId;
			previousStatus?: AgentLifecycleStatus;
			status: AgentLifecycleStatus;
			changedAt: string;
	  }
	// Input interception facts (ME slice 6): the model-facing text can differ
	// from the human original, so both are published with extension attribution.
	| {
			readonly type: "input_transformed";
			agentId: AgentId;
			inputId: string;
			originalText: string;
			text: string;
			// Extensions that returned a rewrite, in application order.
			transformedBy: readonly string[];
			createdAt: string;
	  }
	| {
			readonly type: "input_blocked";
			agentId: AgentId;
			inputId: string;
			originalText: string;
			reason?: string;
			// The extension whose handler ended the pipeline - a deliberate
			// block, or a crash blocked fail-closed (the extension.handler_failed
			// diagnostic tells the two apart).
			blockedBy: string;
			createdAt: string;
	  }
	// Append-only plain text an extension pushes for direct client display.
	// It is ephemeral: not persisted, not added to model context, and never
	// fed back to extension observers.
	| {
			readonly type: "extension_output";
			// Core-generated stable identity: consumers use it as the output
			// item's view key and for RPC/log correlation.
			presentationId: string;
			agentId: AgentId;
			extensionId: string;
			text: string;
			createdAt: string;
	  }
	// Transient info-only notice. Consumers choose its display lifetime; it
	// does not imply severity, attention, persistence, dedupe, or clear.
	| {
			readonly type: "extension_notification";
			presentationId: string;
			agentId: AgentId;
			extensionId: string;
			text: string;
			createdAt: string;
	  }
	| {
			readonly type: "extension_status_changed";
			presentationId: string;
			agentId: AgentId;
			extensionId: string;
			key: string;
			// Absent means the keyed status was cleared.
			status?: ExtensionStatus;
			changedAt: string;
	  }
	| {
			readonly type: "extension_message_published";
			presentationId: string;
			// Session custom entry id: the stable identity consumers use to
			// dedupe between this live event and hydration.
			entryId: string;
			agentId: AgentId;
			extensionId: string;
			message: ExtensionMessage;
			createdAt: string;
	  }
	| HumanRequestEvent
	// OAuth login flow facts. The URL and device code must reach the human
	// even when the flow completes through a local callback server without
	// further input, so they are broadcast facts, not human requests. agentId
	// is the agent whose surface initiated the login, for display attribution.
	| {
			readonly type: "auth_login_url";
			providerId: string;
			agentId?: AgentId;
			url: string;
			instructions?: string;
			createdAt: string;
	  }
	| {
			readonly type: "auth_login_code";
			providerId: string;
			agentId?: AgentId;
			userCode: string;
			verificationUri: string;
			createdAt: string;
	  }
	| {
			readonly type: "auth_login_progress";
			providerId: string;
			agentId?: AgentId;
			message: string;
			createdAt: string;
	  }
	| {
			readonly type: "diagnostic";
			diagnostic: OrchestratorDiagnostic;
			createdAt: string;
	  }
	| {
			readonly type: "agent_spawned";
			agentId: AgentId;
			profile: AgentProfile;
			model: RuntimeModel;
	  }
	| {
			readonly type: "agent_resumed";
			agentId: AgentId;
			profile: AgentProfile;
			model: RuntimeModel;
	  }
	| {
			readonly type: "agent_session_info_changed";
			agentId: AgentId;
			name?: string;
			changedAt: string;
	  }
	| {
			readonly type: "agent_session_forked";
			agentId: AgentId;
			forkedSessionId: string;
			entryId?: string;
			createdAt: string;
	  }
	// Per-job lifecycle fact for the agent's pseudo-async background jobs,
	// emitted for every observable transition (backgrounded at t0, an abort
	// request, settlement). The job is an immutable snapshot, not the live
	// table view; output content is not carried here - surfaces pull it via
	// `readAgentBackgroundJobOutput`. `liveCount` is the number of live
	// backgrounded jobs after this change, so count displays need no job
	// bookkeeping of their own.
	| {
			readonly type: "agent_background_job_changed";
			agentId: AgentId;
			job: BackgroundJobSnapshot;
			transition: BackgroundJobTransition;
			liveCount: number;
			changedAt: string;
	  };

export type OrchestratorEventListener = (
	event: OrchestratorEvent,
) => Promise<void> | void;

/** A completion candidate returned by orchestrator list methods. */
export interface CandidateItem {
	readonly value: string;
	readonly label?: string;
	readonly description?: string;
}

/** Result of promptAgent: the prompt completed or an interceptor blocked it. */
export type PromptOutcome =
	| { readonly kind: "completed"; readonly message: AssistantMessage }
	| {
			readonly kind: "blocked";
			readonly inputId: string;
			readonly reason?: string;
			readonly blockedBy: string;
	  };

/**
 * Pre-expansion record of an interaction-layer inline expansion, persisted
 * by promptAgent as a core:command_expansion session entry (format unchanged).
 */
export interface PromptExpansion {
	readonly originalText: string;
	readonly items: ReadonlyArray<{
		readonly commandId: string;
		readonly name: string;
		readonly trigger: string;
		readonly argument: string;
		readonly start: number;
		readonly end: number;
	}>;
}
