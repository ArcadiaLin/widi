import type {
	AbortResult,
	CompactResult,
	NavigateTreeResult,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
} from "@earendil-works/pi-ai";
import type {
	AgentLifecycleStatus,
	AgentRecordSnapshot,
} from "../agent-orchestrator.ts";
import type { OrchestratorDiagnostic } from "../diagnostics.ts";
import type { ExtensionIdentity } from "../extension/index.ts";
import type { HumanRequestDraft, HumanResponse } from "../human-request.ts";
import type {
	AgentSessionCandidate,
	AgentSessionSnapshot,
	AgentSessionTreeSnapshot,
	ForkAgentSessionOptions,
} from "../session-manager.ts";

export type {
	AgentSessionCandidate,
	AgentSessionSnapshot,
	AgentSessionTreeSnapshot,
	ForkAgentSessionOptions,
} from "../session-manager.ts";

export type RuntimeModel = Model<Api>;

export interface AgentToolsSnapshot {
	toolNames: string[];
	activeToolNames: string[];
}

export interface AgentSessionCommandResult {
	readonly agentId: string;
	readonly snapshot: AgentRecordSnapshot;
}

export interface AgentSessionListResult {
	readonly sessions: readonly AgentSessionCandidate[];
}

export interface AgentListResult {
	readonly agents: readonly AgentRecordSnapshot[];
}

export interface CommandInputInvoke {
	readonly name: string;
	readonly description?: string;
	readonly argumentHint?: string;
}

export type BuiltinInputCommandKind =
	| "agent.abort"
	| "agent.compact"
	| "agent.followUp"
	| "agent.fork"
	| "agent.getSessionTree"
	| "agent.inspect"
	| "agent.listAgents"
	| "agent.listSessions"
	| "agent.new"
	| "agent.resume"
	| "agent.setSessionName"
	| "agent.getStatus"
	| "agent.steer"
	| "extension.reload";

export interface BuiltinInputCommandDefinition {
	readonly kind: BuiltinInputCommandKind;
	readonly inputInvoke: CommandInputInvoke;
}

export type InputCommandSource =
	| { readonly kind: "builtin"; readonly commandKind: BuiltinInputCommandKind }
	| { readonly kind: "extension"; readonly extensionId: string };

export interface InputCommandInfo {
	readonly inputInvoke: CommandInputInvoke;
	readonly source: InputCommandSource;
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
	agentId: string;
	status: ExtensionReloadAgentStatus;
	reason?: ExtensionReloadAgentSkipReason;
	diagnostics: readonly OrchestratorDiagnostic[];
	before?: AgentRecordSnapshot;
	after?: AgentRecordSnapshot;
}

export interface ExtensionReloadResult {
	catalog: {
		loaded: readonly ExtensionIdentity[];
		diagnostics: readonly OrchestratorDiagnostic[];
	};
	agents: readonly ExtensionReloadAgentResult[];
}

export type OperationSource =
	| { kind: "human"; adapterId?: string }
	| { kind: "agent"; agentId: string }
	| { kind: "extension"; extensionId: string }
	| { kind: "tool"; agentId: string; toolCallId: string; toolName: string }
	| { kind: "system" }
	| { kind: "external"; id: string };

interface CommandBase {
	id?: string;
	source: OperationSource;
}

export type CommandRequest =
	| (CommandBase & {
			kind: "agent.input";
			agentId: string;
			text: string;
			images?: ImageContent[];
			inputInvoke?: boolean;
	  })
	| (CommandBase & {
			kind: "agent.prompt";
			agentId: string;
			text: string;
			images?: ImageContent[];
	  })
	| (CommandBase & {
			kind: "agent.steer";
			agentId: string;
			text: string;
			images?: ImageContent[];
	  })
	| (CommandBase & {
			kind: "agent.followUp";
			agentId: string;
			text: string;
			images?: ImageContent[];
	  })
	| (CommandBase & {
			kind: "agent.nextTurn";
			agentId: string;
			text: string;
			images?: ImageContent[];
	  })
	| (CommandBase & { kind: "agent.abort"; agentId: string })
	| (CommandBase & { kind: "agent.new"; agentId: string })
	| (CommandBase & { kind: "agent.listAgents" })
	| (CommandBase & { kind: "agent.listSessions" })
	| (CommandBase & { kind: "agent.resume"; reference: string })
	| (CommandBase & { kind: "agent.getSession"; agentId: string })
	| (CommandBase & { kind: "agent.getSessionTree"; agentId: string })
	| (CommandBase & {
			kind: "agent.setSessionName";
			agentId: string;
			name: string;
	  })
	| (CommandBase & {
			kind: "agent.fork";
			agentId: string;
			options?: ForkAgentSessionOptions;
	  })
	| (CommandBase & {
			kind: "agent.compact";
			agentId: string;
			customInstructions?: string;
	  })
	| (CommandBase & {
			kind: "agent.navigateTree";
			agentId: string;
			targetId: string;
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
	  })
	| (CommandBase & { kind: "agent.getModel"; agentId: string })
	| (CommandBase & {
			kind: "agent.setModel";
			agentId: string;
			model: RuntimeModel;
	  })
	| (CommandBase & { kind: "agent.getTools"; agentId: string })
	| (CommandBase & {
			kind: "agent.setTools";
			agentId: string;
			toolNames: string[];
			activeToolNames?: string[];
	  })
	| (CommandBase & {
			kind: "agent.getActiveTools";
			agentId: string;
	  })
	| (CommandBase & {
			kind: "agent.getInputCommands";
			agentId: string;
	  })
	| (CommandBase & {
			kind: "agent.setActiveTools";
			agentId: string;
			toolNames: string[];
	  })
	| (CommandBase & { kind: "agent.getStatus"; agentId: string })
	| (CommandBase & { kind: "agent.inspect"; agentId: string })
	| (CommandBase & {
			kind: "agent.dispose";
			agentId: string;
			reason?: string;
	  })
	| (CommandBase & {
			kind: "extension.reload";
			agentIds?: readonly string[];
	  })
	| (CommandBase & {
			kind: "human.request";
			request: HumanRequestDraft;
	  });

export type CommandValue =
	| AssistantMessage
	| AbortResult
	| CompactResult
	| NavigateTreeResult
	| RuntimeModel
	| AgentToolsSnapshot
	| AgentSessionCommandResult
	| AgentSessionListResult
	| AgentListResult
	| AgentSessionSnapshot
	| AgentSessionTreeSnapshot
	| ExtensionReloadResult
	| AgentLifecycleStatus
	| AgentRecordSnapshot
	| InputCommandInfo[]
	| string[]
	| HumanResponse
	| undefined;

export type CommandResult =
	| { ok: true; commandId: string; value: CommandValue }
	| { ok: false; commandId: string; diagnostic: OrchestratorDiagnostic };

export type OrchestratorCommand = CommandRequest;
export type OrchestratorCommandValue = CommandValue;
export type OrchestratorCommandResult = CommandResult;
