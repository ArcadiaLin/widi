/**
 * Runtime control an extension may exercise (stage 0, capability C6):
 * `waitForIdle`, the host-owned `requestShutdown`, and the hostless
 * `disposeRuntime` escape hatch.
 */

import type { AgentHarnessEvent } from "@widi/agent-core";
import { describe, expect, it, vi } from "vitest";
import type {
	AgentOrchestrator,
	OrchestratorEvent,
} from "../../src/core/agent-orchestrator.ts";
import {
	createOrchestrator,
	MemoryExecutionEnv,
	requireAgentRecord,
} from "../helpers/orchestrator.ts";

function requireActions(
	orchestrator: AgentOrchestrator,
	agentId: string,
	extensionId = "control",
) {
	const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
	if (!runner) throw new Error("Expected extension runner.");
	return runner.createContext(extensionId).actions;
}

async function createHarness() {
	const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
	orchestrator.registerExtension("control", () => {});
	const agentId = await orchestrator.spawnAgent();
	return {
		orchestrator,
		agentId,
		actions: requireActions(orchestrator, agentId),
	};
}

// The harness keeps its queues private and reports them only through
// queue_update, which is also where the orchestrator mirrors their depth.
async function emitQueueUpdate(
	orchestrator: AgentOrchestrator,
	agentId: string,
	steerCount: number,
): Promise<void> {
	const event: AgentHarnessEvent = {
		type: "queue_update",
		steer: Array.from({ length: steerCount }, () => ({
			role: "user" as const,
			content: "queued",
			timestamp: 1,
		})),
		followUp: [],
		nextTurn: [],
	};
	await (
		orchestrator as unknown as {
			_handleAgentHarnessEvent(
				agentId: string,
				event: AgentHarnessEvent,
			): Promise<void>;
		}
	)._handleAgentHarnessEvent(agentId, event);
}

function settled(promise: Promise<void>): Promise<"settled" | "pending"> {
	return Promise.race([
		promise.then(
			() => "settled" as const,
			() => "settled" as const,
		),
		new Promise<"pending">((resolve) => {
			setTimeout(() => resolve("pending"), 0);
		}),
	]);
}

describe("extension waitForIdle", () => {
	it("returns immediately for an agent that is already idle and drained", async () => {
		const { actions } = await createHarness();
		await expect(actions.waitForIdle()).resolves.toBeUndefined();
	});

	// Same judgement as hasPendingMessages: text the harness has accepted but
	// not read still counts, or an extension would act on a half-delivered turn.
	it("waits while the harness still holds unread messages", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		await emitQueueUpdate(orchestrator, agentId, 1);

		const waiting = actions.waitForIdle();
		expect(await settled(waiting)).toBe("pending");

		await emitQueueUpdate(orchestrator, agentId, 0);
		await expect(waiting).resolves.toBeUndefined();
	});

	it("rejects rather than hangs when the agent is disposed while waiting", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		await emitQueueUpdate(orchestrator, agentId, 1);

		const waiting = actions.waitForIdle();
		await orchestrator.disposeAgent(agentId, { reason: "test teardown" });

		await expect(waiting).rejects.toThrow("test teardown");
	});

	it("rejects for an agent that can never idle again", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		await orchestrator.disposeAgent(agentId, { reason: "test teardown" });

		await expect(actions.waitForIdle()).rejects.toThrow("disposed");
	});

	it("honors an abort signal", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		await emitQueueUpdate(orchestrator, agentId, 1);
		const controller = new AbortController();

		const waiting = actions.waitForIdle({ signal: controller.signal });
		controller.abort(new Error("caller gave up"));

		await expect(waiting).rejects.toThrow("caller gave up");
	});
});

