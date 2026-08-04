import { Type } from "typebox";
import type { AgentBrief } from "../../host.ts";
import type { ToolDefinition } from "../types.ts";
import { requireAgentHost } from "./shared.ts";

const listAgentsSchema = Type.Object({});

export interface ListAgentsDetails {
	readonly callerAgentId: string;
	readonly agents: readonly AgentBrief[];
}

/**
 * Tree-scoped discovery. Any agent holding `send_message` can talk to any
 * runtime-local agent id it already knows, including one in another tree; this
 * tool only enumerates the caller's own tree. Cross-tree communication starts
 * when a human, another agent, or an incoming message shares an exact id.
 *
 * Only live agents are listed: an agent that is gone has left the registry, and
 * every id listed here can be given work.
 */
export function createListAgentsToolDefinition(): ToolDefinition<typeof listAgentsSchema, ListAgentsDetails> {
	return {
		name: "list_agents",
		label: "list_agents",
		description:
			"List the live agents in your agent tree, with their profile and whether each is idle or running. It does not enumerate other trees. You may still use send_message with an exact cross-tree agent id that was shared with you. It does not report what each agent is working on; ask the agent itself.",
		promptSnippet: "List the live agents in your tree and their status",
		parameters: listAgentsSchema,
		execute: async (_toolCallId, _params, context) => {
			const host = requireAgentHost(context);
			const agents = host.listAgents();
			return {
				content: [{ type: "text", text: formatAgents(agents, host.agentId) }],
				details: { callerAgentId: host.agentId, agents },
			};
		},
	};
}

function formatAgents(agents: readonly AgentBrief[], callerAgentId: string): string {
	if (agents.length === 0) {
		return "No agent is currently live in your tree.";
	}
	const lines = agents.map((agent) => {
		const suffix = agent.agentId === callerAgentId ? " (you)" : "";
		return `- ${agent.agentId} [profile ${agent.profileId}] ${agent.activity}${suffix}`;
	});
	return `Live agents in your tree:\n${lines.join("\n")}`;
}
