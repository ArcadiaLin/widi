import { Type } from "typebox";
import type { AgentBrief } from "../../agent-host.ts";
import type { ToolDefinition } from "../types.ts";
import { requireAgentHost } from "./shared.ts";

const listAgentsSchema = Type.Object({});

export interface ListAgentsDetails {
	readonly callerAgentId: string;
	readonly agents: readonly AgentBrief[];
}

/**
 * The discovery half of addressing. Any agent holding `send_message` can talk
 * to any live agent id it knows; this tool is what turns "knows" from "was told
 * an id" into "can enumerate everyone", which is why granting it is a profile
 * decision rather than a core default.
 *
 * Disposed agents are omitted entirely. An `unavailable` one is listed but
 * marked unaddressable, so the model stops re-sending to a broken agent instead
 * of concluding it vanished.
 */
export function createListAgentsToolDefinition(): ToolDefinition<
	typeof listAgentsSchema,
	ListAgentsDetails
> {
	return {
		name: "list_agents",
		label: "list_agents",
		description:
			"List the agents that currently exist, with their profile, status, and whether they can still be given work. Use it to find the agent id to pass to send_message or dispose_agent. It does not report what each agent is working on; ask the agent itself.",
		promptSnippet: "List the live agents and their status",
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

function formatAgents(
	agents: readonly AgentBrief[],
	callerAgentId: string,
): string {
	if (agents.length === 0) {
		return "No agent is currently live.";
	}
	const lines = agents.map((agent) => {
		const notes = [
			agent.agentId === callerAgentId ? "you" : undefined,
			agent.addressable ? undefined : "not addressable",
		].filter((note) => note !== undefined);
		const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
		return `- ${agent.agentId} [profile ${agent.profileId}] ${agent.status}${suffix}`;
	});
	return `Live agents:\n${lines.join("\n")}`;
}
