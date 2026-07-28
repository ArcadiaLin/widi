import type { CommandDefinition } from "./types.ts";

/**
 * Application-level actions exposed to application-owned commands. quit()
 * must be fire-and-forget: the TUI awaits in-flight submit tasks during
 * shutdown, so awaiting shutdown inside a command's execute would deadlock
 * the submit task that is running the command.
 */
export interface ApplicationCommandHost {
	quit(): void;
	/** Close the current agent and stage an empty session on the same profile. */
	newSession(sourceAgentId: string | undefined): Promise<void>;
	disposeAgent(agentId: string): Promise<void>;
}

/** Commands that operate on the application itself, not the orchestrator. */
export function applicationCommands(
	host: ApplicationCommandHost,
): readonly CommandDefinition[] {
	const quit = async () => {
		host.quit();
		return undefined;
	};
	// One conversation ends and an empty one begins on the same role: the two
	// names users reach for mean the same thing, so they are the same command.
	const newSession = async (context: { agentId?: string }) => {
		await host.newSession(context.agentId);
		return undefined;
	};
	return [
		{
			kind: "action",
			agentPolicy: "runtime",
			name: "quit",
			description: "Exit the application.",
			execute: quit,
		},
		{
			kind: "action",
			agentPolicy: "runtime",
			name: "exit",
			description: "Exit the application.",
			execute: quit,
		},
		{
			kind: "action",
			agentPolicy: "runtime",
			name: "new",
			description:
				"Close the current agent and start a new session on the same profile.",
			execute: newSession,
		},
		{
			kind: "action",
			agentPolicy: "runtime",
			name: "clear",
			description:
				"Close the current agent and start a new session on the same profile.",
			execute: newSession,
		},
		{
			kind: "action",
			agentPolicy: "active",
			name: "dispose",
			description:
				"Close the current runtime agent without deleting its session.",
			execute: async (context) => {
				if (!context.agentId) {
					throw new Error("Command /dispose requires an active agent.");
				}
				await host.disposeAgent(context.agentId);
				return undefined;
			},
		},
	];
}
