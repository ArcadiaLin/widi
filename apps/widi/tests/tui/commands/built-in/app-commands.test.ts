import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../../../src/core/agent-orchestrator.ts";
import { applicationCommands } from "../../../../src/tui/commands/built-in/index.ts";
import { CommandEngine } from "../../../../src/tui/commands/engine.ts";
import { DiagnosticsLog } from "../../../../src/tui/diagnostics-log.ts";

const NOW = "2026-08-09T10:00:00.000Z";

function setup(status: "idle" | "running" = "idle") {
	const host = {
		quitCalls: 0,
		newSessionCalls: [] as Array<string | undefined>,
		disposeAgentCalls: [] as string[],
		copied: [] as string[],
		diagnostics: new DiagnosticsLog(),
		quit() {
			this.quitCalls += 1;
		},
		async newSession(sourceAgentId: string | undefined) {
			this.newSessionCalls.push(sourceAgentId);
		},
		async disposeAgent(agentId: string) {
			this.disposeAgentCalls.push(agentId);
		},
		async copyText(text: string) {
			this.copied.push(text);
		},
	};
	const engine = new CommandEngine(applicationCommands(host));
	const context = {
		agentId: "agent-1",
		orchestrator: { getAgentStatus: () => status } as unknown as AgentOrchestrator,
	};
	return { engine, host, context };
}

describe("applicationCommands", () => {
	it("executes /quit through the engine and notifies the host", async () => {
		const { engine, host, context } = setup();
		const outcome = await engine.handleInput("/quit", context);
		expect(outcome).toMatchObject({ kind: "executed", name: "quit" });
		expect(host.quitCalls).toBe(1);
	});

	it("executes /exit as an alias of /quit", async () => {
		const { engine, host, context } = setup();
		const outcome = await engine.handleInput("/exit", context);
		expect(outcome).toMatchObject({ kind: "executed", name: "exit" });
		expect(host.quitCalls).toBe(1);
	});

	it("stays available while the agent is running", async () => {
		const { engine, host, context } = setup("running");
		for (const view of engine.list({ activity: "running" })) {
			expect(view.available).toBe(true);
		}
		const outcome = await engine.handleInput("/quit", context);
		expect(outcome.kind).toBe("executed");
		expect(host.quitCalls).toBe(1);
		const disposeOutcome = await engine.handleInput("/dispose", context);
		expect(disposeOutcome).toMatchObject({ kind: "executed", name: "dispose" });
		expect(host.disposeAgentCalls).toEqual(["agent-1"]);
	});

	it("hands /new to the application without creating a core agent", async () => {
		const { engine, host, context } = setup();
		const outcome = await engine.handleInput("/new", context);

		expect(outcome).toMatchObject({ kind: "executed", name: "new" });
		expect(host.newSessionCalls).toEqual(["agent-1"]);
	});

	it("executes /clear as an alias of /new", async () => {
		const { engine, host, context } = setup();
		const outcome = await engine.handleInput("/clear", context);

		expect(outcome).toMatchObject({ kind: "executed", name: "clear" });
		expect(host.newSessionCalls).toEqual(["agent-1"]);
	});

	it("hands /dispose to the application for the active agent", async () => {
		const { engine, host, context } = setup();
		const outcome = await engine.handleInput("/dispose", context);

		expect(outcome).toMatchObject({ kind: "executed", name: "dispose" });
		expect(host.disposeAgentCalls).toEqual(["agent-1"]);
	});

	it("rejects /dispose without an active agent", async () => {
		const { engine, host, context } = setup();
		const outcome = await engine.handleInput("/dispose", { orchestrator: context.orchestrator });

		expect(outcome).toMatchObject({ kind: "failed", error: { message: expect.stringContaining("active agent") } });
		expect(host.disposeAgentCalls).toEqual([]);
	});

	it("says so instead of opening an empty selector when nothing was reported", async () => {
		const { engine, context } = setup();
		const outcome = await engine.handleInput("/diagnostics", context);

		expect(outcome).toMatchObject({ kind: "executed", value: "No diagnostics reported this session." });
	});

	it("offers every recorded diagnostic, newest first, with source and phase on the label", async () => {
		const { engine, host, context } = setup();
		host.diagnostics.record({ severity: "warning", code: "theme.unreadable", message: "theme.json" }, NOW);
		host.diagnostics.phase = "runtime";
		host.diagnostics.record(
			{ severity: "error", code: "mcp.connect_failed", message: "docs server", extensionId: "mcp" },
			NOW,
		);

		const outcome = await engine.handleInput("/diagnostics", context);

		expect(outcome.kind).toBe("needs-argument");
		const candidates = outcome.kind === "needs-argument" ? outcome.candidates : [];
		expect(candidates.map((candidate) => candidate.label)).toEqual([
			"✕ mcp.connect_failed · extension mcp · runtime",
			"▲ theme.unreadable · theme · startup",
		]);
		expect(candidates[0]?.description).toBe("docs server");
	});

	it("copies the whole entry when one is picked", async () => {
		const { engine, host, context } = setup();
		const record = host.diagnostics.record(
			{ severity: "error", code: "mcp.connect_failed", message: "docs server\nrefused" },
			NOW,
		);

		const outcome = await engine.handleInput(`/diagnostics ${record.id}`, context);

		expect(outcome).toMatchObject({ kind: "executed", value: "Copied mcp.connect_failed to the clipboard." });
		expect(host.copied).toEqual([`error · mcp.connect_failed · mcp · startup · ${NOW}\ndocs server\nrefused`]);
	});

	it("fails on an entry the empty log cannot offer rather than copying nothing", async () => {
		const { engine, host, context } = setup();

		const outcome = await engine.handleInput("/diagnostics d9", context);

		expect(outcome).toMatchObject({ kind: "failed", error: { message: expect.stringContaining("d9") } });
		expect(host.copied).toEqual([]);
	});

	it("reopens the selector on an id that does not match a recorded entry", async () => {
		const { engine, host, context } = setup();
		host.diagnostics.record({ severity: "warning", code: "theme.unreadable", message: "theme.json" }, NOW);

		const outcome = await engine.handleInput("/diagnostics d9", context);

		expect(outcome).toMatchObject({ kind: "open-selector", query: "d9" });
		expect(host.copied).toEqual([]);
	});
});
