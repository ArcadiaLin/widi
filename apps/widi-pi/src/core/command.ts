import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	AgentId,
	AgentLifecycleStatus,
	AgentOrchestrator,
} from "./agent-orchestrator.ts";
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

// Command status requirement declared on a binding: returns the reason the
// current agent status blocks the command, or undefined when it may run.
export type CommandStatusCheck = (
	status: AgentLifecycleStatus,
) => string | undefined;

export interface BuiltInCommandBinding {
	readonly command: Command;
	readonly checkStatus?: CommandStatusCheck;
	execute(
		orchestrator: AgentOrchestrator,
		agentId: AgentId,
		args: string,
	): Promise<unknown>;
}

// Built-in command execution
export const BUILT_IN_COMMANDS: readonly BuiltInCommandBinding[] = [
	{
		command: {
			name: "abort",
			placement: "line",
			trigger: "/",
			description: "Abort the current agent run.",
			source: { kind: "built-in" },
		},
		execute: async (orchestrator, agentId) =>
			await orchestrator.abortAgent(agentId),
	},
	{
		command: {
			name: "compact",
			placement: "line",
			trigger: "/",
			description: "Compact the current agent session.",
			argumentHint: "[instructions]",
			source: { kind: "built-in" },
		},
		execute: async (orchestrator, agentId, args) =>
			await orchestrator.compactAgent(agentId, args.trim() || undefined),
	},
	{
		command: {
			name: "follow-up",
			placement: "line",
			trigger: "/",
			description: "Queue a follow-up for the current agent.",
			argumentHint: "<text>",
			source: { kind: "built-in" },
			arguments: { required: true },
		},
		execute: async (orchestrator, agentId, args) => {
			await orchestrator.followUpAgent(agentId, args.trim());
			return undefined;
		},
	},
	{
		command: {
			name: "fork",
			placement: "line",
			trigger: "/",
			description: "Fork the current agent session.",
			argumentHint: "[entry]",
			source: { kind: "built-in" },
			scope: "user-facing",
		},
		execute: async (orchestrator, agentId, args) => {
			const entryId = args.trim() || undefined;
			return await orchestrator.forkAgentSessionFromAgent(
				agentId,
				entryId ? { entryId } : undefined,
			);
		},
	},
	{
		command: {
			name: "inspect",
			placement: "line",
			trigger: "/",
			description: "Inspect the current agent runtime facts.",
			source: { kind: "built-in" },
		},
		execute: async (orchestrator, agentId) =>
			orchestrator.inspectAgent(agentId),
	},
	{
		command: {
			name: "agent",
			placement: "line",
			trigger: "/",
			description: "List runtime agents.",
			source: { kind: "built-in" },
		},
		execute: async (orchestrator) => orchestrator.listAgents(),
	},
	{
		command: {
			name: "model",
			placement: "line",
			trigger: "/",
			description: "Set the current agent model.",
			argumentHint: "[provider/model]",
			source: { kind: "built-in" },
		},
		execute: async (orchestrator, agentId, args) => {
			const reference = args.trim();
			if (!reference) return await orchestrator.listAvailableModelCandidates();
			return await orchestrator.setAgentModelByReference(agentId, reference);
		},
	},
	{
		command: {
			name: "thinking",
			placement: "line",
			trigger: "/",
			description: "Set the current agent thinking level.",
			argumentHint: "[level]",
			source: { kind: "built-in" },
		},
		execute: async (orchestrator, agentId, args) => {
			const level = args.trim();
			if (!level) return orchestrator.listAgentThinkingLevelCandidates(agentId);
			return await orchestrator.setAgentThinkingLevelByName(agentId, level);
		},
	},
	{
		command: {
			name: "name",
			placement: "line",
			trigger: "/",
			description: "Name the current agent session.",
			argumentHint: "<name>",
			source: { kind: "built-in" },
			arguments: { required: true },
		},
		execute: async (orchestrator, agentId, args) =>
			await orchestrator.setAgentSessionName(agentId, args.trim()),
	},
	{
		command: {
			name: "new",
			placement: "line",
			trigger: "/",
			description: "Start a new session from the current agent.",
			source: { kind: "built-in" },
			scope: "user-facing",
		},
		execute: async (orchestrator, agentId) =>
			await orchestrator.newAgentSessionFromAgent(agentId),
	},
	{
		command: {
			name: "reload",
			placement: "line",
			trigger: "/",
			description: "Reload extensions for the current agent.",
			source: { kind: "built-in" },
		},
		execute: async (orchestrator, agentId) =>
			await orchestrator.reloadExtensions({ agentIds: [agentId] }),
	},
	{
		command: {
			name: "resume",
			placement: "line",
			trigger: "/",
			description: "Resume an existing agent session.",
			argumentHint: "[session]",
			source: { kind: "built-in" },
			scope: "user-facing",
		},
		checkStatus: (status) =>
			status === "running"
				? "Command /resume is not available while the agent is running."
				: undefined,
		execute: async (orchestrator, _agentId, args) => {
			const reference = args.trim();
			if (!reference) return await orchestrator.listAgentSessions();
			return await orchestrator.resumeAgentSessionByReference(reference);
		},
	},
	{
		command: {
			name: "session",
			placement: "line",
			trigger: "/",
			description: "List persisted agent sessions.",
			source: { kind: "built-in" },
		},
		execute: async (orchestrator) => await orchestrator.listAgentSessions(),
	},
	{
		command: {
			name: "status",
			placement: "line",
			trigger: "/",
			description: "Get the current agent status.",
			source: { kind: "built-in" },
		},
		execute: async (orchestrator, agentId) =>
			orchestrator.getAgentStatus(agentId),
	},
	{
		command: {
			name: "steer",
			placement: "line",
			trigger: "/",
			description: "Steer the current running agent.",
			argumentHint: "<text>",
			source: { kind: "built-in" },
			arguments: { required: true },
		},
		checkStatus: (status) =>
			status === "running"
				? undefined
				: `Command /steer requires a running agent (status: ${status}).`,
		execute: async (orchestrator, agentId, args) => {
			await orchestrator.steerAgent(agentId, args.trim());
			return undefined;
		},
	},
	{
		command: {
			name: "tree",
			placement: "line",
			trigger: "/",
			description: "Inspect or navigate the current session tree.",
			argumentHint: "[entry]",
			source: { kind: "built-in" },
		},
		execute: async (orchestrator, agentId, args) => {
			const targetId = args.trim();
			if (!targetId) return await orchestrator.getAgentSessionTree(agentId);
			return await orchestrator.navigateAgentTree(agentId, targetId);
		},
	},
];

export function getBuiltInCommands(): Command[] {
	return BUILT_IN_COMMANDS.map((binding) => binding.command);
}

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
