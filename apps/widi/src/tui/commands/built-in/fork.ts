import type { CommandDefinition } from "../types.ts";
import { agentSnapshotResultText, requireAgentId } from "./utils/agents.ts";
import { listUserMessageEntryCandidates } from "./utils/sessions.ts";

export const forkCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "active",
	name: "fork",
	description: "Fork the current agent session.",
	argumentHint: "[entry]",
	complete: async (context) => await listUserMessageEntryCandidates(context),
	argumentCompletes: true,
	execute: async (context, argument) => {
		const entryId = argument.trim() || undefined;
		const agentId = await context.orchestrator.spawnAgent({
			origin: {
				kind: "fork",
				sourceAgentId: requireAgentId(context),
				...(entryId === undefined ? undefined : { entryId }),
			},
		});
		return context.orchestrator.inspectAgent(agentId);
	},
	formatResult: (result) => agentSnapshotResultText("forked", result),
};
