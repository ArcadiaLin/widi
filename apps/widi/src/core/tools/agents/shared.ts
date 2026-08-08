import type { AgentBrief, AgentToOrchestratorHost } from "../../host.ts";
import type { ToolExecutionContext } from "../types.ts";

export function requireAgentHost<TDetails>(context: ToolExecutionContext<TDetails>): AgentToOrchestratorHost {
	const host = context.agents;
	if (!host) {
		throw new Error("Agent collaboration is not available in this runtime, so there are no other agents to work with.");
	}
	return host;
}

/**
 * Resolve a target the caller named. `describe` answers from the live registry
 * only, so a hit is the whole addressability question: an agent that is being
 * torn down has already left it, and work handed to one there would be accepted
 * after the sweep that was supposed to cancel it.
 */
export function requireAddressableAgent(host: AgentToOrchestratorHost, agentId: string): AgentBrief {
	const brief = host.describe(agentId);
	if (!brief) {
		throw new Error(
			`Unknown agent: ${agentId}. list_agents discovers your own tree; a cross-tree target requires an exact id shared with you.`,
		);
	}
	return brief;
}
