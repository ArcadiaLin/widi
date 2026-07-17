import type { AgentOrchestrator } from "./agent-orchestrator.ts";
import type { CandidateItem } from "./types.ts";

export type CommandPlacement = "line" | "inline";

// Inline commands live in one fixed trigger domain (`<name:argument>`);
// built-in and extension inline commands share it so input scanning stays a
// single syntax.
export const INLINE_COMMAND_TRIGGER = "<";
export const INLINE_COMMAND_CLOSE_TRIGGER = ">";

export interface Command {
	readonly name: string;
	readonly placement: CommandPlacement;
	readonly trigger: string;
	readonly closeTrigger?: string;
	readonly description?: string;
	readonly argumentHint?: string;
	readonly source: CommandSource;
	readonly scope?: "user-facing" | "any";
	readonly arguments?: CommandArguments;
	readonly available?: boolean;
	readonly unavailableReason?: string;
}

export type CommandSource =
	| { readonly kind: "built-in" }
	| { readonly kind: "extension"; readonly extensionId: string };

export interface CommandArguments {
	readonly required?: boolean;
	complete?(context: CommandCompletionContext): Promise<CommandCandidates>;
}

export interface CommandCompletionContext {
	readonly agentId: string;
	readonly command: Command;
	readonly argumentPrefix: string;
	readonly orchestrator: AgentOrchestrator;
}

export type CommandCandidate = CandidateItem;

export type CommandCandidates = readonly CommandCandidate[];

export function commandKey(
	command: Pick<Command, "placement" | "trigger" | "name">,
): string {
	return `${command.placement}\u0000${command.trigger}\u0000${command.name}`;
}

export function isCommandName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name);
}
