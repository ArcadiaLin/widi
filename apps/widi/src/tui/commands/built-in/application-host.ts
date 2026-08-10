import type { DiagnosticsLog } from "../../diagnostics-log.ts";

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
	readonly diagnostics: DiagnosticsLog;
	/** Put text on the system clipboard; throws when no clipboard could be reached. */
	copyText(text: string): Promise<void>;
}
