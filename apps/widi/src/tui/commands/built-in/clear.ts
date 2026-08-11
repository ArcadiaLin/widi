import type { CommandDefinition } from "../types.ts";
import type { CommandHost } from "./command-host.ts";

/** End this conversation and reopen an empty one on the same role. */
export function clearCommand(host: CommandHost): CommandDefinition {
	return {
		kind: "action",
		agentPolicy: "runtime",
		name: "clear",
		description: "Close the current agent and start a new session on the same profile.",
		execute: async (context) => {
			await host.newSession(context.agentId);
			return undefined;
		},
	};
}
