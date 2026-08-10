import { messageBindingFor } from "../../../core/message.ts";
import type { CommandDefinition } from "../types.ts";
import { requireAgentId, unavailableDuringMaintenance } from "./utils/agents.ts";

export const followUpCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "active",
	name: "follow-up",
	description: "Queue a follow-up for the current agent.",
	argumentHint: "<text>",
	requiresArgument: true,
	checkActivity: (activity) => unavailableDuringMaintenance("follow-up", activity.maintenance),
	execute: async (context, argument) => {
		await context.orchestrator.sendMessage(
			{ targetAgentId: requireAgentId(context), body: argument.trim(), mode: "next_turn" },
			messageBindingFor({ kind: "human" }),
		);
		return undefined;
	},
};
