import type { AgentOrchestrator } from "../../core/agent-orchestrator.ts";
import type {
	AgentLifecycleStatus,
	CandidateItem,
	PromptExpansion,
} from "../../core/types.ts";

export interface CommandContext {
	readonly agentId: string;
	readonly orchestrator: AgentOrchestrator;
}

export interface LineCommand {
	readonly kind: "line";
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly requiresArgument?: boolean;
	/** Returns the reason the agent status blocks this command, or undefined. */
	checkStatus?(status: AgentLifecycleStatus): string | undefined;
	complete?(
		context: CommandContext,
		argumentPrefix: string,
	): Promise<readonly CandidateItem[]>;
	execute(context: CommandContext, argument: string): Promise<unknown>;
}

export interface InlineCommand {
	readonly kind: "inline";
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	complete?(
		context: CommandContext,
		argumentPrefix: string,
	): Promise<readonly CandidateItem[]>;
	/** Pure expansion: the returned text replaces the command token. */
	expand(context: CommandContext, argument: string): Promise<string>;
}

export type CommandDefinition = LineCommand | InlineCommand;

export interface CommandError {
	readonly message: string;
	readonly cause?: unknown;
}

/** List entry with availability computed against the current agent status. */
export interface CommandView {
	readonly kind: "line" | "inline";
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly takesArgument: boolean;
	readonly available: boolean;
	readonly unavailableReason?: string;
}

export type EngineOutcome =
	| { readonly kind: "pass" }
	| {
			readonly kind: "expanded";
			readonly text: string;
			readonly expansion: PromptExpansion;
	  }
	| {
			readonly kind: "executed";
			readonly commandId: string;
			readonly name: string;
			readonly value: unknown;
	  }
	| {
			readonly kind: "failed";
			readonly commandId: string;
			readonly name: string;
			readonly error: CommandError;
	  }
	| {
			readonly kind: "needs-argument";
			readonly command: LineCommand;
			readonly candidates: readonly CandidateItem[];
	  };
