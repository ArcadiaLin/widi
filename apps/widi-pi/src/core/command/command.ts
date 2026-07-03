import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentOrchestrator, AgentRecord } from "../agent-orchestrator.ts";
import { createDiagnostic } from "../diagnostics.ts";
import {
	builtinInputCommands,
	getBuiltinInputCommandNames,
} from "./builtin.ts";
import { parseInputInvocation } from "./input.ts";
import type {
	BuiltinInputCommandKind,
	CommandRequest,
	CommandValue,
	InputCommandInfo,
} from "./types.ts";

export interface CommandOptions {
	readonly orchestrator: AgentOrchestrator;
}

export class Command {
	private readonly orchestrator: AgentOrchestrator;

	constructor(options: CommandOptions) {
		this.orchestrator = options.orchestrator;
	}

	listInputCommands(agentId: string): InputCommandInfo[] {
		return listInputCommands(this.orchestrator, agentId);
	}

	async executeInput(
		agentId: string,
		text: string,
		options?: CommandInputOptions,
	): Promise<CommandValue> {
		return await executeInput(this.orchestrator, agentId, text, options);
	}

	async execute(command: CommandRequest): Promise<CommandValue> {
		return await executeCommand(this.orchestrator, command);
	}
}

export function listInputCommands(
	orchestrator: AgentOrchestrator,
	agentId: string,
): InputCommandInfo[] {
	const record = requireAgentRecord(orchestrator, agentId);
	const builtinCommands = builtinInputCommands.map(
		(command): InputCommandInfo => ({
			inputInvoke: command.inputInvoke,
			source: {
				kind: "builtin",
				commandKind: command.kind,
			},
		}),
	);
	const reservedNames = builtinCommands.map(
		(command) => command.inputInvoke.name,
	);
	const extensionCommands =
		record.extensionRunner?.getInputCommands({ reservedNames }).map(
			(command): InputCommandInfo => ({
				inputInvoke: command.inputInvoke,
				source: {
					kind: "extension",
					extensionId: command.extensionId,
				},
			}),
		) ?? [];
	return [...builtinCommands, ...extensionCommands];
}

export async function executeInput(
	orchestrator: AgentOrchestrator,
	agentId: string,
	text: string,
	options?: CommandInputOptions,
): Promise<CommandValue> {
	if (options?.inputInvoke !== false) {
		const invocation = parseInputInvocation(text);
		if (invocation) {
			const builtin = builtinInputCommands.find(
				(command) => command.inputInvoke.name === invocation.name,
			);
			if (builtin) {
				return await executeBuiltinInputCommand(
					orchestrator,
					builtin.kind,
					agentId,
					invocation.args,
				);
			}

			const extensionCommand = requireAgentRecord(
				orchestrator,
				agentId,
			).extensionRunner?.getInputCommand(invocation.name, {
				reservedNames: getBuiltinInputCommandNames(),
			});
			if (extensionCommand) {
				await executeExtensionInputCommand(orchestrator, {
					agentId,
					extensionId: extensionCommand.extensionId,
					inputName: invocation.name,
					args: invocation.args,
				});
				return undefined;
			}
		}
	}

	return await orchestrator.promptAgent(agentId, text, {
		images: options?.images ? [...options.images] : undefined,
	});
}

export async function executeCommand(
	orchestrator: AgentOrchestrator,
	command: CommandRequest,
): Promise<CommandValue> {
	switch (command.kind) {
		case "agent.input":
			return await executeInput(orchestrator, command.agentId, command.text, {
				images: command.images,
				inputInvoke: command.inputInvoke,
			});
		case "agent.prompt":
			return await orchestrator.promptAgent(command.agentId, command.text, {
				images: command.images,
			});
		case "agent.steer":
			await orchestrator.steerAgent(command.agentId, command.text, {
				images: command.images,
			});
			return undefined;
		case "agent.followUp":
			await orchestrator.followUpAgent(command.agentId, command.text, {
				images: command.images,
			});
			return undefined;
		case "agent.nextTurn":
			await orchestrator.nextTurnAgent(command.agentId, command.text, {
				images: command.images,
			});
			return undefined;
		case "agent.abort":
			return await orchestrator.abortAgent(command.agentId);
		case "agent.new":
			return await orchestrator.newAgentSessionFromAgent(command.agentId);
		case "agent.listAgents":
			return orchestrator.listAgents();
		case "agent.listSessions":
			return await orchestrator.listAgentSessions();
		case "agent.resume":
			return await orchestrator.resumeAgentSessionByReference(
				command.reference,
			);
		case "agent.getSession":
			return await orchestrator.getAgentSession(command.agentId);
		case "agent.getSessionTree":
			return await orchestrator.getAgentSessionTree(command.agentId);
		case "agent.setSessionName":
			return await orchestrator.setAgentSessionName(
				command.agentId,
				command.name,
			);
		case "agent.fork":
			return await orchestrator.forkAgentSessionFromAgent(
				command.agentId,
				command.options,
			);
		case "agent.compact":
			return await orchestrator.compactAgent(
				command.agentId,
				command.customInstructions,
			);
		case "agent.navigateTree":
			return await orchestrator.navigateAgentTree(
				command.agentId,
				command.targetId,
				{
					summarize: command.summarize,
					customInstructions: command.customInstructions,
					replaceInstructions: command.replaceInstructions,
					label: command.label,
				},
			);
		case "agent.getModel":
			return orchestrator.getAgentModel(command.agentId);
		case "agent.setModel":
			await orchestrator.setAgentModel(command.agentId, command.model);
			return undefined;
		case "agent.getTools":
			return orchestrator.getAgentTools(command.agentId);
		case "agent.setTools":
			await orchestrator.setAgentTools(
				command.agentId,
				command.toolNames,
				command.activeToolNames,
			);
			return undefined;
		case "agent.getActiveTools":
			return orchestrator.getAgentActiveTools(command.agentId);
		case "agent.getInputCommands":
			return listInputCommands(orchestrator, command.agentId);
		case "agent.setActiveTools":
			await orchestrator.setAgentActiveTools(
				command.agentId,
				command.toolNames,
			);
			return undefined;
		case "agent.getStatus":
			return orchestrator.getAgentStatus(command.agentId);
		case "agent.inspect":
			return orchestrator.inspectAgent(command.agentId);
		case "agent.dispose":
			await orchestrator.disposeAgent(command.agentId, command.reason);
			return undefined;
		case "extension.reload":
			return await orchestrator.reloadExtensions({
				agentIds: command.agentIds,
			});
		case "human.request":
			return await orchestrator.requestHuman({
				...command.request,
				source: command.source,
			});
	}
}

