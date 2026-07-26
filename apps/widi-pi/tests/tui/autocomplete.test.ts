import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function atProvider(cwd: string) {
	return new WidiCommandAutocompleteProvider({
		engine: new CommandEngine(builtInCommands),
		agentId: "main",
		orchestrator: {} as unknown as AgentOrchestrator,
		getStatus: () => "idle",
		cwd,
		// Force the Node fallback regardless of whether fd is installed.
		fdPath: null,
	});
}

function signal() {
	return new AbortController().signal;
}

describe("WidiCommandAutocompleteProvider", () => {
	it("completes command names and lands the cursor in argument position", async () => {
		const commandProvider = provider();
		const commands = await commandProvider.getSuggestions(["/mo"], 0, 3, {
			signal: signal(),
		});
		expect(commands?.items[0]).toMatchObject({
			value: "/model",
			label: "/model",
		});
		expect(commands?.prefix).toBe("/mo");
		if (!commands?.items[0]) throw new Error("Expected command completion.");
		const applied = commandProvider.applyCompletion(
			["/mo"],
			0,
			3,
			commands.items[0],
			commands.prefix,
		);
		expect(applied.lines).toEqual(["/model "]);
		expect(applied.cursorCol).toBe("/model ".length);
	});

	it("completes command arguments after a space", async () => {
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
		const result = await commandProvider.getSuggestions(
			["/model ant"],
			0,
			"/model ant".length,
			{ signal: signal() },
		);
		expect(result).toMatchObject({
			prefix: "ant",
			items: [{ value: "anthropic/claude", label: "claude" }],
		});
		if (!result?.items[0]) throw new Error("Expected argument completion.");
		const applied = commandProvider.applyCompletion(
			["/model ant"],
			0,
			"/model ant".length,
			result.items[0],
			result.prefix,
		);
		expect(applied.lines).toEqual(["/model anthropic/claude"]);
		expect(applied.cursorCol).toBe("/model anthropic/claude".length);
	});

	it("filters argument candidates by case-insensitive prefix on value or label", async () => {
		const commandProvider = provider({
			listAvailableModelCandidates: async () => ({
				models: [
					{ value: "anthropic/claude", label: "Claude" },
					{ value: "openai/gpt", label: "GPT" },
				],
			}),
		});
		const byValue = await commandProvider.getSuggestions(
			["/model ANT"],
			0,
			"/model ANT".length,
			{ signal: signal() },
		);
		expect(byValue?.items.map((item) => item.value)).toEqual([
			"anthropic/claude",
		]);
		const byLabel = await commandProvider.getSuggestions(
			["/model gpt"],
			0,
			"/model gpt".length,
			{ signal: signal() },
		);
		expect(byLabel?.items.map((item) => item.value)).toEqual(["openai/gpt"]);
	});

	it("falls back to fuzzy filtering when no prefix matches", async () => {
		const commandProvider = provider({
			listAvailableModelCandidates: async () => ({
				models: [{ value: "fast-mode", label: "fast-mode" }],
			}),
		});
		const result = await commandProvider.getSuggestions(
			["/model fm"],
			0,
			"/model fm".length,
			{ signal: signal() },
		);
		expect(result?.items.map((item) => item.value)).toEqual(["fast-mode"]);
	});

	it("closes the menu on a sole exact argument match", async () => {
		const commandProvider = provider({
			listAvailableModelCandidates: async () => ({
				models: [{ value: "safe", label: "safe" }],
			}),
		});
		await expect(
			commandProvider.getSuggestions(["/model safe"], 0, "/model safe".length, {
				signal: signal(),
			}),
		).resolves.toBeNull();
	});

	it("no longer advances an exact command name to its argument candidates", async () => {
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
			signal: signal(),
		});
		expect(result?.prefix).toBe("/resume");
		expect(result?.items.map((item) => item.value)).toEqual(["/resume"]);
	});

	it("returns no argument suggestions without a completer", async () => {
		const commandProvider = provider();
		await expect(
			commandProvider.getSuggestions(["/session foo"], 0, 12, {
				signal: signal(),
			}),
		).resolves.toBeNull();
		await expect(
			commandProvider.getSuggestions(["/nope foo"], 0, 10, {
				signal: signal(),
			}),
		).resolves.toBeNull();
	});

	it("contains failures from argument completers", async () => {
		const commandProvider = provider({
			listAvailableModelCandidates: async () => {
				throw new Error("completion failed");
			},
		});
		await expect(
			commandProvider.getSuggestions(["/model value"], 0, 12, {
				signal: signal(),
			}),
		).resolves.toBeNull();
	});

	it("marks status-gated commands unavailable in suggestions", async () => {
		const commandProvider = provider();
		const result = await commandProvider.getSuggestions(["/st"], 0, 3, {
			signal: signal(),
		});
		const steer = result?.items.find((item) => item.label === "/steer");
		expect(steer?.description).toContain(
			"unavailable: Command /steer requires a running agent",
		);
	});

	it("marks active commands unavailable in pending suggestions", async () => {
		const result = await pendingProvider().getSuggestions(["/st"], 0, 3, {
			signal: signal(),
		});
		const status = result?.items.find((item) => item.label === "/status");

		expect(status?.description).toContain("active agent");
	});

	it("places the cursor inside a closed inline command", async () => {
		const commandProvider = provider();
		const result = await commandProvider.getSuggestions(["use <sk"], 0, 7, {
			signal: signal(),
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
		const result = await commandProvider.getSuggestions(
			["use <skill:sel"],
			0,
			"use <skill:sel".length,
			{ signal: signal() },
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
			{ signal: signal() },
		);
		expect(result).toMatchObject({
			prefix: "",
			items: [{ value: "self-check" }],
		});
	});
});

