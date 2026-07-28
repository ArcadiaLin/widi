import type { AgentOrchestrator } from "../../core/agent-orchestrator.ts";
import type {
	AgentLifecycleStatus,
	AgentMaintenanceKind,
	CandidateItem,
	PromptExpansion,
	RuntimeModel,
} from "../../core/types.ts";

export type CommandAgentPolicy = "runtime" | "materialize" | "active";

export interface CommandContext {
	readonly agentId?: string;
	readonly orchestrator: AgentOrchestrator;
	readonly pendingModel?: RuntimeModel;
}

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
	/** Returns why the current agent phase blocks this command, or undefined. */
	checkStatus?(
		status: AgentLifecycleStatus,
		maintenance?: AgentMaintenanceKind,
	): string | undefined;
	complete?(
		context: CommandContext,
		argumentPrefix: string,
	): Promise<readonly CandidateItem[]>;
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
			readonly display?: string;
	  }
	| {
			readonly kind: "failed";
			readonly commandId: string;
			readonly name: string;
			readonly error: CommandError;
	  }
	| {
			readonly kind: "needs-argument";
			readonly command: CommandDefinition;
			readonly candidates: readonly CandidateItem[];
	  };
