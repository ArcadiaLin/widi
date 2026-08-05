import { Type } from "typebox";
import type { AgentTreeEntry } from "../../host.ts";
import type { ToolDefinition } from "../types.ts";
import { requireAgentHost } from "./shared.ts";

const listAgentsSchema = Type.Object({});

export interface ListAgentsDetails {
	readonly callerAgentId: string;
	/** The tree roots; every other entry hangs under one of them. */
	readonly entries: readonly AgentTreeEntry[];
	/** Set when the closed sessions could not be read, leaving running agents only. */
	readonly closedUnavailable?: boolean;
}

/**
 * Tree-scoped discovery. Any agent holding `send_message` can talk to any
 * runtime-local agent id it already knows, including one in another tree; this
 * tool only enumerates the caller's own tree. Cross-tree communication starts
 * when a human, another agent, or an incoming message shares an exact id.
 *
 * Both live and closed agents are listed. A closed entry is a session directory
 * whose agent is not running - a subagent from an earlier run, or one disposed
 * in this one - and it is named by its session address, never by the AgentId it
 * used to hold: only a running entry can be given work.
 */
export function createListAgentsToolDefinition(): ToolDefinition<typeof listAgentsSchema, ListAgentsDetails> {
	return {
		name: "list_agents",
		label: "list_agents",
		description:
			"List your agent tree: the agents running now, and the sessions of agents that are no longer running, nested by which agent spawned which. It does not enumerate other trees. You may still use send_message with an exact cross-tree agent id that was shared with you. Only running agents can be messaged or disposed; a closed session is a record of past work, not an address. It does not report what each agent is working on; ask the agent itself.",
		promptSnippet: "List the agents in your tree and their status",
		parameters: listAgentsSchema,
		execute: async (_toolCallId, _params, context) => {
			const host = requireAgentHost(context);
			const listing = await host.listAgents();
			return {
				content: [{ type: "text", text: formatAgentTree(listing.entries, host.agentId, listing.closedUnavailable) }],
				details: {
					callerAgentId: host.agentId,
					entries: listing.entries,
					...(listing.closedUnavailable ? { closedUnavailable: true } : undefined),
				},
			};
		},
	};
}

function formatAgentTree(
	entries: readonly AgentTreeEntry[],
	callerAgentId: string,
	closedUnavailable: boolean | undefined,
): string {
	if (entries.length === 0) {
		return "No agent is currently live in your tree.";
	}
	const lines: string[] = ["Agents in your tree:"];
	let hasClosed = false;
	const write = (entry: AgentTreeEntry, depth: number): void => {
		const indent = "  ".repeat(depth);
		if (entry.status === "running") {
			const suffix = entry.agentId === callerAgentId ? " (you)" : "";
			const state = entry.activity === "running" ? "working" : "idle";
			lines.push(`${indent}- agent ${entry.agentId} [profile ${entry.profileId}] ${state}${suffix}`);
		} else {
			hasClosed = true;
			const profile = entry.profileId ? ` [profile ${entry.profileId}]` : "";
			lines.push(`${indent}- session ${entry.sessionRef}${profile} closed, started ${entry.createdAt}`);
		}
		for (const child of entry.children) write(child, depth + 1);
	};
	for (const entry of entries) write(entry, 0);

	if (hasClosed) {
		lines.push(
			"A closed session is not running: it cannot be messaged or disposed. Spawn a new agent on the same profile if that work needs continuing.",
		);
	}
	if (closedUnavailable) {
		lines.push("The closed sessions could not be read, so only running agents are listed.");
	}
	return lines.join("\n");
}
