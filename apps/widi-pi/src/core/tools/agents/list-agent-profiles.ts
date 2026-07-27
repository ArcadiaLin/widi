import { Type } from "typebox";
import type { AgentProfileBrief } from "../../agent-host.ts";
import type { ToolDefinition } from "../types.ts";
import { requireAgentHost } from "./shared.ts";

const listAgentProfilesSchema = Type.Object({});

export interface ListAgentProfilesDetails {
	readonly profiles: readonly AgentProfileBrief[];
}

/**
 * The spawn menu. It reports what `spawn_agent` will accept right now, and
 * nothing about how a profile was resolved: no source, path, system prompt, or
 * extension configuration. The listing is not an authorization either - spawn
 * re-validates the profile it is given.
 */
export function createListAgentProfilesToolDefinition(): ToolDefinition<
	typeof listAgentProfilesSchema,
	ListAgentProfilesDetails
> {
	return {
		name: "list_agent_profiles",
		label: "list_agent_profiles",
		description:
			"List the agent profiles that can be used with spawn_agent. Each profile is a role: it decides the spawned agent's system prompt, tools, and whether its session persists, and it says when to pick it. Call this before spawn_agent instead of guessing a profile name.",
		promptSnippet: "List the agent profiles available to spawn",
		parameters: listAgentProfilesSchema,
		execute: async (_toolCallId, _params, context) => {
			const profiles = await requireAgentHost(context).listProfiles();
			return {
				content: [{ type: "text", text: formatProfiles(profiles) }],
				details: { profiles },
			};
		},
	};
}

function formatProfiles(profiles: readonly AgentProfileBrief[]): string {
	if (profiles.length === 0) {
		return "No agent profile is available to spawn.";
	}
	const lines = profiles.map((profile) => {
		const description = profile.description ? `: ${profile.description}` : "";
		const session = profile.persist
			? "persistent session"
			: "ephemeral session";
		const head = `- ${profile.id} (${profile.label})${description} [${session}]`;
		if (!profile.whenToUse) return head;
		// Indented under its own entry: selection advice runs to a paragraph, and
		// unindented it would read as the start of the next profile.
		const advice = profile.whenToUse
			.split("\n")
			.map((line) => (line ? `  ${line}` : ""))
			.join("\n");
		return `${head}\n${advice}`;
	});
	return `Agent profiles available to spawn_agent:\n${lines.join("\n")}`;
}
