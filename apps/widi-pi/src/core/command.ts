import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { OrchestratorDiagnostic } from "./diagnostics.ts";

export type CommandPlacement = "line" | "inline";

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
}

export interface CommandCandidate {
	readonly value: string;
	readonly label?: string;
	readonly description?: string;
}

export type CommandCandidates = readonly CommandCandidate[];

export interface ParsedLineCommand {
	readonly trigger: string;
	readonly name: string;
	readonly argument: string;
}

export interface CommandInvocation {
	readonly name: string;
	readonly trigger: string;
	readonly argument: string;
	readonly source: CommandSource;
	readonly placement: CommandPlacement;
}

export type InputResult =
	| { readonly kind: "prompt"; readonly message: AssistantMessage }
	| {
			readonly kind: "command";
			readonly commandId: string;
			readonly name: string;
			readonly value: unknown;
	  }
	| {
			readonly kind: "rejected";
			readonly commandId: string;
			readonly diagnostic: OrchestratorDiagnostic;
	  }
	| {
			readonly kind: "failed";
			readonly commandId: string;
			readonly diagnostic: OrchestratorDiagnostic;
	  };

export function parseLineCommand(
	text: string,
	triggers: readonly string[],
): ParsedLineCommand | undefined {
	const input = text.trimEnd();
	const trigger = [...new Set(triggers)]
		.filter((candidate) => candidate.length > 0)
		.sort((left, right) => right.length - left.length)
		.find((candidate) => input.startsWith(candidate));
	if (!trigger) return undefined;
	const body = input.slice(trigger.length);
	if (!body) return undefined;

	const separatorIndex = body.indexOf(":");
	const rawName = separatorIndex === -1 ? body : body.slice(0, separatorIndex);
	if (!isCommandName(rawName)) return undefined;

	return {
		trigger,
		name: rawName,
		argument: separatorIndex === -1 ? "" : body.slice(separatorIndex + 1),
	};
}

export function commandKey(
	command: Pick<Command, "placement" | "trigger" | "name">,
): string {
	return `${command.placement}\u0000${command.trigger}\u0000${command.name}`;
}

export function isCommandName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name);
}
