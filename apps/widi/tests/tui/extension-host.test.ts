import { describe, expect, it } from "vitest";
import type { OrchestratorDiagnostic } from "../../src/core/diagnostics.ts";
import type { ExtensionIdentity } from "../../src/core/extension/loader.ts";
import { CommandEngine } from "../../src/tui/commands/engine.ts";
import type { CommandDefinition } from "../../src/tui/commands/types.ts";
import { TuiExtensionHost, type TuiExtensionModuleImporter } from "../../src/tui/extension-host/index.ts";
import type { ToolExecutionItem } from "../../src/tui/state.ts";
import { defineLinesPresenter, presentToolExecution, unregisterToolPresenter } from "../../src/tui/tool-presenter.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function identity(id: string, entryPath: string): ExtensionIdentity {
	return {
		id,
		source: { kind: "file", path: entryPath, resolvedPath: entryPath, root: { kind: "agent_dir", path: "/ext" } },
		divisions: [],
	};
}

function testCommand(name: string, description?: string): CommandDefinition {
	return {
		kind: "action",
		agentPolicy: "runtime",
		name,
		description: description ?? `test command ${name}`,
		execute: async () => "ok",
	};
}

function toolItem(overrides: Partial<ToolExecutionItem>): ToolExecutionItem {
	return {
		type: "tool-execution",
		id: "tool-1",
		toolCallId: "tool-1",
		durability: "durable",
		createdAt: "2026-01-01T00:00:00.000Z",
		toolName: "ls",
		status: "completed",
		isError: false,
		...overrides,
	};
}

/**
 * Headless host fixture (host doc open question 5): no terminal, no jiti, no
 * file system. Fake module namespaces sit behind an injected importer; the
 * command engine and shortcut registry are the real ones, and diagnostics are
 * collected into an array.
 */
function createHostFixture() {
	const modules = new Map<string, unknown>();
	const moduleImporter: TuiExtensionModuleImporter = {
		importModuleNamespace: async (entryPath) => {
			if (!modules.has(entryPath)) throw new Error(`no such module: ${entryPath}`);
			return modules.get(entryPath);
		},
	};
	const engine = new CommandEngine();
	const diagnostics: OrchestratorDiagnostic[] = [];
	const activate = (entries: readonly [string, ExtensionIdentity][]) =>
		new TuiExtensionHost({
			identities: entries.map(([, id]) => id),
			commandEngine: engine,
			reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			moduleImporter,
		});
	return { modules, engine, diagnostics, activate };
}

