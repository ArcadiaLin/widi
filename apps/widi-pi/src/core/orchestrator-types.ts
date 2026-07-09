/**
 * Public orchestrator contract types.
 *
 * The AgentOrchestrator class re-exports these so its consumers keep a single
 * import site; this module exists so the contract can be read (and imported by
 * other core modules) without pulling in the orchestrator implementation.
 */

import type {
	AgentHarness,
	AgentHarnessEvent,
	ExecutionEnv,
	JsonlSessionMetadata,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
	AgentProfile,
	AgentProfileCommandPolicy,
	AgentProfileOverride,
	AgentProfileReference,
	AgentProfileRegistry,
	AgentProfileSource,
} from "./agent-profile.js";
import type { CommandCandidate, CommandInvocation } from "./command.ts";
import type { OrchestratorDiagnostic } from "./diagnostics.ts";
import type {
	ExtensionIdentity,
	ExtensionLoader,
	ExtensionRunner,
	ExtensionRunnerSnapshot,
} from "./extension/index.ts";
import type { HumanRequestEnvelope, HumanResponse } from "./human-request.ts";
import type { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import type {
	AgentId,
	AgentLifecycleStatus,
	AgentToolsSnapshot,
	RuntimeModel,
} from "./runtime-types.ts";
import type {
	AgentSessionCandidate,
	AgentSessionMetadata,
	SessionManager,
} from "./session-manager.ts";
import type { SettingManager } from "./setting-manager.js";
import type { ToolRegistry } from "./tool-registry.ts";
import type { ToolLifecycleEvent } from "./tools/types.ts";

export type OrchestratorEvent =
	| {
			readonly type: "agent_harness_event";
			agentId: AgentId;
			event: AgentHarnessEvent;
	  }
	| {
			readonly type: "tool_lifecycle_event";
			agentId: AgentId;
			event: ToolLifecycleEvent;
	  }
	| {
			readonly type: "command_detected";
			commandId: string;
			command: CommandInvocation;
			// Correlates the inline expansions of one input; absent on line commands.
			inputId?: string;
			createdAt: string;
	  }
	| {
			readonly type: "command_accepted";
			commandId: string;
			command: CommandInvocation;
			inputId?: string;
			createdAt: string;
	  }
	| {
			readonly type: "command_completed";
			commandId: string;
			command: CommandInvocation;
			result: unknown;
			inputId?: string;
			completedAt: string;
	  }
	| {
			readonly type: "command_failed";
			commandId: string;
			command: CommandInvocation;
			diagnostic: OrchestratorDiagnostic;
			inputId?: string;
			completedAt: string;
	  }
	| {
			readonly type: "command_rejected";
			commandId: string;
			command?: CommandInvocation;
			diagnostic: OrchestratorDiagnostic;
			inputId?: string;
			completedAt: string;
	  }
	| {
			readonly type: "human_request_pending";
			request: HumanRequestEnvelope;
	  }
	| {
			readonly type: "human_request_resolved";
			requestId: string;
			response: HumanResponse;
			completedAt: string;
	  }
	| {
			readonly type: "human_request_timeout";
			requestId: string;
			completedAt: string;
	  }
	| {
			readonly type: "human_request_cancelled";
			requestId: string;
			reason?: string;
			completedAt: string;
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
	  };

export type OrchestratorEventListener = (
	event: OrchestratorEvent,
) => Promise<void> | void;

export interface AgentOrchestratorConfigs {
	executionEnv: ExecutionEnv;
	resourceLoader: ResourceLoader;
	sessionManager: SessionManager;
	settingManager: SettingManager;
	modelRegistry: ModelRegistry;
	profileRegistry: AgentProfileRegistry;
	toolRegistry?: ToolRegistry;
	extensionLoader?: ExtensionLoader;
	defaultProfileId: string;
	enabledProfileIds?: readonly string[];
	defaultModel: RuntimeModel;
	defaultThinkingLevel?: ThinkingLevel;
}

export interface AgentProfileRecordReference {
	readonly reference: AgentProfileReference;
	readonly source?: AgentProfileSource;
	readonly entryId?: string;
}

export interface AgentRecord {
	readonly agentId: AgentId;
	status: AgentLifecycleStatus;
	readonly profile: AgentProfileRecordReference;
	// Command gating facts snapshotted from the resolved profile.
	readonly capabilities?: AgentProfile["capabilities"];
	readonly commandPolicy?: AgentProfileCommandPolicy;
	sessionMetadata?: AgentSessionMetadata;
	model: RuntimeModel;
	harness?: AgentHarness;
	toolSnapshot?: AgentToolsSnapshot;
	extensionRunner?: ExtensionRunner;
	resourceDiagnostics: OrchestratorDiagnostic[];
	extensionDiagnostics: OrchestratorDiagnostic[];
	diagnostics: OrchestratorDiagnostic[];
}

export interface AgentRecordSnapshot {
	readonly agentId: AgentId;
	readonly status: AgentLifecycleStatus;
	readonly profile: AgentProfileRecordReference;
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly model: RuntimeModel;
	readonly hasHarness: boolean;
	readonly toolSnapshot?: AgentToolsSnapshot;
	readonly extensionIds: readonly string[];
	readonly extensions: readonly ExtensionIdentity[];
	readonly extensionSnapshot: ExtensionRunnerSnapshot;
	readonly resourceDiagnostics: readonly OrchestratorDiagnostic[];
	readonly extensionDiagnostics: readonly OrchestratorDiagnostic[];
	readonly diagnostics: readonly OrchestratorDiagnostic[];
}

export interface AgentSessionCommandResult {
	readonly agentId: AgentId;
	readonly snapshot: AgentRecordSnapshot;
}

export interface AgentSessionListResult {
	readonly sessions: readonly AgentSessionCandidate[];
}

export interface AgentListResult {
	readonly agents: readonly AgentRecordSnapshot[];
}

export interface AgentModelCandidateListResult {
	readonly models: readonly CommandCandidate[];
}

export interface AgentThinkingLevelCandidateListResult {
	readonly levels: readonly CommandCandidate[];
}

export interface AgentPromptTemplateCandidateListResult {
	readonly templates: readonly CommandCandidate[];
}

export interface AgentSkillCandidateListResult {
	readonly skills: readonly CommandCandidate[];
}

export interface AgentThinkingLevelCommandResult {
	readonly level: ThinkingLevel;
}

export type ExtensionReloadAgentStatus = "reloaded" | "skipped" | "failed";

export type ExtensionReloadAgentSkipReason =
	| "creating"
	| "running"
	| "disposed"
	| "unavailable"
	| "missing_harness"
	| "unknown_agent";

export interface ExtensionReloadAgentResult {
	readonly agentId: string;
	readonly status: ExtensionReloadAgentStatus;
	readonly reason?: ExtensionReloadAgentSkipReason;
	readonly diagnostics: readonly OrchestratorDiagnostic[];
	readonly before?: AgentRecordSnapshot;
	readonly after?: AgentRecordSnapshot;
}

export interface ExtensionReloadResult {
	readonly catalog: {
		readonly loaded: readonly ExtensionIdentity[];
		readonly diagnostics: readonly OrchestratorDiagnostic[];
	};
	readonly agents: readonly ExtensionReloadAgentResult[];
}

interface SpawnAgentHarnessCommonOptions {
	model?: RuntimeModel;
	inheritModelFromAgentId?: AgentId;
	thinkingLevel?: ThinkingLevel;
}

export interface SpawnAgentHarnessCreateOptions
	extends SpawnAgentHarnessCommonOptions {
	resume?: false;
	profileId?: string;
	profileOverride?: AgentProfileOverride;
}

export interface SpawnAgentHarnessResumeOptions
	extends SpawnAgentHarnessCommonOptions {
	resume: true;
	metadata: JsonlSessionMetadata;
}

export type SpawnAgentHarnessOptions =
	| SpawnAgentHarnessCreateOptions
	| SpawnAgentHarnessResumeOptions;

export interface SpawnAgentHarnessResult {
	agentId: AgentId;
	harness: AgentHarness;
}
