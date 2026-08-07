import type { Component, SelectItem } from "@earendil-works/pi-tui";
import type { AgentOrchestrator } from "../../core/agent-orchestrator.ts";
import type { AgentActivitySnapshot, CandidateItem, RuntimeModel } from "../../core/types.ts";

export type CommandAgentPolicy = "runtime" | "materialize" | "active";

export interface CommandContext {
	readonly agentId?: string;
	readonly orchestrator: AgentOrchestrator;
	readonly pendingModel?: RuntimeModel;
}

/** What the application hands a command's dedicated Enter-time selector. */
export interface CommandSelectorRequest {
	readonly title: string;
	readonly items: readonly SelectItem[];
	/** Pre-filled filter text (a query the submit path already tried). */
	readonly initialFilter?: string;
	onSelect(item: SelectItem): void;
	onCancel?(): void;
	/**
	 * Hides the host overlay and restores focus. Runs before onSelect/onCancel
	 * so a callback is free to open another selector.
	 */
	onClose(): void;
}

/** Builds the command's Enter-time picker; the shared ListSelector is the default. */
export type SelectorFactory = (request: CommandSelectorRequest) => Component;

export type ResolveArgumentOutcome =
	| { readonly kind: "resolved"; readonly value: string }
	| { readonly kind: "open-selector"; readonly query: string };

/**
 * Everything a `/name argument` command shares. Commands differ only in what
 * they produce: an action result or prompt text.
 */
interface CommandBase {
	readonly agentPolicy: CommandAgentPolicy;
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly requiresArgument?: boolean;
	/** Returns why the current agent activity blocks this command, or undefined. */
	checkActivity?(activity: AgentActivitySnapshot): string | undefined;
	complete?(context: CommandContext, argumentPrefix: string): Promise<readonly CandidateItem[]>;
	/** Enter-time picker; defaults to the shared ListSelector fed with complete() candidates. */
	readonly selector?: SelectorFactory;
	/**
	 * Resolves a submitted argument against the candidates; defaults to the
	 * engine's generic exact-then-unique-prefix matching on candidate values.
	 */
	resolveArgument?(
		context: CommandContext,
		argument: string,
		candidates: readonly CandidateItem[],
	): ResolveArgumentOutcome | Promise<ResolveArgumentOutcome>;
}

/** Performs an action; the returned value is rendered as the command result. */
export interface ActionCommand extends CommandBase {
	readonly kind: "action";
	execute(context: CommandContext, argument: string): Promise<unknown>;
	/**
	 * Optional short human-readable summary of the result. When defined, the
	 * transcript shows it instead of dumping the raw result value.
	 */
	formatResult?(result: unknown): string;
}

/** Pure expansion: the returned text is submitted as the user prompt. */
export interface PromptCommand extends CommandBase {
	readonly kind: "prompt";
	expand(context: CommandContext, argument: string): Promise<string>;
}

export type CommandDefinition = ActionCommand | PromptCommand;

export interface CommandError {
	readonly message: string;
	readonly cause?: unknown;
}

/** List entry with availability computed against the current agent status. */
export interface CommandView {
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly takesArgument: boolean;
	readonly available: boolean;
	readonly unavailableReason?: string;
}

export type EngineOutcome =
	| { readonly kind: "pass" }
	| { readonly kind: "expanded"; readonly text: string }
	| {
			readonly kind: "executed";
			readonly commandId: string;
			readonly name: string;
			readonly value: unknown;
			readonly display?: string;
	  }
	| { readonly kind: "failed"; readonly commandId: string; readonly name: string; readonly error: CommandError }
	| {
			readonly kind: "needs-argument";
			readonly command: CommandDefinition;
			readonly candidates: readonly CandidateItem[];
	  }
	| {
			readonly kind: "open-selector";
			readonly command: CommandDefinition;
			readonly candidates: readonly CandidateItem[];
			readonly query: string;
	  };
