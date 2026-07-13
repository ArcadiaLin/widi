import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentProfile } from "./agent-profile.js";
import type { CommandInvocation } from "./command.ts";
import type { OrchestratorDiagnostic } from "./diagnostics.ts";
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
			readonly type: "command_detected";
			agentId: AgentId;
			commandId: string;
			command: CommandInvocation;
			// Correlates the inline expansions of one input; absent on line commands.
			inputId?: string;
			createdAt: string;
	  }
	| {
			readonly type: "command_accepted";
			agentId: AgentId;
			commandId: string;
			command: CommandInvocation;
			inputId?: string;
			createdAt: string;
	  }
	| {
			readonly type: "command_completed";
			agentId: AgentId;
			commandId: string;
			command: CommandInvocation;
			result: unknown;
			inputId?: string;
			completedAt: string;
	  }
	| {
			readonly type: "command_failed";
			agentId: AgentId;
			commandId: string;
			command: CommandInvocation;
			diagnostic: OrchestratorDiagnostic;
			inputId?: string;
			completedAt: string;
	  }
	| {
			readonly type: "command_rejected";
			agentId: AgentId;
			commandId: string;
			command?: CommandInvocation;
			diagnostic: OrchestratorDiagnostic;
			inputId?: string;
			completedAt: string;
	  }
	// Input interception facts (ME slice 6): the model-facing text can differ
	// from the human original, so both are published with extension attribution.
	| {
			readonly type: "input_transformed";
			agentId: AgentId;
			// Shared with the command events of the same input (inline expansion).
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
	| HumanRequestEvent
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
	  };

export type OrchestratorEventListener = (
	event: OrchestratorEvent,
) => Promise<void> | void;
