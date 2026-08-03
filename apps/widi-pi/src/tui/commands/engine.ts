import type { AgentLifecycleStatus, AgentMaintenanceKind } from "../../core/types.ts";
import { LINE_COMMAND_TRIGGER, parseLineCommand } from "./parse.ts";
import type { CommandContext, CommandDefinition, CommandError, CommandView, EngineOutcome } from "./types.ts";

export interface EngineHooks {
	onCommandStart?(commandId: string, name: string, argument: string): void;
}

export class CommandEngine {
	private readonly commands = new Map<string, CommandDefinition>();
	private nextCommandId = 1;

	constructor(commands: readonly CommandDefinition[]) {
		for (const command of commands) this.commands.set(command.name, command);
	}

	list(status: AgentLifecycleStatus | undefined, maintenance?: AgentMaintenanceKind): CommandView[] {
		const views: CommandView[] = [];
		for (const command of this.commands.values()) {
			const unavailableReason =
				status === undefined && command.agentPolicy === "active"
					? `Command /${command.name} requires an active agent.`
					: status === undefined
						? undefined
						: command.checkStatus?.(status, maintenance);
			views.push({
				name: command.name,
				description: command.description,
				argumentHint: command.argumentHint,
				takesArgument:
					command.argumentHint !== undefined || command.requiresArgument === true || command.complete !== undefined,
				available: unavailableReason === undefined,
				unavailableReason,
			});
		}
		return views;
	}

	get(name: string): CommandDefinition | undefined {
		return this.commands.get(name);
	}

	match(text: string): CommandDefinition | undefined {
		const parsed = parseLineCommand(text);
		return parsed ? this.commands.get(parsed.name) : undefined;
	}

	async handleInput(text: string, context: CommandContext, hooks?: EngineHooks): Promise<EngineOutcome> {
		const parsed = parseLineCommand(text);
		const command = parsed ? this.commands.get(parsed.name) : undefined;
		if (!parsed || !command) return { kind: "pass" };
		return await this.runCommand(command, parsed.argument, parsed.hasArgument, text, context, hooks);
	}

	private async runCommand(
		command: CommandDefinition,
		argument: string,
		hasArgument: boolean,
		text: string,
		context: CommandContext,
		hooks?: EngineHooks,
	): Promise<EngineOutcome> {
		const commandId = this.createCommandId();
		if (!context.agentId && command.agentPolicy === "active") {
			return failed(commandId, command.name, { message: `Command /${command.name} requires an active agent.` });
		}
		const unavailableReason = context.agentId
			? command.checkStatus?.(
					context.orchestrator.getAgentStatus(context.agentId),
					context.orchestrator.getAgentMaintenance?.(context.agentId),
				)
			: undefined;
		if (unavailableReason) {
			return failed(commandId, command.name, { message: unavailableReason });
		}
		// A required argument that is missing or blank never runs; explicit blank
		// arguments still run optional-argument commands (e.g. /fork:).
		const missingArgument = command.requiresArgument ? argument.trim() === "" : !hasArgument;
		if (missingArgument && (command.requiresArgument || command.complete)) {
			try {
				const candidates = (await command.complete?.(context, "")) ?? [];
				// An optional-argument command with nothing to offer runs its bare
				// form instead: /tree lists the whole tree, and demanding an
				// argument would put that behind the colon syntax for no reason.
				if (candidates.length > 0 || command.requiresArgument) {
					return { kind: "needs-argument", command, candidates };
				}
			} catch (error) {
				return failed(commandId, command.name, toCommandError(error));
			}
		}
		if (!context.agentId && command.agentPolicy === "materialize") {
			return failed(commandId, command.name, { message: `Command /${command.name} requires an active agent.` });
		}
		hooks?.onCommandStart?.(commandId, command.name, argument);
		try {
			if (command.kind === "action") {
				const value = await command.execute(context, argument);
				// A formatter that throws must not turn a successful command into
				// a failure; fall back to rendering the raw value.
				let display: string | undefined;
				try {
					display = command.formatResult?.(value);
				} catch {
					display = undefined;
				}
				return { kind: "executed", commandId, name: command.name, value, display };
			}
			return {
				kind: "expanded",
				text: await command.expand(context, argument),
				// The whole input is the command, so the expansion replaces all of
				// it. The record lets the UI replay what the user actually typed.
				expansion: {
					originalText: text,
					items: [
						{ commandId, name: command.name, trigger: LINE_COMMAND_TRIGGER, argument, start: 0, end: text.length },
					],
				},
			};
		} catch (error) {
			return failed(commandId, command.name, toCommandError(error));
		}
	}

	private createCommandId(): string {
		const id = `command-${this.nextCommandId}`;
		this.nextCommandId += 1;
		return id;
	}
}

export function switchedAgentId(outcome: EngineOutcome): string | undefined {
	if (outcome.kind !== "executed") return undefined;
	if (outcome.name !== "fork" && outcome.name !== "resume") {
		return undefined;
	}
	const value = outcome.value;
	if (typeof value !== "object" || value === null || !("agentId" in value)) {
		return undefined;
	}
	const agentId = (value as { agentId?: unknown }).agentId;
	return typeof agentId === "string" && agentId.length > 0 ? agentId : undefined;
}

function failed(commandId: string, name: string, error: CommandError): EngineOutcome {
	return { kind: "failed", commandId, name, error };
}

function toCommandError(error: unknown): CommandError {
	return { message: error instanceof Error ? error.message : String(error), cause: error };
}
