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
import type { HumanRequestDraft, HumanResponse } from "./human-request.ts";

export type RuntimeModel = Model<Api>;

export interface AgentToolsSnapshot {
	toolNames: string[];
	activeToolNames: string[];
}

export interface CommandInputInvoke {
	readonly name: string;
	readonly description?: string;
	readonly argumentHint?: string;
}

export type BuiltinInputCommandKind =
	| "agent.abort"
	| "agent.compact"
	| "agent.inspect"
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

export const builtinInputCommands = [
	{
		kind: "agent.abort",
		inputInvoke: {
			name: "abort",
			description: "Abort the current agent run.",
		},
	},
	{
		kind: "agent.compact",
		inputInvoke: {
			name: "compact",
			description: "Compact the current agent session.",
			argumentHint: "[instructions]",
		},
	},
	{
		kind: "agent.inspect",
		inputInvoke: {
			name: "inspect",
			description: "Inspect the current agent runtime facts.",
		},
	},
	{
		kind: "extension.reload",
		inputInvoke: {
			name: "reload",
			description: "Reload extensions for the current agent.",
		},
	},
] as const satisfies readonly BuiltinInputCommandDefinition[];

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

interface OrchestratorCommandBase {
	id?: string;
	source: OperationSource;
}

export type OrchestratorCommand =
	| (OrchestratorCommandBase & {
			kind: "agent.input";
			agentId: string;
			text: string;
			images?: ImageContent[];
			inputInvoke?: boolean;
	  })
	| (OrchestratorCommandBase & {
			kind: "agent.prompt";
			agentId: string;
			text: string;
			images?: ImageContent[];
	  })
	| (OrchestratorCommandBase & {
			kind: "agent.steer";
			agentId: string;
			text: string;
			images?: ImageContent[];
	  })
	| (OrchestratorCommandBase & {
			kind: "agent.followUp";
			agentId: string;
			text: string;
			images?: ImageContent[];
	  })
	| (OrchestratorCommandBase & {
			kind: "agent.nextTurn";
			agentId: string;
			text: string;
			images?: ImageContent[];
	  })
	| (OrchestratorCommandBase & { kind: "agent.abort"; agentId: string })
	| (OrchestratorCommandBase & {
			kind: "agent.compact";
			agentId: string;
			customInstructions?: string;
	  })
	| (OrchestratorCommandBase & {
			kind: "agent.navigateTree";
			agentId: string;
			targetId: string;
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
	  })
	| (OrchestratorCommandBase & { kind: "agent.getModel"; agentId: string })
	| (OrchestratorCommandBase & {
			kind: "agent.setModel";
			agentId: string;
			model: RuntimeModel;
	  })
	| (OrchestratorCommandBase & { kind: "agent.getTools"; agentId: string })
	| (OrchestratorCommandBase & {
			kind: "agent.setTools";
			agentId: string;
			toolNames: string[];
			activeToolNames?: string[];
	  })
	| (OrchestratorCommandBase & {
			kind: "agent.getActiveTools";
			agentId: string;
	  })
	| (OrchestratorCommandBase & {
			kind: "agent.getInputCommands";
			agentId: string;
	  })
	| (OrchestratorCommandBase & {
			kind: "agent.setActiveTools";
			agentId: string;
			toolNames: string[];
	  })
	| (OrchestratorCommandBase & { kind: "agent.getStatus"; agentId: string })
	| (OrchestratorCommandBase & { kind: "agent.inspect"; agentId: string })
	| (OrchestratorCommandBase & {
			kind: "agent.dispose";
			agentId: string;
			reason?: string;
	  })
	| (OrchestratorCommandBase & {
			kind: "extension.reload";
			agentIds?: readonly string[];
	  })
	| (OrchestratorCommandBase & {
			kind: "human.request";
			request: HumanRequestDraft;
	  });

export type OrchestratorCommandValue =
	| AssistantMessage
	| AbortResult
	| CompactResult
	| NavigateTreeResult
	| RuntimeModel
	| AgentToolsSnapshot
	| ExtensionReloadResult
	| AgentLifecycleStatus
	| AgentRecordSnapshot
	| InputCommandInfo[]
	| string[]
	| HumanResponse
	| undefined;

export type OrchestratorCommandResult =
	| { ok: true; commandId: string; value: OrchestratorCommandValue }
	| { ok: false; commandId: string; diagnostic: OrchestratorDiagnostic };
