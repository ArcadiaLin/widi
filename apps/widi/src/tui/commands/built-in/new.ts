import type { CommandDefinition } from "../types.ts";
import type { ApplicationCommandHost } from "./application-host.ts";

const DESCRIPTION = "Close the current agent and start a new session on the same profile.";

/**
 * One conversation ends and an empty one begins on the same role: the two
 * names users reach for mean the same thing, so they are the same command.
 */
export function newSessionCommands(host: ApplicationCommandHost): readonly CommandDefinition[] {
	const execute = async (context: { agentId?: string }) => {
		await host.newSession(context.agentId);
		return undefined;
	};
	return [
		{ kind: "action", agentPolicy: "runtime", name: "new", description: DESCRIPTION, execute },
		{ kind: "action", agentPolicy: "runtime", name: "clear", description: DESCRIPTION, execute },
	];
}
