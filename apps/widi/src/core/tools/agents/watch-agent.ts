import { type Static, Type } from "typebox";
import type { AgentWatchOutcome } from "../../host.ts";
import type { ToolDefinition } from "../types.ts";
import { requireAgentHost } from "./shared.ts";

const watchAgentSchema = Type.Object({
	agentId: Type.String({ description: "Id of the agent to start or stop watching." }),
	watching: Type.Boolean({
		description: "true subscribes to that agent's next stop; false drops a subscription you already hold.",
	}),
});

export type WatchAgentInput = Static<typeof watchAgentSchema>;

export interface WatchAgentDetails {
	readonly agentId: string;
	readonly outcome: AgentWatchOutcome;
}

/**
 * Changing your mind about an agent already running.
 *
 * `spawn_agent` and `send_message` subscribe as they hand over the work, which
 * is the ordering that cannot miss a stop; this tool exists for the case that
 * has no message attached - stop listening to something you no longer care
 * about, or start listening to an agent someone else told you about.
 */
export function createWatchAgentToolDefinition(): ToolDefinition<typeof watchAgentSchema, WatchAgentDetails> {
	return {
		name: "watch_agent",
		label: "watch_agent",
		description:
			"Start or stop watching an agent. While you watch one, you are told the moment it stops - the notification carries its last message - and the subscription is spent on that one stop. An agent has one watcher at a time. Prefer the watch parameter on spawn_agent and send_message, which subscribes before the work is handed over; use this tool when there is no message to send.",
		promptSnippet: "Start or stop being told when an agent stops",
		promptGuidelines: [
			"Being told is the only reliable signal that an agent finished. Do not poll it with send_message and do not infer from silence that it is still working.",
		],
		parameters: watchAgentSchema,
		execute: async (_toolCallId, { agentId, watching }, context) => {
			const host = requireAgentHost(context);
			const targetAgentId = agentId.trim();
			if (!targetAgentId) {
				throw new Error("watch_agent requires a non-empty agentId.");
			}
			const outcome = host.watch(targetAgentId, watching);
			// A refused subscription that read as success is the failure this whole
			// mechanism exists to remove: the caller would end its turn waiting for a
			// notification nobody is going to send. Dropping one never fails that way
			// - whatever the reason, the caller is not watching the agent afterwards.
			if (watching && outcome !== "watching") {
				throw new Error(`${describeOutcome(targetAgentId, outcome)} You are not watching it.`);
			}
			return {
				content: [{ type: "text", text: describeOutcome(targetAgentId, outcome) }],
				details: { agentId: targetAgentId, outcome },
			};
		},
	};
}

export function describeOutcome(agentId: string, outcome: AgentWatchOutcome): string {
	switch (outcome) {
		case "watching":
			return `You are watching agent ${agentId}. It will report to you once, when it stops.`;
		case "not_watching":
			return `You are not watching agent ${agentId}; nothing will be reported to you when it stops.`;
		case "taken":
			return `Agent ${agentId} is already watched by another agent, and a stop has exactly one reader.`;
		case "outside_tree":
			return `Agent ${agentId} belongs to another tree, so you cannot watch it. You can still send it messages.`;
		case "self":
			return "An agent cannot watch itself.";
		default:
			return `Unknown agent: ${agentId}.`;
	}
}
