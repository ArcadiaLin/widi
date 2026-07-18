import type { AgentLifecycleStatus } from "../../core/types.ts";
import { parseLineCommand, scanInlineCommands } from "./parse.ts";
import type {
	CommandContext,
	CommandDefinition,
	CommandError,
	CommandView,
	EngineOutcome,
	InlineCommand,
	LineCommand,
} from "./types.ts";

export interface EngineHooks {
	onCommandStart?(commandId: string, name: string, argument: string): void;
}

export class CommandEngine {
	private readonly lineCommands = new Map<string, LineCommand>();
	private readonly inlineCommands = new Map<string, InlineCommand>();
	private nextCommandId = 1;

	constructor(commands: readonly CommandDefinition[]) {
		for (const command of commands) {
			if (command.kind === "line") this.lineCommands.set(command.name, command);
			else this.inlineCommands.set(command.name, command);
		}
	}

	list(status: AgentLifecycleStatus): CommandView[] {
		const views: CommandView[] = [];
		for (const command of this.lineCommands.values()) {
			const unavailableReason = command.checkStatus?.(status);
			views.push({
				kind: "line",
				name: command.name,
				description: command.description,
				argumentHint: command.argumentHint,
				takesArgument:
					command.argumentHint !== undefined ||
					command.requiresArgument === true ||
					command.complete !== undefined,
				available: unavailableReason === undefined,
				unavailableReason,
			});
		}
		for (const command of this.inlineCommands.values()) {
			views.push({
				kind: "inline",
				name: command.name,
				description: command.description,
				argumentHint: command.argumentHint,
				takesArgument: true,
				available: true,
			});
		}
		return views;
	}

	line(name: string): LineCommand | undefined {
		return this.lineCommands.get(name);
	}

	inline(name: string): InlineCommand | undefined {
		return this.inlineCommands.get(name);
	}

	match(text: string): LineCommand | undefined {
		const parsed = parseLineCommand(text);
		return parsed ? this.lineCommands.get(parsed.name) : undefined;
	}

	async handleInput(
		text: string,
		context: CommandContext,
		hooks?: EngineHooks,
	): Promise<EngineOutcome> {
		const parsed = parseLineCommand(text);
		const command = parsed ? this.lineCommands.get(parsed.name) : undefined;
		if (parsed && command) {
			return await this.runLineCommand(
				command,
				parsed.argument,
				parsed.hasArgument,
				context,
				hooks,
			);
		}
		return await this.expandInline(text, context, hooks);
	}

	private async runLineCommand(
		command: LineCommand,
		argument: string,
		hasArgument: boolean,
		context: CommandContext,
		hooks?: EngineHooks,
	): Promise<EngineOutcome> {
		const commandId = this.createCommandId();
		const unavailableReason = command.checkStatus?.(
			context.orchestrator.getAgentStatus(context.agentId),
		);
		if (unavailableReason) {
			return failed(commandId, command.name, { message: unavailableReason });
		}
		// A required argument that is missing or blank never executes; explicit
		// blank arguments still execute optional-argument commands (e.g. /fork:).
		const missingArgument = command.requiresArgument
			? argument.trim() === ""
			: !hasArgument;
		if (missingArgument && (command.requiresArgument || command.complete)) {
			try {
				const candidates = (await command.complete?.(context, "")) ?? [];
				return { kind: "needs-argument", command, candidates };
			} catch (error) {
				return failed(commandId, command.name, toCommandError(error));
			}
		}
		hooks?.onCommandStart?.(commandId, command.name, argument);
		try {
			const value = await command.execute(context, argument);
			return { kind: "executed", commandId, name: command.name, value };
		} catch (error) {
			return failed(commandId, command.name, toCommandError(error));
		}
	}

	// All-or-nothing: any expand failure drops the whole input - a
	// half-expanded prompt must never reach the model.
	private async expandInline(
		text: string,
		context: CommandContext,
		hooks?: EngineHooks,
	): Promise<EngineOutcome> {
		const matches = scanInlineCommands(text, [...this.inlineCommands.keys()]);
		if (matches.length === 0) return { kind: "pass" };
		const items: Array<{
			commandId: string;
			name: string;
			trigger: string;
			argument: string;
			start: number;
			end: number;
		}> = [];
		const replacements: string[] = [];
		for (const match of matches) {
			const command = this.inlineCommands.get(match.name);
			if (!command) continue;
			const commandId = this.createCommandId();
			hooks?.onCommandStart?.(commandId, command.name, match.argument);
			try {
				replacements.push(await command.expand(context, match.argument));
			} catch (error) {
				return failed(commandId, command.name, toCommandError(error));
			}
			items.push({
				commandId,
				name: match.name,
				trigger: "<",
				argument: match.argument,
				start: match.start,
				end: match.end,
			});
		}
		if (items.length === 0) return { kind: "pass" };
		let expandedText = "";
		let cursor = 0;
		for (const [index, item] of items.entries()) {
			expandedText += text.slice(cursor, item.start);
			expandedText += replacements[index];
			cursor = item.end;
		}
		expandedText += text.slice(cursor);
		return {
			kind: "expanded",
			text: expandedText,
			expansion: { originalText: text, items },
		};
	}

	private createCommandId(): string {
		const id = `command-${this.nextCommandId}`;
		this.nextCommandId += 1;
		return id;
	}
}

export function switchedAgentId(outcome: EngineOutcome): string | undefined {
	if (outcome.kind !== "executed") return undefined;
	if (
		outcome.name !== "fork" &&
		outcome.name !== "new" &&
		outcome.name !== "resume"
	) {
		return undefined;
	}
	const value = outcome.value;
	if (typeof value !== "object" || value === null || !("agentId" in value)) {
		return undefined;
	}
	const agentId = (value as { agentId?: unknown }).agentId;
	return typeof agentId === "string" && agentId.length > 0
		? agentId
		: undefined;
}

function failed(
	commandId: string,
	name: string,
	error: CommandError,
): EngineOutcome {
	return { kind: "failed", commandId, name, error };
}

function toCommandError(error: unknown): CommandError {
	return {
		message: error instanceof Error ? error.message : String(error),
		cause: error,
	};
}
