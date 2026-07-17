import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { Command } from "../../src/core/command.ts";
import { WidiCommandAutocompleteProvider } from "../../src/tui/autocomplete.ts";

describe("WidiCommandAutocompleteProvider", () => {
	it("completes WIDI line commands with colon argument syntax", async () => {
		const provider = new WidiCommandAutocompleteProvider({
			commands: [
				command("model", {
					argumentHint: "[provider/model]",
					arguments: {
						complete: async () => [
							{
								value: "anthropic/claude",
								label: "claude",
								description: "anthropic",
							},
						],
					},
				}),
			],
			agentId: "main",
			orchestrator: {} as AgentOrchestrator,
		});
		const signal = new AbortController().signal;

		const commands = await provider.getSuggestions(["/mo"], 0, 3, {
			signal,
		});
		expect(commands?.items[0]).toMatchObject({
			value: "/model:",
			label: "/model",
		});
		if (!commands?.items[0]) throw new Error("Expected command completion.");
		const applied = provider.applyCompletion(
			["/mo"],
			0,
			3,
			commands.items[0],
			commands.prefix,
		);
		expect(applied.lines).toEqual(["/model:"]);

		const argumentsResult = await provider.getSuggestions(
			["/model:ant"],
			0,
			10,
			{ signal },
		);
		expect(argumentsResult).toMatchObject({
			prefix: "ant",
			items: [{ value: "anthropic/claude" }],
		});
	});

	it("places the cursor inside a closed inline command", async () => {
		const provider = new WidiCommandAutocompleteProvider({
			commands: [
				{
					...command("skill"),
					placement: "inline",
					trigger: "<",
					closeTrigger: ">",
				},
			],
			agentId: "main",
			orchestrator: {} as AgentOrchestrator,
		});
		const result = await provider.getSuggestions(["use <sk"], 0, 7, {
			signal: new AbortController().signal,
		});
		if (!result?.items[0]) throw new Error("Expected inline completion.");
		const applied = provider.applyCompletion(
			["use <sk"],
			0,
			7,
			result.items[0],
			result.prefix,
		);
		expect(applied.lines).toEqual(["use <skill:>"]);
		expect(applied.cursorCol).toBe("use <skill:".length);
	});

	it("contains failures from extension argument completers", async () => {
		const provider = new WidiCommandAutocompleteProvider({
			commands: [
				command("broken", {
					arguments: {
						complete: async () => {
							throw new Error("extension failed");
						},
					},
				}),
			],
			agentId: "main",
			orchestrator: {} as AgentOrchestrator,
		});

		await expect(
			provider.getSuggestions(["/broken:value"], 0, 13, {
				signal: new AbortController().signal,
			}),
		).resolves.toBeNull();
	});
});

function command(name: string, override: Partial<Command> = {}): Command {
	return {
		name,
		placement: "line",
		trigger: "/",
		source: { kind: "built-in" },
		...override,
	};
}
