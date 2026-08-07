import type { OrchestratorDiagnostic } from "../../core/diagnostics.ts";
import type { AgentActivitySnapshot } from "../../core/types.ts";
import { parseLineCommand } from "./parse.ts";
import type { CommandContext, CommandDefinition, CommandError, CommandView, EngineOutcome } from "./types.ts";

export interface EngineHooks {
	onCommandStart?(commandId: string, name: string, argument: string): void;
}

export class CommandEngine {
	private readonly commands = new Map<string, CommandDefinition>();
	private nextCommandId = 1;

	constructor(commands: readonly CommandDefinition[] = []) {
		for (const command of commands) this.register(command);
	}

	/**
	 * Add a command at runtime. A taken name is a conflict: the registration
	 * is refused and reported, never a silent override. The caller surfaces
	 * the returned diagnostic.
	 */
	register(command: CommandDefinition): OrchestratorDiagnostic | undefined {
		if (this.commands.has(command.name)) {
			return {
				severity: "warning",
				code: "command.name_conflict",
				message: `Command /${command.name} is already registered; the new registration was refused.`,
			};
		}
		this.commands.set(command.name, command);
		return undefined;
	}

	/** Remove a command by name; returns whether one was registered. */
	unregister(name: string): boolean {
		return this.commands.delete(name);
	}

	list(activity: AgentActivitySnapshot | undefined): CommandView[] {
		const views: CommandView[] = [];
		for (const command of this.commands.values()) {
			const unavailableReason =
				activity === undefined && command.agentPolicy === "active"
					? `Command /${command.name} requires an active agent.`
					: activity === undefined
						? undefined
						: command.checkActivity?.(activity);
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
		return await this.runCommand(command, parsed.argument, parsed.hasArgument, context, hooks);
	}

	private async runCommand(
		command: CommandDefinition,
		argument: string,
		hasArgument: boolean,
		context: CommandContext,
		hooks?: EngineHooks,
	): Promise<EngineOutcome> {
		const commandId = this.createCommandId();
		if (!context.agentId && command.agentPolicy === "active") {
			return failed(commandId, command.name, { message: `Command /${command.name} requires an active agent.` });
		}
		// A gone agent has no activity to read. The command is let through and
		// fails on its own terms, which says more than "requires a running agent".
		const activity = context.agentId ? tryReadActivity(context) : undefined;
		const unavailableReason = activity ? command.checkActivity?.(activity) : undefined;
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
			return { kind: "expanded", text: await command.expand(context, argument) };
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

function tryReadActivity(context: CommandContext): AgentActivitySnapshot | undefined {
	if (!context.agentId) return undefined;
	try {
		return context.orchestrator.getAgentActivity(context.agentId);
	} catch {
		return undefined;
	}
}

function failed(commandId: string, name: string, error: CommandError): EngineOutcome {
	return { kind: "failed", commandId, name, error };
}

function toCommandError(error: unknown): CommandError {
	return { message: error instanceof Error ? error.message : String(error), cause: error };
}
