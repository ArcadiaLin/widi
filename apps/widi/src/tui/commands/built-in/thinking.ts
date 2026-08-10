import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { CommandDefinition } from "../types.ts";
import { requireAgentId } from "./utils/agents.ts";

export const thinkingCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "materialize",
	name: "thinking",
	description: "Set the current agent thinking level.",
	argumentHint: "[level]",
	requiresArgument: true,
	complete: async (context) => {
		if (context.agentId) {
			return context.orchestrator.listAgentThinkingLevelCandidates(context.agentId).levels;
		}
		if (!context.pendingModel?.reasoning) return [];
		return getSupportedThinkingLevels(context.pendingModel).map((level) => ({ value: level, label: level }));
	},
	argumentCompletes: true,
	execute: async (context, argument) =>
		await context.orchestrator.setAgentThinkingLevelByName(requireAgentId(context), argument.trim()),
};
