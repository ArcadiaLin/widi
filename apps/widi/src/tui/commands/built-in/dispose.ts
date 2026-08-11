import type { CommandDefinition } from "../types.ts";
import type { CommandHost } from "./command-host.ts";
import { requireAgentId } from "./utils/agents.ts";

export function disposeCommand(host: CommandHost): CommandDefinition {
	return {
		kind: "action",
		agentPolicy: "active",
		name: "dispose",
		description: "Close the current runtime agent without deleting its session.",
		execute: async (context) => {
			await host.disposeAgent(requireAgentId(context));
			return undefined;
		},
	};
}
