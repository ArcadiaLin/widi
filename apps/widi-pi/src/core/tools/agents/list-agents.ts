import { Type } from "typebox";
import type { AgentTreeEntry } from "../../host.ts";
import type { ToolDefinition } from "../types.ts";
import { requireAgentHost } from "./shared.ts";

const listAgentsSchema = Type.Object({});

export interface ListAgentsDetails {
	readonly callerAgentId: string;
	/** The caller, holding the agents and sessions directly under it. */
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
 *
 * One level deep: the caller and what it spawned, not what those spawned in
 * turn. The runtime hands over the whole tree and this is where it is cut, so
 * the depth is a decision about what a model should read at once rather than
 * about what can be known. Deeper entries are counted, never dropped silently -
 * an agent that needs the level below asks the agent that owns it.
 */
export function createListAgentsToolDefinition(): ToolDefinition<typeof listAgentsSchema, ListAgentsDetails> {
	return {
		name: "list_agents",
		label: "list_agents",
		description:
			"List the agents you spawned: the ones running now, and the sessions of the ones no longer running. It shows one level - your own agents, not theirs - and does not enumerate other trees. You may still use send_message with an exact agent id that was shared with you, from any tree or level. Only running agents can be messaged or disposed; a closed session is a record of past work, not an address. It does not report what each agent is working on; ask the agent itself.",
		promptSnippet: "List the agents you spawned and their status",
		parameters: listAgentsSchema,
		execute: async (_toolCallId, _params, context) => {
			const host = requireAgentHost(context);
			const listing = await host.listAgents();
			const level = toCallerLevel(listing.entries, host.agentId);
			return {
				content: [
					{
						type: "text",
						text: formatAgentTree(level.entries, {
							callerAgentId: host.agentId,
							nested: level.nested,
							closedUnavailable: listing.closedUnavailable,
						}),
					},
				],
				details: {
					callerAgentId: host.agentId,
					entries: level.entries,
					...(listing.closedUnavailable ? { closedUnavailable: true } : undefined),
				},
			};
		},
	};
}

/**
 * The caller with its direct children, each stripped of its own.
 *
 * The listing arrives rooted at the tree root, which is where discovery used to
 * start; anchoring on the caller is what makes "one level" mean the level the
 * caller owns rather than the level below the root. A caller that is somehow
 * not in its own tree falls back to the roots, so the tool still answers.
 */
function toCallerLevel(
	entries: readonly AgentTreeEntry[],
	callerAgentId: string,
): { readonly entries: readonly AgentTreeEntry[]; readonly nested: ReadonlyMap<string, number> } {
	const caller = findCaller(entries, callerAgentId);
	const anchors = caller ? [caller] : entries;
	const nested = new Map<string, number>();
	const level = anchors.map((anchor) => ({
		...anchor,
		children: anchor.children.map((child) => {
			const count = countNested(child);
			if (count > 0) nested.set(entryKey(child), count);
			return { ...child, children: [] };
		}),
	}));
	return { entries: level, nested };
}

function countNested(entry: AgentTreeEntry): number {
	return entry.children.reduce((total, child) => total + 1 + countNested(child), 0);
}

/** How an entry is named in the listing: an agent id, or a session address. */
function entryKey(entry: AgentTreeEntry): string {
	return entry.status === "running" ? entry.agentId : entry.sessionRef;
}

function findCaller(entries: readonly AgentTreeEntry[], callerAgentId: string): AgentTreeEntry | undefined {
	for (const entry of entries) {
		if (entry.status === "running" && entry.agentId === callerAgentId) return entry;
		const nested = findCaller(entry.children, callerAgentId);
		if (nested) return nested;
	}
	return undefined;
}

function formatAgentTree(
	entries: readonly AgentTreeEntry[],
	options: {
		readonly callerAgentId: string;
		readonly nested: ReadonlyMap<string, number>;
		readonly closedUnavailable: boolean | undefined;
	},
): string {
	if (entries.length === 0) {
		return "No agent is currently live in your tree.";
	}
	const lines: string[] = ["Agents in your tree:"];
	let hasClosed = false;
	let hasNested = false;
	const write = (entry: AgentTreeEntry, depth: number): void => {
		const indent = "  ".repeat(depth);
		const count = options.nested.get(entryKey(entry));
		const nested = count === undefined ? "" : ` (+${count} nested)`;
		if (count !== undefined) hasNested = true;
		if (entry.status === "running") {
			const suffix = entry.agentId === options.callerAgentId ? " (you)" : "";
			const state = entry.activity === "running" ? "working" : "idle";
			lines.push(`${indent}- agent ${entry.agentId} [profile ${entry.profileId}] ${state}${nested}${suffix}`);
		} else {
			hasClosed = true;
			const profile = entry.profileId ? ` [profile ${entry.profileId}]` : "";
			lines.push(`${indent}- session ${entry.sessionRef}${profile} closed, started ${entry.createdAt}${nested}`);
		}
		for (const child of entry.children) write(child, depth + 1);
	};
	for (const entry of entries) write(entry, 0);

	if (hasNested) {
		lines.push(
			"This list shows one level. +N counts the agents and sessions nested below an entry; ask a running agent to list its own.",
		);
	}
	if (hasClosed) {
		lines.push(
			"A closed session is not running: it cannot be messaged or disposed. Spawn a new agent on the same profile if that work needs continuing.",
		);
	}
	if (options.closedUnavailable) {
		lines.push("The closed sessions could not be read, so only running agents are listed.");
	}
	return lines.join("\n");
}
