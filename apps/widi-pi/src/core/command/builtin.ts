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
		kind: "agent.inspect",
		inputInvoke: {
			name: "inspect",
			description: "Inspect the current agent runtime facts.",
		},
	},
	{
		kind: "extension.reload",
		inputInvoke: {
			name: "reload",
			description: "Reload extensions for the current agent.",
		},
	},
] as const satisfies readonly BuiltinInputCommandDefinition[];

export function getBuiltinInputCommandNames(): string[] {
	return builtinInputCommands.map((command) => command.inputInvoke.name);
}