describe("TuiExtensionHost", () => {
	it("runs the full chain: import, activate, register, dispose in reverse order", async () => {
		const fixture = createHostFixture();
		const calls: string[] = [];
		fixture.modules.set("/ext/alpha/index.ts", {
			tui: {
				apiVersion: 1,
				activate: (api: {
					registerCommand(d: CommandDefinition): void;
					registerShortcut(id: string, o: unknown): void;
					registerToolPresenter(t: string, p: unknown): void;
					onDispose(h: () => void): void;
					extensionId: string;
				}) => {
					expect(api.extensionId).toBe("alpha");
					api.registerCommand(testCommand("alpha-cmd"));
					api.registerShortcut("poke", { defaultKeys: "ctrl+x", handler: () => calls.push("shortcut") });
					api.registerToolPresenter(
						"alpha-tool",
						defineLinesPresenter({ describe: () => ({ verb: "Poke", target: "it" }) }),
					);
					api.onDispose(() => calls.push("alpha:onDispose"));
					return () => calls.push("alpha:returned");
				},
			},
		});
		fixture.modules.set("/ext/beta/index.ts", { tui: () => () => calls.push("beta:returned") });
		try {
			const host = fixture.activate([
				["alpha", identity("alpha", "/ext/alpha/index.ts")],
				["beta", identity("beta", "/ext/beta/index.ts")],
			]);
			await host.activate();

			expect(fixture.engine.get("alpha-cmd")?.description).toBe("test command alpha-cmd");
			expect(host.handleShortcut("\x18")).toBe(true);
			expect(calls).toEqual(["shortcut"]);
			const lines = presentToolExecution(toolItem({ toolName: "alpha-tool" }), 80).map((line) =>
				line.replace(ANSI_SEQUENCE, "").trimEnd(),
			);
			expect(lines).toEqual(["✓ Poke it"]);
			expect(fixture.diagnostics).toEqual([]);

			await host.dispose();
			// Reverse registration order: beta's returned dispose, then alpha's
			// returned dispose, then alpha's onDispose.
			expect(calls).toEqual(["shortcut", "beta:returned", "alpha:returned", "alpha:onDispose"]);
		} finally {
			unregisterToolPresenter("alpha-tool");
		}
	});

	it("skips extensions without a tui export silently", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/core-only/index.ts", { default: { apiVersion: 1, activate: () => {} } });

		const host = fixture.activate([["core-only", identity("core-only", "/ext/core-only/index.ts")]]);
		await host.activate();

		expect(fixture.diagnostics).toEqual([]);
	});

	it("skips factory-sourced identities: no entry file can carry a tui half", async () => {
		const fixture = createHostFixture();
		const factoryIdentity: ExtensionIdentity = { id: "programmatic", source: { kind: "factory" }, divisions: [] };

		const host = fixture.activate([["programmatic", factoryIdentity]]);
		await host.activate();

		expect(fixture.diagnostics).toEqual([]);
	});

	it("isolates a throwing activation and still activates the rest", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/broken/index.ts", {
			tui: {
				apiVersion: 1,
				activate: () => {
					throw new Error("boom");
				},
			},
		});
		fixture.modules.set("/ext/healthy/index.ts", {
			tui: (api: { registerCommand(d: CommandDefinition): void }) => {
				api.registerCommand(testCommand("healthy-cmd"));
			},
		});

		const host = fixture.activate([
			["broken", identity("broken", "/ext/broken/index.ts")],
			["healthy", identity("healthy", "/ext/healthy/index.ts")],
		]);
		await host.activate();

		expect(fixture.diagnostics).toHaveLength(1);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "error",
			code: "tui_extension.activation_failed",
			extensionId: "broken",
		});
		expect(fixture.diagnostics[0]?.message).toContain("boom");
		expect(fixture.engine.get("healthy-cmd")).toBeDefined();
	});

	it("reports a failed import as a diagnostic and moves on", async () => {
		const fixture = createHostFixture();

		const host = fixture.activate([["missing", identity("missing", "/ext/missing/index.ts")]]);
		await host.activate();

		expect(fixture.diagnostics).toHaveLength(1);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "error",
			code: "tui_extension.load_failed",
			extensionId: "missing",
		});
	});

	it("refuses an unsupported tui apiVersion without touching the extension", async () => {
		const fixture = createHostFixture();
		let activated = false;
		fixture.modules.set("/ext/future/index.ts", {
			tui: {
				apiVersion: 99,
				activate: () => {
					activated = true;
				},
			},
		});

		const host = fixture.activate([["future", identity("future", "/ext/future/index.ts")]]);
		await host.activate();

		expect(activated).toBe(false);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "error",
			code: "tui_extension.version_incompatible",
			extensionId: "future",
		});
	});

	it("rejects a malformed tui export", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/malformed/index.ts", { tui: 42 });

		const host = fixture.activate([["malformed", identity("malformed", "/ext/malformed/index.ts")]]);
		await host.activate();

		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "error",
			code: "tui_extension.definition_invalid",
			extensionId: "malformed",
		});
	});

	it("projects a command name conflict with the extension id attached", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/first/index.ts", {
			tui: (api: { registerCommand(d: CommandDefinition): void }) => api.registerCommand(testCommand("same")),
		});
		fixture.modules.set("/ext/second/index.ts", {
			tui: (api: { registerCommand(d: CommandDefinition): void }) =>
				api.registerCommand(testCommand("same", "second registration")),
		});

		const host = fixture.activate([
			["first", identity("first", "/ext/first/index.ts")],
			["second", identity("second", "/ext/second/index.ts")],
		]);
		await host.activate();

		expect(fixture.diagnostics).toHaveLength(1);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "command.name_conflict",
			extensionId: "second",
		});
		expect(fixture.engine.get("same")?.description).toBe("test command same");
	});

	it("dispatches a shortcut on its default keys and honors user overrides", async () => {
		const fixture = createHostFixture();
		const calls: string[] = [];
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: { registerShortcut(id: string, o: { defaultKeys: string; handler(): void }): void }) => {
				api.registerShortcut("poke", { defaultKeys: "ctrl+x", handler: () => calls.push("poke") });
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		expect(host.keybindingDefinitions["ext.acme.poke"]?.defaultKeys).toBe("ctrl+x");
		expect(host.handleShortcut("\x18")).toBe(true);
		expect(calls).toEqual(["poke"]);

		host.setUserKeybindings({ "ext.acme.poke": "ctrl+g" });
		expect(host.handleShortcut("\x18")).toBe(false);
		expect(host.handleShortcut("\x07")).toBe(true);
		expect(calls).toEqual(["poke", "poke"]);
	});

	it("refuses an invalid binding id and a duplicate action", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: { registerShortcut(id: string, o: unknown): void }) => {
				api.registerShortcut("  ", { defaultKeys: "ctrl+x", handler: () => {} });
				api.registerShortcut("poke", { defaultKeys: "ctrl+x", handler: () => {} });
				api.registerShortcut("poke", { defaultKeys: "ctrl+g", handler: () => {} });
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		expect(fixture.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"tui_extension.shortcut_invalid",
			"tui_extension.shortcut_conflict",
		]);
	});

	it("contains a throwing shortcut handler", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: { registerShortcut(id: string, o: unknown): void }) => {
				api.registerShortcut("poke", {
					defaultKeys: "ctrl+x",
					handler: () => {
						throw new Error("handler boom");
					},
				});
			},
		});

		const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
		await host.activate();

		expect(host.handleShortcut("\x18")).toBe(true);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "tui_extension.shortcut_failed",
			extensionId: "acme",
		});
	});

	it("forwards the built-in override diagnostic when a presenter shadows one", async () => {
		const fixture = createHostFixture();
		fixture.modules.set("/ext/acme/index.ts", {
			tui: (api: { registerToolPresenter(t: string, p: unknown): void }) => {
				api.registerToolPresenter("bash", defineLinesPresenter({ describe: () => ({ verb: "Mine", target: "" }) }));
			},
		});
		try {
			const host = fixture.activate([["acme", identity("acme", "/ext/acme/index.ts")]]);
			await host.activate();

			expect(fixture.diagnostics[0]).toMatchObject({
				severity: "warning",
				code: "tool_presenter.overridden",
				extensionId: "acme",
			});
			const lines = presentToolExecution(toolItem({ toolName: "bash", args: { command: "ls" } }), 80).map((line) =>
				line.replace(ANSI_SEQUENCE, "").trimEnd(),
			);
			expect(lines).toEqual(["✓ Mine"]);
		} finally {
			unregisterToolPresenter("bash");
		}
	});

	it("reports a throwing disposer and still runs the rest", async () => {
		const fixture = createHostFixture();
		const calls: string[] = [];
		fixture.modules.set("/ext/one/index.ts", {
			tui: () => () => {
				throw new Error("dispose boom");
			},
		});
		fixture.modules.set("/ext/two/index.ts", { tui: () => () => calls.push("two") });

		const host = fixture.activate([
			["one", identity("one", "/ext/one/index.ts")],
			["two", identity("two", "/ext/two/index.ts")],
		]);
		await host.activate();
		await host.dispose();

		expect(calls).toEqual(["two"]);
		expect(fixture.diagnostics[0]).toMatchObject({
			severity: "warning",
			code: "tui_extension.dispose_failed",
			extensionId: "one",
		});
	});
});
