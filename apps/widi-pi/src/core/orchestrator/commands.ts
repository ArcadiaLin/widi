import type {
	AbortResult,
	AgentTool,
	CompactResult,
	NavigateTreeResult,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
} from "@earendil-works/pi-ai";
import type { OrchestratorDiagnostic } from "../diagnostics.ts";
import type { HumanRequestDraft, HumanResponse } from "./human-request.ts";

export type RuntimeModel = Model<Api>;

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
			tools: AgentTool[];
			activeToolNames?: string[];
	  })
	| (OrchestratorCommandBase & {
			kind: "agent.getActiveTools";
			agentId: string;
	  })
	| (OrchestratorCommandBase & {
			kind: "agent.setActiveTools";
			agentId: string;
			toolNames: string[];
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
	| AgentTool[]
	| HumanResponse
	| undefined;

export type OrchestratorCommandResult =
	| { ok: true; commandId: string; value: OrchestratorCommandValue }
	| { ok: false; commandId: string; diagnostic: OrchestratorDiagnostic };
