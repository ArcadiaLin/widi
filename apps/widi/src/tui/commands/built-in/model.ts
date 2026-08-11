import type { CommandDefinition } from "../types.ts";
import { requireAgentId } from "./utils/agents.ts";

export const modelCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "materialize",
	name: "model",
	description: "Set the current agent model.",
	argumentHint: "[provider/model]",
	requiresArgument: true,
	complete: async ({ orchestrator }) => (await orchestrator.listAvailableModelCandidates()).models,
	argumentCompletes: true,
	execute: async (context, argument) => {
		const model = await context.orchestrator.setAgentModelByReference(requireAgentId(context), argument.trim());
		// Picking a model is picking it: whatever is spawned next starts there too,
		// and so does the next run.
		context.orchestrator.setDefaultModel(model);
		return `Switched to ${model.provider}/${model.id}`;
	},
};
