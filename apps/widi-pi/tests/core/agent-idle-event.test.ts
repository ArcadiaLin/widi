/**
 * The `agent_idle` event: the orchestrator's own idle judgement, published so a
 * consumer can be told rather than poll. These tests pin the two properties a
 * delegating consumer depends on - it fires once per arrival at idle, and it
 * does not fire while the harness still holds unread text.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentHarnessEvent } from "@widi/agent-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator, OrchestratorEvent } from "../../src/core/agent-orchestrator.ts";
import {
	createOrchestrator,
	defaultModel,
	MemoryExecutionEnv,
	requireAgentHarness,
	requireAgentRecord,
} from "../helpers/orchestrator.ts";

type IdleEvent = Extract<OrchestratorEvent, { type: "agent_idle" }>;

function collectIdleEvents(orchestrator: AgentOrchestrator): IdleEvent[] {
	const events: IdleEvent[] = [];
	orchestrator.subscribe((event) => {
		if (event.type === "agent_idle") events.push(event);
	});
	return events;
}

// The harness reports its queues only through queue_update, which is where the
// orchestrator learns that text it handed over has not been read yet.
async function emitHarnessEvent(
	orchestrator: AgentOrchestrator,
	agentId: string,
	event: AgentHarnessEvent,
): Promise<void> {
	await (
		orchestrator as unknown as { _handleAgentHarnessEvent(agentId: string, event: AgentHarnessEvent): Promise<void> }
	)._handleAgentHarnessEvent(agentId, event);
}

function assistantMessage(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "turn" }],
		api: defaultModel.api,
		provider: defaultModel.provider,
		model: defaultModel.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 2,
	};
}

function turnEnd(message: AssistantMessage = assistantMessage()): AgentHarnessEvent {
	return { type: "turn_end", message, toolResults: [] };
}

function queueUpdate(steerCount: number): AgentHarnessEvent {
	return {
		type: "queue_update",
		steer: Array.from({ length: steerCount }, () => ({ role: "user" as const, content: "queued", timestamp: 1 })),
		followUp: [],
		nextTurn: [],
	};
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function startPromptRun(orchestrator: AgentOrchestrator, agentId: string): Promise<Deferred<AssistantMessage>> {
	const run = createDeferred<AssistantMessage>();
	const prompt = vi.spyOn(requireAgentHarness(orchestrator, agentId), "prompt").mockReturnValue(run.promise);
	const accepted = orchestrator.sendMessage({
		source: { kind: "system", name: "idle-event-test" },
		targetAgentId: agentId,
		body: "run",
		mode: "next_turn",
	});
	await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
	await emitHarnessEvent(orchestrator, agentId, { type: "agent_start" });
	await accepted;
	return run;
}

describe("agent_idle", () => {
	it("publishes the first idle after the harness is built", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const events = collectIdleEvents(orchestrator);
		const agentId = await orchestrator.spawnAgent();

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ agentId, reason: "ready", liveJobCount: 0 });
	});

	it("fires once per arrival at idle, not once per confirming fact", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const events = collectIdleEvents(orchestrator);
		const agentId = await orchestrator.spawnAgent();
		expect(events).toHaveLength(1);

		// Queue reports that re-confirm an idle the consumer was already told
		// about say nothing new.
		await emitHarnessEvent(orchestrator, agentId, queueUpdate(0));
		await emitHarnessEvent(orchestrator, agentId, queueUpdate(0));
		expect(events).toHaveLength(1);

		// A model turn ending is not enough: the harness may still run tools and
		// start another turn. The prompt promise is the terminal run boundary.
		const run = await startPromptRun(orchestrator, agentId);
		await emitHarnessEvent(orchestrator, agentId, turnEnd());
		expect(events).toHaveLength(1);
		run.resolve(assistantMessage());
		await vi.waitFor(() => expect(events).toHaveLength(2));
		expect(events[1]?.reason).toBe("settled");
	});

	it("distinguishes a turn that was cut off from one that ended on its own", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const events = collectIdleEvents(orchestrator);
		const agentId = await orchestrator.spawnAgent();

		const run = await startPromptRun(orchestrator, agentId);
		const message = assistantMessage("aborted");
		await emitHarnessEvent(orchestrator, agentId, turnEnd(message));
		await emitHarnessEvent(orchestrator, agentId, { type: "agent_end", messages: [message] });
		await emitHarnessEvent(orchestrator, agentId, { type: "settled", nextTurnCount: 0 });
		expect(events).toHaveLength(1);
		run.resolve(message);
		await vi.waitFor(() => expect(events).toHaveLength(2));
		// AgentHarness emits abort only after the run promise has settled.
		await emitHarnessEvent(orchestrator, agentId, { type: "abort", clearedSteer: [], clearedFollowUp: [] });

		expect(events).toHaveLength(2);
		expect(events[1]?.reason).toBe("aborted");
	});

	it("withholds the event while the harness still holds unread text", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const events = collectIdleEvents(orchestrator);
		const agentId = await orchestrator.spawnAgent();

		// Status commits to idle, but the harness reports queued steer text: the
		// agent stopped without having read what it was already given.
		const run = await startPromptRun(orchestrator, agentId);
		await emitHarnessEvent(orchestrator, agentId, queueUpdate(1));
		await emitHarnessEvent(orchestrator, agentId, turnEnd());
		run.resolve(assistantMessage());
		await vi.waitFor(() => expect(orchestrator.getAgentStatus(agentId)).toBe("idle"));
		expect(events).toHaveLength(1);

		// Draining the queue is the fact that completes the judgement.
		await emitHarnessEvent(orchestrator, agentId, queueUpdate(0));
		expect(events).toHaveLength(2);
		expect(events[1]?.reason).toBe("settled");
	});

	it("reports the jobs an idle agent is still waiting on", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const events = collectIdleEvents(orchestrator);
		const agentId = await orchestrator.spawnAgent();

		const table = requireAgentRecord(orchestrator, agentId).backgroundJobTable;
		const job = table.create({
			toolCallId: "call-1",
			toolName: "send_message",
			description: "delegated task",
			origin: { kind: "external", settlerId: "agent-2" },
		});
		table.background(job.id);

		const run = await startPromptRun(orchestrator, agentId);
		run.resolve(assistantMessage());

		await vi.waitFor(() => expect(events).toHaveLength(2));
		expect(events[1]?.liveJobCount).toBe(1);
	});

	it("allows a ready-idle listener to dispose the agent it observes", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		orchestrator.subscribe(async (event) => {
			if (event.type === "agent_idle" && event.reason === "ready") {
				await orchestrator.disposeAgent(event.agentId);
			}
		});

		const agentId = await orchestrator.spawnAgent();

		expect(orchestrator.getAgentStatus(agentId)).toBe("disposed");
	});

	it("does not publish an idle for an agent that stopped because it was disposed", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const agentId = await orchestrator.spawnAgent();
		const events = collectIdleEvents(orchestrator);

		await orchestrator.disposeAgent(agentId);

		expect(events).toHaveLength(0);
	});
});
