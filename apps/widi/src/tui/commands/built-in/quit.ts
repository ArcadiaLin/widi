import type { CommandDefinition } from "../types.ts";
import type { ApplicationCommandHost } from "./application-host.ts";

/** Leaving is one action under the two names users reach for. */
export function quitCommands(host: ApplicationCommandHost): readonly CommandDefinition[] {
	const execute = async () => {
		host.quit();
		return undefined;
	};
	return [
		{ kind: "action", agentPolicy: "runtime", name: "quit", description: "Exit the application.", execute },
		{ kind: "action", agentPolicy: "runtime", name: "exit", description: "Exit the application.", execute },
	];
}
