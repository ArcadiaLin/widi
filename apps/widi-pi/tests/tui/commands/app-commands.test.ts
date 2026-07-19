import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../../src/core/agent-orchestrator.ts";
import { applicationCommands } from "../../../src/tui/commands/app-commands.ts";
import { CommandEngine } from "../../../src/tui/commands/engine.ts";

function setup(status: "idle" | "running" = "idle") {
	const host = {
		quitCalls: 0,
		newSessionCalls: [] as Array<string | undefined>,
		disposeAgentCalls: [] as string[],
		quit() {
			this.quitCalls += 1;
		},
		newSession(sourceAgentId: string | undefined) {
			this.newSessionCalls.push(sourceAgentId);
		},
		async disposeAgent(agentId: string) {
			this.disposeAgentCalls.push(agentId);
		},
	};
	const engine = new CommandEngine(applicationCommands(host));
	const context = {
		agentId: "agent-1",
		orchestrator: {
			getAgentStatus: () => status,
		} as unknown as AgentOrchestrator,
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
		for (const view of engine.list("running")) {
			expect(view.available).toBe(true);
		}
		const outcome = await engine.handleInput("/quit", context);
		expect(outcome.kind).toBe("executed");
		expect(host.quitCalls).toBe(1);
		const disposeOutcome = await engine.handleInput("/dispose", context);
		expect(disposeOutcome).toMatchObject({
			kind: "executed",
			name: "dispose",
		});
		expect(host.disposeAgentCalls).toEqual(["agent-1"]);
	});

	it("hands /new to the application without creating a core agent", async () => {
		const { engine, host, context } = setup();
		const outcome = await engine.handleInput("/new", context);

		expect(outcome).toMatchObject({ kind: "executed", name: "new" });
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
		const outcome = await engine.handleInput("/dispose", {
			orchestrator: context.orchestrator,
		});

		expect(outcome).toMatchObject({
			kind: "failed",
			error: { message: expect.stringContaining("active agent") },
		});
		expect(host.disposeAgentCalls).toEqual([]);
	});
});
