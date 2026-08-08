/**
 * Watches: the runtime observing that an agent stopped and telling whoever was
 * waiting on it.
 *
 * The property under test is that the report does not depend on the stopped
 * agent doing anything. It is delivered when the agent is interrupted, when it
 * stops silently, and when it is disposed - the three cases a voluntary "I am
 * finished" call loses. The gates are the other half: an agent that paused to
 * wait on work it started has not stopped, and must not be reported as though
 * it had.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentHarnessEvent, CompactResult } from "@widi/agent-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import { messageBindingFor } from "../../src/core/message.ts";
import {
	createOrchestrator,
	defaultModel,
	harnessEventDriver,
	harnessInputText,
	MemoryExecutionEnv,
	requireAgentHarness,
	requireAgentJobs,
	stubCompaction,
} from "../helpers/orchestrator.ts";

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: text === "" ? [] : [{ type: "text", text }],
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

interface Deferred {
	readonly promise: Promise<AssistantMessage>;
	readonly resolve: (value: AssistantMessage) => void;
}

function createDeferred(): Deferred {
	let resolve!: (value: AssistantMessage) => void;
	const promise = new Promise<AssistantMessage>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/**
 * Take over the watcher's harness so what it is told is observable. Every
 * notice arrives as a prompt: the watcher is idle, waiting to be woken.
 */
function watchInbox(orchestrator: AgentOrchestrator, agentId: string): { readonly texts: string[] } {
	const texts: string[] = [];
	vi.spyOn(requireAgentHarness(orchestrator, agentId), "prompt").mockImplementation(async (input) => {
		texts.push(harnessInputText(input));
		return assistantMessage("ack");
	});
	return { texts };
}

async function emit(orchestrator: AgentOrchestrator, agentId: string, event: AgentHarnessEvent): Promise<void> {
	await harnessEventDriver(orchestrator)(agentId, event);
}

/**
 * Run one turn on `agentId` and let it stop, which is the edge a watch fires
 * on. The prompt promise is the run boundary, so it is held until the turn has
 * been reported.
 */
async function runAndStop(orchestrator: AgentOrchestrator, agentId: string, said: AssistantMessage): Promise<void> {
	const run = createDeferred();
	const prompt = vi.spyOn(requireAgentHarness(orchestrator, agentId), "prompt").mockReturnValue(run.promise);
	const accepted = orchestrator
		.messageSinkFor(messageBindingFor({ kind: "agent", senderAgentId: "watch-test" }))
		.send({ targetAgentId: agentId, body: "go", mode: "next_turn" });
	await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
	await emit(orchestrator, agentId, { type: "agent_start" });
	await accepted;
	await emit(orchestrator, agentId, { type: "turn_end", message: said, toolResults: [] });
	run.resolve(said);
	await emit(orchestrator, agentId, { type: "settled", nextTurnCount: 0 });
}

async function createPair(): Promise<{
	readonly orchestrator: AgentOrchestrator;
	readonly watcherAgentId: string;
	readonly workerAgentId: string;
}> {
	const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
	const watcherAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
	const workerAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" }, parent: watcherAgentId });
	return { orchestrator, watcherAgentId, workerAgentId };
}