async function executeBuiltinInputCommand(
	orchestrator: AgentOrchestrator,
	commandKind: BuiltinInputCommandKind,
	agentId: string,
	args: string,
): Promise<CommandValue> {
	switch (commandKind) {
		case "agent.abort":
			return await orchestrator.abortAgent(agentId);
		case "agent.compact":
			return await orchestrator.compactAgent(agentId, args.trim() || undefined);
		case "agent.followUp":
			await orchestrator.followUpAgent(
				agentId,
				requireInputText("follow-up", args),
			);
			return undefined;
		case "agent.fork": {
			const entryId = args.trim() || undefined;
			return await orchestrator.forkAgentSessionFromAgent(
				agentId,
				entryId ? { entryId } : undefined,
			);
		}
		case "agent.inspect":
			return orchestrator.inspectAgent(agentId);
		case "agent.listAgents":
			return orchestrator.listAgents();
		case "agent.setSessionName":
			return await orchestrator.setAgentSessionName(
				agentId,
				requireInputText("name", args),
			);
		case "agent.new":
			return await orchestrator.newAgentSessionFromAgent(agentId);
		case "extension.reload":
			return await orchestrator.reloadExtensions({ agentIds: [agentId] });
		case "agent.resume": {
			const reference = args.trim();
			if (!reference) return await orchestrator.listAgentSessions();
			return await orchestrator.resumeAgentSessionByReference(reference);
		}
		case "agent.listSessions":
			return await orchestrator.listAgentSessions();
		case "agent.getStatus":
			return orchestrator.getAgentStatus(agentId);
		case "agent.steer":
			await orchestrator.steerAgent(agentId, requireInputText("steer", args));
			return undefined;
		case "agent.getSessionTree": {
			const targetId = args.trim();
			if (!targetId) return await orchestrator.getAgentSessionTree(agentId);
			return await orchestrator.navigateAgentTree(agentId, targetId);
		}
	}
}

function requireInputText(commandName: string, args: string): string {
	const text = args.trim();
	if (!text) {
		throw new Error(`Input command /${commandName} requires text.`);
	}
	return text;
}

async function executeExtensionInputCommand(
	orchestrator: AgentOrchestrator,
	options: {
		readonly agentId: string;
		readonly extensionId: string;
		readonly inputName: string;
		readonly args: string;
	},
): Promise<void> {
	const runner = requireAgentRecord(
		orchestrator,
		options.agentId,
	).extensionRunner;
	if (!runner) return;
	const command = runner.getInputCommand(options.inputName, {
		reservedNames: getBuiltinInputCommandNames(),
	});
	if (!command) return;

	try {
		await command.handler(
			options.args,
			runner.createCommandContext(options.extensionId),
		);
	} catch (error) {
		await orchestrator.recordExtensionDiagnostics(options.agentId, [
			createDiagnostic({
				domain: "extension",
				code: "extension.command_failed",
				severity: "warning",
				disposition: "degraded",
				recoverable: true,
				message: `Extension '${options.extensionId}' input command '/${options.inputName}' failed: ${formatError(error)}`,
				source: { kind: "extension", id: options.extensionId },
				phase: "runtime",
				agentId: options.agentId,
				profileId: runner.profileId,
				extensionId: options.extensionId,
				details: {
					inputName: options.inputName,
					error: formatError(error),
				},
			}),
		]);
	}
}

function requireAgentRecord(
	orchestrator: AgentOrchestrator,
	agentId: string,
): AgentRecord {
	const record = orchestrator.agents.get(agentId);
	if (!record) {
		throw new Error(`Unknown agent: ${agentId}`);
	}
	return record;
}

interface CommandInputOptions {
	readonly images?: readonly ImageContent[];
	readonly inputInvoke?: boolean;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