describe("WidiCommandAutocompleteProvider @ fallback", () => {
	function fixture() {
		const cwd = mkdtempSync(join(tmpdir(), "widi-at-"));
		writeFileSync(join(cwd, "alpha.txt"), "alpha");
		writeFileSync(join(cwd, "with space.txt"), "space");
		mkdirSync(join(cwd, "beta"));
		writeFileSync(join(cwd, "beta", "inner.ts"), "inner");
		mkdirSync(join(cwd, ".git"));
		writeFileSync(join(cwd, ".git", "config"), "git");
		return cwd;
	}

	it("triggers on @ via the provider trigger characters", () => {
		expect(provider().triggerCharacters).toContain("@");
	});

	it("completes @ mentions through the Node fallback when fd is missing", async () => {
		const commandProvider = atProvider(fixture());
		const result = await commandProvider.getSuggestions(
			["say @alp"],
			0,
			"say @alp".length,
			{ signal: signal() },
		);
		expect(result).toMatchObject({
			prefix: "@alp",
			items: [{ value: "@alpha.txt", label: "alpha.txt" }],
		});
		if (!result?.items[0]) throw new Error("Expected @ completion.");
		const applied = commandProvider.applyCompletion(
			["say @alp"],
			0,
			"say @alp".length,
			result.items[0],
			result.prefix,
		);
		expect(applied.lines).toEqual(["say @alpha.txt "]);
		expect(applied.cursorCol).toBe("say @alpha.txt ".length);
	});

	it("ranks directories first on an empty query and skips .git", async () => {
		const commandProvider = atProvider(fixture());
		const result = await commandProvider.getSuggestions(["@"], 0, 1, {
			signal: signal(),
		});
		expect(result?.items[0]).toMatchObject({ value: "@beta/", label: "beta/" });
		const descriptions = result?.items.map((item) => item.description) ?? [];
		expect(descriptions.some((entry) => entry?.includes(".git"))).toBe(false);
	});

	it("quotes values that contain spaces", async () => {
		const commandProvider = atProvider(fixture());
		const result = await commandProvider.getSuggestions(["@with"], 0, 5, {
			signal: signal(),
		});
		expect(result?.items.map((item) => item.value)).toEqual([
			'@"with space.txt"',
		]);
	});

	it("returns null when the @ query matches nothing", async () => {
		const commandProvider = atProvider(fixture());
		await expect(
			commandProvider.getSuggestions(["@zzz"], 0, 4, { signal: signal() }),
		).resolves.toBeNull();
	});
});