describe("agent watches", () => {
	it("reports a worker that was interrupted, carrying what it last said", async () => {
		const { orchestrator, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		expect(orchestrator.watchAgent(watcherAgentId, workerAgentId, true)).toBe("watching");

		await runAndStop(orchestrator, workerAgentId, assistantMessage("Half of the router is rewritten.", "aborted"));

		await vi.waitFor(() => expect(inbox.texts).toHaveLength(1));
		const notice = inbox.texts[0] ?? "";
		expect(notice).toContain(`<agent-notification from="${workerAgentId}" status="idle" reason="aborted">`);
		expect(notice).toContain("Half of the router is rewritten.");
		expect(notice).toContain("dispose_agent");
	});

	it("reports a worker that stopped silently", async () => {
		const { orchestrator, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		orchestrator.watchAgent(watcherAgentId, workerAgentId, true);

		await runAndStop(orchestrator, workerAgentId, assistantMessage("Done: the config was already correct."));

		await vi.waitFor(() => expect(inbox.texts).toHaveLength(1));
		expect(inbox.texts[0]).toContain(`status="idle" reason="settled"`);
		expect(inbox.texts[0]).toContain("Done: the config was already correct.");
	});

	// The case a voluntary report cannot express at all: a run that produced no
	// text still has to reach the watcher, or the delegation hangs on silence.
	it("reports a worker whose run said nothing", async () => {
		const { orchestrator, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		orchestrator.watchAgent(watcherAgentId, workerAgentId, true);

		await runAndStop(orchestrator, workerAgentId, assistantMessage(""));

		await vi.waitFor(() => expect(inbox.texts).toHaveLength(1));
		expect(inbox.texts[0]).toContain(`${workerAgentId} stopped without a closing message.`);
	});

	it("fires once and revokes itself", async () => {
		const { orchestrator, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		orchestrator.watchAgent(watcherAgentId, workerAgentId, true);

		await runAndStop(orchestrator, workerAgentId, assistantMessage("first"));
		await vi.waitFor(() => expect(inbox.texts).toHaveLength(1));

		// Continued by hand rather than by the subscription: the watcher is no
		// longer listening, so this second stop is nobody's to hear.
		await runAndStop(orchestrator, workerAgentId, assistantMessage("second"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(inbox.texts).toHaveLength(1);
	});

	// Maintenance releases the agent back to idle without a turn behind it, so
	// the report it would carry is whatever the worker said before compacting.
	it("stays silent when the worker only came back from maintenance", async () => {
		const { orchestrator, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		orchestrator.watchAgent(watcherAgentId, workerAgentId, true);

		const compaction = stubCompaction(requireAgentHarness(orchestrator, workerAgentId));
		const compacting = orchestrator.compactAgent(workerAgentId);
		// A real compaction emits as it runs, and each event re-arms the idle edge
		// that the release below then publishes. Without one the release is a
		// repeat of an idle already announced and never reaches the gate.
		await emit(orchestrator, workerAgentId, { type: "queue_update", steer: [], followUp: [], nextTurn: [] });
		compaction.resolve({ messages: [], summary: "compacted" } as unknown as CompactResult);
		await compacting;
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(inbox.texts).toHaveLength(0);
	});

	it("stays silent while the worker waits on a job it started", async () => {
		const { orchestrator, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		orchestrator.watchAgent(watcherAgentId, workerAgentId, true);

		const started = requireAgentJobs(orchestrator, workerAgentId).startLocal({
			toolCallId: "call-1",
			toolName: "bash",
		});
		expect(started.ok).toBe(true);
		if (started.ok) expect(started.execution.acceptBackground().ok).toBe(true);

		await runAndStop(orchestrator, workerAgentId, assistantMessage("started the build"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		// It stopped, but it is waiting on its own work and will be woken by it.
		expect(inbox.texts).toHaveLength(0);
	});

	/**
	 * The gate a delegation without a job needs. A worker waiting on its own
	 * subagent holds no job, so the job count says it is done; only its own watch
	 * says otherwise.
	 */
	it("stays silent while the worker waits on a subagent of its own", async () => {
		const { orchestrator, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		const grandchildAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" }, parent: workerAgentId });
		orchestrator.watchAgent(watcherAgentId, workerAgentId, true);
		orchestrator.watchAgent(workerAgentId, grandchildAgentId, true);

		await runAndStop(orchestrator, workerAgentId, assistantMessage("delegated the search"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(inbox.texts).toHaveLength(0);

		// Once the level below reports, the worker's own next stop is a real stop.
		watchInbox(orchestrator, workerAgentId);
		await runAndStop(orchestrator, grandchildAgentId, assistantMessage("found it"));
		await runAndStop(orchestrator, workerAgentId, assistantMessage("here is the answer"));
		await vi.waitFor(() => expect(inbox.texts).toHaveLength(1));
		expect(inbox.texts[0]).toContain("here is the answer");
	});

	it("tells the watcher when the agent it waited on is disposed", async () => {
		const { orchestrator, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		orchestrator.watchAgent(watcherAgentId, workerAgentId, true);

		await orchestrator.disposeAgent(workerAgentId, { intent: "removed", reason: "no longer needed" });

		await vi.waitFor(() => expect(inbox.texts).toHaveLength(1));
		expect(inbox.texts[0]).toContain(`<agent-notification from="${workerAgentId}" status="gone">`);
		expect(inbox.texts[0]).toContain("will not report");
	});

	it("drops the watches a disposed watcher held", async () => {
		const { orchestrator, watcherAgentId, workerAgentId } = await createPair();
		orchestrator.watchAgent(watcherAgentId, workerAgentId, true);

		await orchestrator.disposeAgent(watcherAgentId, { intent: "removed" });
		// Nothing is delivered to an agent that is gone; the worker stopping after
		// its watcher did must not fail a send into a cancelled queue.
		await runAndStop(orchestrator, workerAgentId, assistantMessage("done"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(orchestrator.watchAgent(workerAgentId, workerAgentId, false)).toBe("self");
	});

	it("refuses a watch it cannot honour", async () => {
		const { orchestrator, watcherAgentId, workerAgentId } = await createPair();
		const otherTreeAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		expect(orchestrator.watchAgent(watcherAgentId, watcherAgentId, true)).toBe("self");
		expect(orchestrator.watchAgent(watcherAgentId, "ag-nope", true)).toBe("unknown");
		expect(orchestrator.watchAgent(watcherAgentId, otherTreeAgentId, true)).toBe("outside_tree");

		// A stop has one report to give, so a second claim on it is refused rather
		// than silently replacing the first.
		expect(orchestrator.watchAgent(watcherAgentId, workerAgentId, true)).toBe("watching");
		const siblingAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" }, parent: watcherAgentId });
		expect(orchestrator.watchAgent(siblingAgentId, workerAgentId, true)).toBe("taken");
		expect(orchestrator.watchAgent(siblingAgentId, workerAgentId, false)).toBe("not_watching");
	});

	it("stops reporting once the watcher unsubscribes", async () => {
		const { orchestrator, watcherAgentId, workerAgentId } = await createPair();
		const inbox = watchInbox(orchestrator, watcherAgentId);
		orchestrator.watchAgent(watcherAgentId, workerAgentId, true);
		expect(orchestrator.watchAgent(watcherAgentId, workerAgentId, false)).toBe("not_watching");

		await runAndStop(orchestrator, workerAgentId, assistantMessage("done"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(inbox.texts).toHaveLength(0);
	});
});
