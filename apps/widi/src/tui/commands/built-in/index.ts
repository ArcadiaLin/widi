import type { CommandDefinition } from "../types.ts";
import { abortCommand } from "./abort.ts";
import { agentCommand } from "./agent.ts";
import type { ApplicationCommandHost } from "./application-host.ts";
import { compactCommand } from "./compact.ts";
import { diagnosticsCommand } from "./diagnostics.ts";
import { disposeCommand } from "./dispose.ts";
import { divisionCommand } from "./division.ts";
import { followUpCommand } from "./follow-up.ts";
import { forkCommand } from "./fork.ts";
import { inspectCommand } from "./inspect.ts";
import { loginCommand } from "./login.ts";
import { logoutCommand } from "./logout.ts";
import { modelCommand } from "./model.ts";
import { newSessionCommands } from "./new.ts";
import { promptCommand } from "./prompt.ts";
import { quitCommands } from "./quit.ts";
import { reloadCommand } from "./reload.ts";
import { renameCommand } from "./rename.ts";
import { resumeCommand } from "./resume.ts";
import { sessionCommand } from "./session.ts";
import { skillCommand } from "./skill.ts";
import { statusCommand } from "./status.ts";
import { steerCommand } from "./steer.ts";
import { thinkingCommand } from "./thinking.ts";
import { treeCommand } from "./tree.ts";

export type { ApplicationCommandHost } from "./application-host.ts";

/** Commands that drive the orchestrator; one file per command name. */
export const builtInCommands: readonly CommandDefinition[] = [
	abortCommand,
	compactCommand,
	followUpCommand,
	forkCommand,
	inspectCommand,
	agentCommand,
	loginCommand,
	logoutCommand,
	modelCommand,
	thinkingCommand,
	renameCommand,
	reloadCommand,
	divisionCommand,
	resumeCommand,
	sessionCommand,
	statusCommand,
	steerCommand,
	treeCommand,
	promptCommand,
	skillCommand,
];

/**
 * The rest of the built-ins: they act on the application itself, so they are
 * built against its host rather than exported as ready definitions.
 */
export function applicationCommands(host: ApplicationCommandHost): readonly CommandDefinition[] {
	return [...quitCommands(host), ...newSessionCommands(host), diagnosticsCommand(host), disposeCommand(host)];
}
