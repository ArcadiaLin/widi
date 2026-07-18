import type { CommandDefinition } from "./types.ts";

/**
 * Application-level actions exposed to application-owned commands. quit()
 * must be fire-and-forget: the TUI awaits in-flight submit tasks during
 * shutdown, so awaiting shutdown inside a command's execute would deadlock
 * the submit task that is running the command.
 */
export interface ApplicationCommandHost {
	quit(): void;
}

/** Commands that operate on the application itself, not the orchestrator. */
export function applicationCommands(
	host: ApplicationCommandHost,
): readonly CommandDefinition[] {
	const quit = async () => {
		host.quit();
		return undefined;
	};
	return [
		{
			kind: "line",
			name: "quit",
			description: "Exit the application.",
			execute: quit,
		},
		{
			kind: "line",
			name: "exit",
			description: "Exit the application.",
			execute: quit,
		},
	];
}
