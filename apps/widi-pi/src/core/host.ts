/**
 * Caller-bound collaboration capabilities exposed to agent tools.
 *
 * The caller identity is captured by the orchestrator. No model-controlled
 * argument can select the sender, task settler, or background-job owner.
 */

import type { BackgroundJobHost, BackgroundJobSettler } from "./background/index.ts";
import type { HumanRequestDraft, HumanResponse } from "./human-request.ts";
import type { MessageSendOutcome } from "./message.ts";
import type { AgentActivity, AgentId } from "./types.ts";

export interface AgentProfileBrief {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly whenToUse?: string;
	readonly persist: boolean;
}

/** Model-visible summary of one currently live agent. */
export interface AgentBrief {
	readonly agentId: AgentId;
	readonly profileId: string;
	readonly label?: string;
	readonly activity: AgentActivity;
}

export interface AgentTaskOutcome {
	readonly status: "completed" | "failed";
	readonly text: string;
}

export type AgentDisposeScope = "agent" | "subtree";

export interface AgentRequestedDisposeOptions {
	readonly scope: AgentDisposeScope;
	readonly reason: string;
}

export type AgentRequestedDisposeOutcome =
	| { readonly kind: "disposed"; readonly agentIds: readonly AgentId[] }
	| { readonly kind: "already_disposed" | "outside_tree" | "self" | "unknown" };

export interface ToolAgentHost {
	readonly agentId: AgentId;
	listProfiles(): Promise<readonly AgentProfileBrief[]>;
	listAgents(): readonly AgentBrief[];
	describe(agentId: AgentId): AgentBrief | undefined;
	spawn(profileId: string): Promise<AgentId>;
	sendMessage(targetAgentId: AgentId, body: string): Promise<MessageSendOutcome>;
	dispose(agentId: AgentId, options: AgentRequestedDisposeOptions): Promise<AgentRequestedDisposeOutcome>;
	readonly jobs: BackgroundJobHost;
	readonly settler: BackgroundJobSettler;
	requestHuman(request: HumanRequestDraft): Promise<HumanResponse>;
}

export const CORE_AGENT_TOOL_NAMES: readonly string[] = [
	"list_agent_profiles",
	"list_agents",
	"spawn_agent",
	"send_message",
	"dispose_agent",
];
