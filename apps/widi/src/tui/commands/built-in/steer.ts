import { messageBindingFor } from "../../../core/message.ts";
import type { CommandDefinition } from "../types.ts";
import { requireAgentId, unavailableDuringMaintenance } from "./utils/agents.ts";

export const steerCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "active",
	name: "steer",
	description: "Steer the current running agent.",
	argumentHint: "<text>",
	requiresArgument: true,
	checkActivity: (activity) =>
		unavailableDuringMaintenance("steer", activity.maintenance) ??
		(activity.activity === "running"
			? undefined
			: `Command /steer requires a running agent (status: ${activity.activity}).`),
	execute: async (context, argument) => {
		const outcome = await context.orchestrator.sendMessage(
			{ targetAgentId: requireAgentId(context), body: argument.trim(), mode: "interrupt" },
			messageBindingFor({ kind: "human" }),
		);
		if (outcome.kind === "blocked") {
			throw new Error(
				outcome.reason
					? `Input blocked by ${outcome.blockedBy}: ${outcome.reason}`
					: `Input blocked by ${outcome.blockedBy}.`,
			);
		}
		return undefined;
	},
};
