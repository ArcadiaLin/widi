import type { CompactResult } from "@widi/agent-core";
import type { CommandDefinition } from "../types.ts";
import { requireAgentId } from "./utils/agents.ts";

export const compactCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "active",
	name: "compact",
	description: "Compact the current agent session.",
	argumentHint: "[instructions]",
	execute: async (context, argument) =>
		await context.orchestrator.compactAgent(requireAgentId(context), argument.trim() || undefined),
	formatResult: (result) => {
		const compact = result as CompactResult;
		// The summary itself stays in the session (shown as a collapsed
		// "Compacted session" marker); its first line was always the "## Goal"
		// heading, which meant nothing here.
		return `compacted ${compact.tokensBefore} tokens`;
	},
};
