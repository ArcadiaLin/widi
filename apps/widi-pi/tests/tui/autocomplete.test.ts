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

function pendingProvider(overrides: Record<string, unknown> = {}) {
	return new WidiCommandAutocompleteProvider({
		engine: new CommandEngine(builtInCommands),
		orchestrator: overrides as unknown as AgentOrchestrator,
		getStatus: () => undefined,
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
			value: "/model",
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
		expect(applied.lines).toEqual(["/model"]);

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

	it("advances an exact command name to its argument candidates", async () => {
		const commandProvider = provider({
			listAgentSessions: async () => ({
				sessions: [
					{
						id: "alpha",
						path: "/sessions/a.jsonl",
						createdAt: "2026-01-01T00:00:00.000Z",
						cwd: "/workspace",
						name: "auth-fix",
						firstUserMessage: "Fix the flaky auth test",
					},
				],
			}),
		});
		const result = await commandProvider.getSuggestions(["/resume"], 0, 7, {
			signal: new AbortController().signal,
		});
		expect(result).toMatchObject({
			prefix: "/resume",
			items: [{ value: "/resume:/sessions/a.jsonl", label: "auth-fix" }],
		});
		if (!result?.items[0]) throw new Error("Expected argument completion.");
		const applied = commandProvider.applyCompletion(
			["/resume"],
			0,
			7,
			result.items[0],
			result.prefix,
		);
		expect(applied.lines).toEqual(["/resume:/sessions/a.jsonl"]);
	});

	it("returns no suggestions for an exact command without argument completion", async () => {
		const commandProvider = provider();
		await expect(
			commandProvider.getSuggestions(["/session"], 0, 8, {
				signal: new AbortController().signal,
			}),
		).resolves.toBeNull();
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

	it("marks active commands unavailable in pending suggestions", async () => {
		const result = await pendingProvider().getSuggestions(["/st"], 0, 3, {
			signal: new AbortController().signal,
		});
		const status = result?.items.find((item) => item.label === "/status");

		expect(status?.description).toContain("active agent");
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

	it("completes inline command arguments after the colon", async () => {
		const commandProvider = provider({
			listAgentSkillCandidates: async () => ({
				skills: [
					{
						value: "self-check",
						label: "self-check",
						description: "Run the harness self-check",
					},
				],
			}),
		});
		const signal = new AbortController().signal;

		const result = await commandProvider.getSuggestions(
			["use <skill:sel"],
			0,
			"use <skill:sel".length,
			{ signal },
		);
		expect(result).toMatchObject({
			prefix: "sel",
			items: [{ value: "self-check", label: "self-check" }],
		});
		if (!result?.items[0]) throw new Error("Expected argument completion.");
		const applied = commandProvider.applyCompletion(
			["use <skill:sel>"],
			0,
			"use <skill:sel".length,
			result.items[0],
			result.prefix,
		);
		expect(applied.lines).toEqual(["use <skill:self-check>"]);
	});

	it("completes inline command arguments on an empty argument prefix", async () => {
		const commandProvider = provider({
			listAgentSkillCandidates: async () => ({
				skills: [{ value: "self-check", label: "self-check" }],
			}),
		});
		const result = await commandProvider.getSuggestions(
			["use <skill:>"],
			0,
			"use <skill:".length,
			{ signal: new AbortController().signal },
		);
		expect(result).toMatchObject({
			prefix: "",
			items: [{ value: "self-check" }],
		});
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