describe("extension shutdown requests", () => {
	it("publishes the request once, with core-injected attribution", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		const requests: Extract<
			OrchestratorEvent,
			{ type: "runtime_shutdown_requested" }
		>[] = [];
		orchestrator.subscribe((event) => {
			if (event.type === "runtime_shutdown_requested") requests.push(event);
		});

		await actions.requestShutdown("done here");
		await actions.requestShutdown("again");

		expect(requests).toHaveLength(1);
		expect(requests[0]?.requestedBy).toBe("control");
		expect(requests[0]?.requestedByAgentId).toBe(agentId);
		expect(requests[0]?.reason).toBe("done here");
	});

	// Core publishes and stops there: the process and the terminal belong to the
	// host, so an unhandled request must leave the agents running.
	it("does not tear anything down by itself", async () => {
		const { orchestrator, agentId, actions } = await createHarness();

		await actions.requestShutdown();

		expect(orchestrator.getAgentStatus(agentId)).toBe("idle");
	});

	it("reaches the extension runtimes of every agent, not just the requester", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const notified: string[] = [];
		orchestrator.registerExtension("control", (api) => {
			api.observe("runtime_shutdown_requested", (_event, context) => {
				notified.push(context.agentId);
			});
		});
		const firstAgentId = await orchestrator.spawnAgent();
		const secondAgentId = await orchestrator.spawnAgent();

		await requireActions(orchestrator, firstAgentId).requestShutdown();

		expect(notified.sort()).toEqual([firstAgentId, secondAgentId].sort());
	});

	it("finishes extension observers before a host can start teardown", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const notified: string[] = [];
		let pauseFirstObserver = true;
		let releaseFirstObserver!: () => void;
		const firstObserverReleased = new Promise<void>((resolve) => {
			releaseFirstObserver = resolve;
		});
		let firstObserverStarted = false;
		orchestrator.registerExtension("control", (api) => {
			api.observe("runtime_shutdown_requested", async (_event, context) => {
				if (pauseFirstObserver) {
					pauseFirstObserver = false;
					firstObserverStarted = true;
					await firstObserverReleased;
				}
				notified.push(context.agentId);
			});
		});
		const firstAgentId = await orchestrator.spawnAgent();
		const secondAgentId = await orchestrator.spawnAgent();
		let hostSawRequest = false;
		let hostDisposal: Promise<void> | undefined;
		orchestrator.subscribe((event) => {
			if (event.type !== "runtime_shutdown_requested") return;
			hostSawRequest = true;
			hostDisposal = orchestrator.disposeAll("host shutdown");
		});

		const request = requireActions(
			orchestrator,
			firstAgentId,
		).requestShutdown();
		try {
			await vi.waitFor(() => {
				expect(firstObserverStarted || hostSawRequest).toBe(true);
			});
			expect(hostSawRequest).toBe(false);
		} finally {
			releaseFirstObserver();
			await request;
			if (hostDisposal) await hostDisposal;
		}

		expect(hostSawRequest).toBe(true);
		expect(notified.sort()).toEqual([firstAgentId, secondAgentId].sort());
		expect(orchestrator.getAgentStatus(firstAgentId)).toBe("disposed");
		expect(orchestrator.getAgentStatus(secondAgentId)).toBe("disposed");
	});
});

describe("extension disposeRuntime", () => {
	it("disposes every agent and runs the extension teardown", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		let disposals = 0;
		orchestrator.registerExtension("control", (api) => {
			api.onDispose(() => {
				disposals += 1;
			});
		});
		const firstAgentId = await orchestrator.spawnAgent();
		const secondAgentId = await orchestrator.spawnAgent();

		await requireActions(orchestrator, firstAgentId).disposeRuntime("bye");

		expect(orchestrator.getAgentStatus(firstAgentId)).toBe("disposed");
		expect(orchestrator.getAgentStatus(secondAgentId)).toBe("disposed");
		expect(disposals).toBe(2);
	});

	it("leaves the calling context stale afterwards", async () => {
		const { orchestrator, agentId, actions } = await createHarness();

		await actions.disposeRuntime("bye");

		expect(() => actions.getModel()).toThrow("Agent has been disposed.");
		expect(orchestrator.getAgentStatus(agentId)).toBe("disposed");
	});
});
