import type { CommandDefinition } from "../types.ts";
import { requireAgentId, unavailableDuringMaintenance } from "./utils/agents.ts";

export const abortCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "active",
	name: "abort",
	description: "Abort the current agent run.",
	checkActivity: (activity) => unavailableDuringMaintenance("abort", activity.maintenance),
	execute: async (context) => await context.orchestrator.abortAgent(requireAgentId(context), "human"),
};
