import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { OrchestratorDiagnostic } from "./diagnostics.ts";

export type SlashCommandPlacement = "line" | "inline";

export interface SlashCommand {
	readonly name: string;
	readonly description?: string;
	readonly argumentHint?: string;
	readonly source: SlashCommandSource;
	readonly scope?: "user-facing" | "any";
	readonly placement: SlashCommandPlacement;
	readonly arguments?: SlashCommandArguments;
	readonly available?: boolean;
	readonly unavailableReason?: string;
}

export type SlashCommandSource =
	| { readonly kind: "built-in" }
	| { readonly kind: "extension"; readonly extensionId: string };

export interface SlashCommandArguments {
	readonly required?: boolean;
	complete?(
		context: SlashCommandCompletionContext,
	): Promise<SlashCommandCandidates>;
}

export interface SlashCommandCompletionContext {
	readonly agentId: string;
	readonly command: SlashCommand;
	readonly argumentPrefix: string;
}

export interface SlashCommandCandidate {
	readonly value: string;
	readonly label?: string;
	readonly description?: string;
}

export type SlashCommandCandidates = readonly SlashCommandCandidate[];

export interface ParsedLineSlashCommand {
	readonly name: string;
	readonly args: string;
}

export interface SlashCommandInvocation {
	readonly name: string;
	readonly args: string;
	readonly source: SlashCommandSource;
	readonly placement: SlashCommandPlacement;
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

export function parseLineSlashCommand(
	text: string,
): ParsedLineSlashCommand | undefined {
	if (!text.startsWith("/")) return undefined;
	const body = text.slice(1);
	if (!body.trim()) return undefined;
	const match = /^([^:\s]+)(?::([\s\S]*)|\s+([\s\S]*))?$/u.exec(body);
	if (!match) return undefined;
	return {
		name: match[1],
		args: match[2] ?? match[3] ?? "",
	};
}
