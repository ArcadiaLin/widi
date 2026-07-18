import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import { WidiCommandAutocompleteProvider } from "../../src/tui/autocomplete.ts";
import { builtInCommands } from "../../src/tui/commands/built-ins.ts";
import { CommandEngine } from "../../src/tui/commands/engine.ts";

function provider(overrides: Record<string, unknown> = {}) {
	return new WidiCommandAutocompleteProvider({
		engine: new CommandEngine(builtInCommands),
		agentId: "main",
		orchestrator: overrides as unknown as AgentOrchestrator,
		getStatus: () => "idle",
	});
}

describe("WidiCommandAutocompleteProvider", () => {
	it("completes WIDI line commands with colon argument syntax", async () => {
		const commandProvider = provider({
			listAvailableModelCandidates: async () => ({
				models: [
					{
						value: "anthropic/claude",
						label: "claude",
						description: "anthropic",
					},
				],
			}),
		});
		const signal = new AbortController().signal;

		const commands = await commandProvider.getSuggestions(["/mo"], 0, 3, {
			signal,
		});
		expect(commands?.items[0]).toMatchObject({
			value: "/model:",
			label: "/model",
		});
		if (!commands?.items[0]) throw new Error("Expected command completion.");
		const applied = commandProvider.applyCompletion(
			["/mo"],
			0,
			3,
			commands.items[0],
			commands.prefix,
		);
		expect(applied.lines).toEqual(["/model:"]);

		const argumentsResult = await commandProvider.getSuggestions(
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

	it("marks status-gated commands unavailable in suggestions", async () => {
		const commandProvider = provider();
		const result = await commandProvider.getSuggestions(["/st"], 0, 3, {
			signal: new AbortController().signal,
		});
		const steer = result?.items.find((item) => item.label === "/steer");
		expect(steer?.description).toContain(
			"unavailable: Command /steer requires a running agent",
		);
	});

	it("places the cursor inside a closed inline command", async () => {
		const commandProvider = provider();
		const result = await commandProvider.getSuggestions(["use <sk"], 0, 7, {
			signal: new AbortController().signal,
		});
		if (!result?.items[0]) throw new Error("Expected inline completion.");
		const applied = commandProvider.applyCompletion(
			["use <sk"],
			0,
			7,
			result.items[0],
			result.prefix,
		);
		expect(applied.lines).toEqual(["use <skill:>"]);
		expect(applied.cursorCol).toBe("use <skill:".length);
	});

	it("contains failures from argument completers", async () => {
		const commandProvider = provider({
			listAvailableModelCandidates: async () => {
				throw new Error("completion failed");
			},
		});

		await expect(
			commandProvider.getSuggestions(["/model:value"], 0, 12, {
				signal: new AbortController().signal,
			}),
		).resolves.toBeNull();
	});
});
