import type { BuiltinInputCommandDefinition } from "./types.ts";

export const builtinInputCommands = [
	{
		kind: "agent.abort",
		inputInvoke: {
			name: "abort",
			description: "Abort the current agent run.",
		},
	},
	{
		kind: "agent.compact",
		inputInvoke: {
			name: "compact",
			description: "Compact the current agent session.",
			argumentHint: "[instructions]",
		},
	},
	{
		kind: "agent.followUp",
		inputInvoke: {
			name: "follow-up",
			description: "Queue a follow-up for the current agent.",
			argumentHint: "<text>",
		},
	},
	{
		kind: "agent.fork",
		inputInvoke: {
			name: "fork",
			description: "Fork the current agent session.",
			argumentHint: "[entry]",
		},
	},
	{
		kind: "agent.inspect",
		inputInvoke: {
			name: "inspect",
			description: "Inspect the current agent runtime facts.",
		},
	},
	{
		kind: "agent.listAgents",
		inputInvoke: {
			name: "agent",
			description: "List runtime agents.",
		},
	},
	{
		kind: "agent.setSessionName",
		inputInvoke: {
			name: "name",
			description: "Name the current agent session.",
			argumentHint: "<name>",
		},
	},
	{
		kind: "agent.new",
		inputInvoke: {
			name: "new",
			description: "Start a new session from the current agent.",
		},
	},
	{
		kind: "extension.reload",
		inputInvoke: {
			name: "reload",
			description: "Reload extensions for the current agent.",
		},
	},
	{
		kind: "agent.resume",
		inputInvoke: {
			name: "resume",
			description: "Resume an existing agent session.",
			argumentHint: "[session]",
		},
	},
	{
		kind: "agent.listSessions",
		inputInvoke: {
			name: "session",
			description: "List persisted agent sessions.",
		},
	},
	{
		kind: "agent.getStatus",
		inputInvoke: {
			name: "status",
			description: "Get the current agent status.",
		},
	},
	{
		kind: "agent.steer",
		inputInvoke: {
			name: "steer",
			description: "Steer the current running agent.",
			argumentHint: "<text>",
		},
	},
	{
		kind: "agent.getSessionTree",
		inputInvoke: {
			name: "tree",
			description: "Inspect or navigate the current session tree.",
			argumentHint: "[entry]",
		},
	},
] as const satisfies readonly BuiltinInputCommandDefinition[];

export function getBuiltinInputCommandNames(): string[] {
	return builtinInputCommands.map((command) => command.inputInvoke.name);
}
