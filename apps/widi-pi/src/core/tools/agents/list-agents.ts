import { Type } from "typebox";
import type { AgentBrief } from "../../orchestrator/host.ts";
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
 * Disposed agents are omitted entirely. An `unavailable` one is listed but
 * marked unaddressable, so the model stops re-sending to a broken agent instead
 * of concluding it vanished.
 */
export function createListAgentsToolDefinition(): ToolDefinition<typeof listAgentsSchema, ListAgentsDetails> {
	return {
		name: "list_agents",
		label: "list_agents",
		description:
			"List the non-disposed agents in your agent tree, with their profile, status, and whether they can still be given work. It does not enumerate other trees. You may still use send_message with an exact cross-tree agent id that was shared with you. It does not report what each agent is working on; ask the agent itself.",
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
		const notes = [
			agent.agentId === callerAgentId ? "you" : undefined,
			agent.addressable ? undefined : "not addressable",
		].filter((note) => note !== undefined);
		const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
		return `- ${agent.agentId} [profile ${agent.profileId}] ${agent.status}${suffix}`;
	});
	return `Live agents in your tree:\n${lines.join("\n")}`;
}
