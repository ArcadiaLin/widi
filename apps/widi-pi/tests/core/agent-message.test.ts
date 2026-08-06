import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import {
	type AgentProfile,
	AgentProfileRegistry,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
import { MessageError } from "../../src/core/message.ts";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import { collectJobChanges, startBackgroundedJob } from "../helpers/background-jobs.ts";
import {
	agentSink,
	createOrchestrator,
	defaultProfile,
	harnessEventDriver,
	harnessInputText,
	humanSink,
	MemoryExecutionEnv,
	requireAgentHarness,
	requireAgentJobs,
	requireLiveAgent,
	stubCompaction,
	stubPromptRun,
} from "../helpers/orchestrator.ts";

/** The activity a live agent currently reports. */
function activityOf(orchestrator: AgentOrchestrator, agentId: string): string {
	return orchestrator.getAgentActivity(agentId).activity;
}

function createDeferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/**
 * Drive the harness `agent_start` the orchestrator subscribes to. A delivery is
 * only accepted once the agent loop is actually running, so a test that mocks
 * `prompt` has to produce that fact itself.
 */
async function driveAgentStart(orchestrator: AgentOrchestrator, agentId: string): Promise<void> {
	await harnessEventDriver(orchestrator)(agentId, { type: "agent_start" });
}

/** An orchestrator whose default profile loads the named extension. */
async function createExtensionOrchestrator(extensionId: string): Promise<AgentOrchestrator> {
	const profile: AgentProfile = { ...defaultProfile, id: `${extensionId}-profile`, persist: false };
	return await createOrchestrator(new MemoryExecutionEnv(), {
		defaultProfileId: profile.id,
		profileRegistry: new AgentProfileRegistry(InMemoryProfileStorageBackend.fromProfiles([{ profile }])),
	});
}

describe("AgentOrchestrator.sendMessage", () => {
	it("attributes the sender and returns before the target replies", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const sourceAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const { prompt, resolve: finishRun } = stubPromptRun(requireAgentHarness(orchestrator, targetAgentId));

		const accepted = agentSink(orchestrator, sourceAgentId).send({
			targetAgentId,
			body: "Please review this.",
			mode: "next_turn",
		});
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
		await driveAgentStart(orchestrator, targetAgentId);
		await accepted;

		// Acceptance, not completion: the run is still in flight.
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(harnessInputText(prompt.mock.calls[0]?.[0])).toBe(`[Message from ${sourceAgentId}]\n\nPlease review this.`);
		expect(activityOf(orchestrator, targetAgentId)).toBe("running");

		finishRun({} as AssistantMessage);
		await vi.waitFor(() => expect(activityOf(orchestrator, targetAgentId)).toBe("idle"));
	});

	it("lets only one of two concurrent senders claim the idle target", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		const { prompt, resolve: finishRun } = stubPromptRun(harness);
		const followUp = vi.spyOn(harness, "followUp").mockResolvedValue();

		const accepted = Promise.all([
			agentSink(orchestrator, "first").send({ targetAgentId, body: "first", mode: "next_turn" }),
			agentSink(orchestrator, "second").send({ targetAgentId, body: "second", mode: "next_turn" }),
		]);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
		await driveAgentStart(orchestrator, targetAgentId);
		await accepted;

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(harnessInputText(prompt.mock.calls[0]?.[0])).toBe("[Message from first]\n\nfirst");
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(harnessInputText(followUp.mock.calls[0]?.[0])).toBe("[Message from second]\n\nsecond");
		finishRun({} as AssistantMessage);
	});

	it("steers only when the sender asks to interrupt", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		const steer = vi.spyOn(harness, "steer").mockResolvedValue();
		const followUp = vi.spyOn(harness, "followUp").mockResolvedValue();
		(harness as unknown as { phase: "turn" }).phase = "turn";

		await agentSink(orchestrator, "agent-peer").send({ targetAgentId, body: "ordinary", mode: "next_turn" });
		await humanSink(orchestrator).send({ targetAgentId, body: "stop that", mode: "interrupt" });

		expect(followUp).toHaveBeenCalledTimes(1);
		expect(steer).toHaveBeenCalledTimes(1);
		expect(harnessInputText(steer.mock.calls[0]?.[0])).toBe("stop that");
	});

	// `AgentLifecycleStatus.running` covers compaction too, but a compacting
	// harness runs no agent loop: a follow-up accepted here would never be read.
	it("holds a message through compaction and delivers it afterwards", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		const compaction = stubCompaction(harness);
		const prompt = vi.spyOn(harness, "prompt").mockResolvedValue({} as AssistantMessage);
		const followUp = vi.spyOn(harness, "followUp").mockResolvedValue();
		const steer = vi.spyOn(harness, "steer").mockResolvedValue();

		const compacting = orchestrator.compactAgent(targetAgentId);
		const accepted = agentSink(orchestrator, "agent-peer").send({
			targetAgentId,
			body: "while compacting",
			mode: "next_turn",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(followUp).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();

		compaction.resolve({ summary: "compacted", tokensBefore: 0 });
		await compacting;
		await accepted;
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(harnessInputText(prompt.mock.calls[0]?.[0])).toContain("while compacting");
	});

	// The harness builds the turn context, session metadata, and tool context
	// asynchronously before its agent loop starts, and the user message is not
	// persisted until then. Reporting acceptance earlier would drop a message the
	// target never received - fatal for a job result nobody is left to resend.
	it("waits for the agent loop before reporting a message accepted", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		vi.spyOn(requireAgentHarness(orchestrator, targetAgentId), "prompt").mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			throw new Error("failed while building the turn");
		});

		await expect(
			agentSink(orchestrator, "watchdog").send({ targetAgentId, body: "never landed", mode: "next_turn" }),
		).rejects.toThrow("failed while building the turn");
		expect(activityOf(orchestrator, targetAgentId)).toBe("idle");
	});

	it("rejects competing maintenance before it can overwrite the active kind", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const compaction = stubCompaction(harness);

		const compacting = orchestrator.compactAgent(targetAgentId);
		await vi.waitFor(() => expect(orchestrator.getAgentActivity(targetAgentId).maintenance).toBe("compaction"));

		await expect(orchestrator.navigateAgentTree(targetAgentId, "entry-1")).rejects.toMatchObject({ code: "busy" });
		expect(orchestrator.getAgentActivity(targetAgentId).maintenance).toBe("compaction");
		expect(orchestrator.getAgentActivity(targetAgentId).activity).toBe("running");
		expect(events.filter((event) => event.type === "agent_status_changed" && event.activity === "running")).toEqual([
			expect.objectContaining({ type: "agent_status_changed", maintenance: "compaction" }),
		]);

		compaction.resolve({ summary: "compacted", tokensBefore: 0 });
		await compacting;
		expect(orchestrator.getAgentActivity(targetAgentId).maintenance).toBeUndefined();
		expect(orchestrator.getAgentActivity(targetAgentId).activity).toBe("idle");
	});

	it("does not let maintenance take over an active agent turn", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		(harness as unknown as { phase: "turn" }).phase = "turn";

		// The harness is the authority: the orchestrator no longer keeps a parallel
		// reservation that could refuse ahead of it, so the rejection comes back
		// from `compact()` itself and the active kind is never overwritten.
		await expect(orchestrator.compactAgent(targetAgentId)).rejects.toMatchObject({ code: "busy" });
		expect(orchestrator.getAgentActivity(targetAgentId).maintenance).toBeUndefined();
		expect(activityOf(orchestrator, targetAgentId)).toBe("running");
	});

	it("rejects low-level turn controls during maintenance", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		const compaction = stubCompaction(harness);
		const abort = vi.spyOn(harness, "abort");
		const followUp = vi.spyOn(harness, "followUp");
		const steer = vi.spyOn(harness, "steer");
		const promote = vi.spyOn(harness, "promoteFollowUpsToSteer");

		const compacting = orchestrator.compactAgent(targetAgentId);
		await vi.waitFor(() => expect(orchestrator.getAgentActivity(targetAgentId).maintenance).toBe("compaction"));

		await expect(orchestrator.abortAgent(targetAgentId)).rejects.toMatchObject({ code: "busy" });
		await expect(orchestrator.steerQueuedFollowUps(targetAgentId)).rejects.toMatchObject({ code: "busy" });

		expect(abort).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
		expect(promote).not.toHaveBeenCalled();

		compaction.resolve({ summary: "compacted", tokensBefore: 0 });
		await compacting;
	});

	it("refuses an unknown target and an empty body", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await expect(
			agentSink(orchestrator, "test").send({ targetAgentId: "agent-missing", body: "hello", mode: "next_turn" }),
		).rejects.toThrow("Unknown agent");
		await expect(
			agentSink(orchestrator, "test").send({ targetAgentId, body: "   ", mode: "next_turn" }),
		).rejects.toBeInstanceOf(MessageError);
	});

	// `disposeAgent` cancels the target's queue and sweeps its outstanding work
	// up front, but only commits the `disposed` status after a teardown full of
	// awaits. Anything accepted in between would be work nobody sweeps again.
	it("stops accepting messages as soon as dispose starts, before the status commits", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		const teardown = createDeferred<Awaited<ReturnType<typeof harness.abort>>>();
		vi.spyOn(harness, "abort").mockReturnValue(teardown.promise);
		const prompt = vi.spyOn(harness, "prompt").mockResolvedValue({} as AssistantMessage);

		const disposing = orchestrator.disposeAgent(targetAgentId, { intent: "removed" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The registry cutover happens first, long before the teardown it is still
		// waiting on: nothing can be accepted from here on.
		expect(() => orchestrator.getAgentActivity(targetAgentId)).toThrow(/is gone|Unknown agent/);

		// Not a MessageError: the target left the registry, so the rejection is the
		// lookup's, ahead of the message pipeline entirely.
		await expect(
			agentSink(orchestrator, "agent-peer").send({ targetAgentId, body: "landed mid-teardown", mode: "next_turn" }),
		).rejects.toThrow(/is gone|Unknown agent/);
		expect(prompt).not.toHaveBeenCalled();

		teardown.resolve({ clearedSteer: [], clearedFollowUp: [] });
		await disposing;
		expect(() => orchestrator.getAgentActivity(targetAgentId)).toThrow(/is gone|Unknown agent/);
	});
});

describe("AgentOrchestrator message interception", () => {
	it("shows the interceptor who sent the message and who reads it", async () => {
		const orchestrator = await createExtensionOrchestrator("observer");
		const seen: Array<{ source: string; targetAgentId: string }> = [];
		orchestrator.registerExtension("observer", (api) => {
			api.intercept("input", (event) => {
				seen.push({ source: event.source.kind, targetAgentId: event.targetAgentId });
				return undefined;
			});
		});
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		vi.spyOn(harness, "prompt").mockResolvedValue({} as AssistantMessage);

		await agentSink(orchestrator, "agent-peer").send({ targetAgentId, body: "from a peer", mode: "next_turn" });
		await humanSink(orchestrator).prompt({ targetAgentId, body: "from a human", mode: "next_turn" });

		expect(seen).toEqual([
			{ source: "agent", targetAgentId },
			{ source: "human", targetAgentId },
		]);
	});

	it("reports a blocked agent message instead of delivering it", async () => {
		const orchestrator = await createExtensionOrchestrator("policy");
		orchestrator.registerExtension("policy", (api) => {
			api.intercept("input", (event) =>
				event.source.kind === "agent" ? { block: true, reason: "No peer messages." } : undefined,
			);
		});
		const targetAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const harness = requireAgentHarness(orchestrator, targetAgentId);
		const prompt = vi.spyOn(harness, "prompt").mockResolvedValue({} as AssistantMessage);
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await expect(
			agentSink(orchestrator, "agent-peer").send({ targetAgentId, body: "from a peer", mode: "next_turn" }),
		).resolves.toEqual({
			kind: "blocked",
			inputId: expect.any(String),
			reason: "No peer messages.",
			blockedBy: "policy",
		});
		expect(prompt).not.toHaveBeenCalled();
		expect(events).toContainEqual(expect.objectContaining({ type: "input_blocked", blockedBy: "policy" }));
	});

	// The model holds this job's t0 handle and is waiting for exactly one result.
	it("delivers a blocked background job result anyway, with a diagnostic", async () => {
		const orchestrator = await createExtensionOrchestrator("policy");
		orchestrator.registerExtension("policy", (api) => {
			api.intercept("input", () => ({ block: true, reason: "Nothing gets in." }));
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const prompt = vi
			.spyOn(requireAgentHarness(orchestrator, agentId), "prompt")
			.mockResolvedValue({} as AssistantMessage);
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		const { execution } = startBackgroundedJob(requireAgentJobs(orchestrator, agentId), {
			toolCallId: "call-1",
			toolName: "sleeper",
		});
		execution.settle({
			status: "completed",
			result: { content: [{ type: "text", text: "build done" }], details: undefined },
		});

		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
		expect(harnessInputText(prompt.mock.calls[0]?.[0])).toContain("build done");
		expect(events.filter((event) => event.type === "diagnostic").map((event) => event.diagnostic.code)).toContain(
			"orchestrator.message_block_ignored",
		);
	});

	// A runtime notice is the other `blockPolicy: "ignore"` producer: the facts it
	// announces are recorded either way, so a block degrades the same.
	it("delivers a blocked runtime notice anyway, with a diagnostic", async () => {
		const env = new MemoryExecutionEnv();
		const first = await createOrchestrator(env);
		const agentId = await first.spawnAgent({ origin: { kind: "new" } });
		const reference = first.sessionManager.getAgentSessionRef(agentId);
		if (reference === undefined) throw new Error(`Expected a persisted session for ${agentId}.`);

		// A second runtime over the same files: the process died, the session did not.
		const second = await createOrchestrator(env);
		second.registerExtension("policy", (api) => {
			api.intercept("input", () => ({ block: true, reason: "Nothing gets in." }));
		});
		const events: OrchestratorEvent[] = [];
		second.subscribe((event) => {
			events.push(event);
		});

		const resumed = await second.spawnAgent({ origin: { kind: "resume", reference } });

		expect(events.filter((event) => event.type === "diagnostic").map((event) => event.diagnostic.code)).toContain(
			"orchestrator.message_block_ignored",
		);
		// Delivered anyway: the notice is on the branch the model resumes with.
		const snapshot = await second.getAgentSession(resumed);
		expect(JSON.stringify(snapshot.pathToRoot)).toContain("Spawn tree closed");
	});
});

describe("AgentOrchestrator delegated task jobs", () => {
	async function assignTask(
		orchestrator: AgentOrchestrator,
		ownerAgentId: string,
		workerAgentId: string,
	): Promise<string> {
		const created = await requireAgentJobs(orchestrator, ownerAgentId).createExternal({
			toolCallId: "call-assign",
			toolName: "assign_agent_task",
			settlerAgentId: workerAgentId,
		});
		if (!created.ok) throw new Error(`Expected an external job, got ${created.reason}.`);
		return created.job.jobId;
	}

	it("routes a worker's completion to the owner through the job's own result", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const ownerAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const workerAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const ownerPrompt = vi
			.spyOn(requireAgentHarness(orchestrator, ownerAgentId), "prompt")
			.mockResolvedValue({} as AssistantMessage);
		const taskId = await assignTask(orchestrator, ownerAgentId, workerAgentId);

		// Only the assigned worker may settle it.
		const intruderId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		expect(
			requireLiveAgent(orchestrator, intruderId).backgroundAttachment.settler.settle({
				ownerAgentId,
				jobId: taskId,
				outcome: { status: "completed" },
			}),
		).toEqual({ ok: false, reason: "not_settler" });
		expect(requireAgentJobs(orchestrator, ownerAgentId).list()).toHaveLength(1);
		expect(ownerPrompt).not.toHaveBeenCalled();

		expect(
			requireLiveAgent(orchestrator, workerAgentId).backgroundAttachment.settler.settle({
				ownerAgentId,
				jobId: taskId,
				outcome: {
					status: "completed",
					result: { content: [{ type: "text", text: "The router is sound." }], details: undefined },
				},
			}),
		).toEqual({ ok: true });

		await vi.waitFor(() => expect(ownerPrompt).toHaveBeenCalledTimes(1));
		expect(harnessInputText(ownerPrompt.mock.calls[0]?.[0])).toContain(taskId);
		expect(harnessInputText(ownerPrompt.mock.calls[0]?.[0])).toContain("The router is sound.");
		// Exactly one completion message: the job's t1 is the whole protocol.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ownerPrompt).toHaveBeenCalledTimes(1);
	});

	it("cancels the tasks a disposed worker still owes, keeping its owner alive", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const ownerAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const workerAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const ownerPrompt = vi
			.spyOn(requireAgentHarness(orchestrator, ownerAgentId), "prompt")
			.mockResolvedValue({} as AssistantMessage);
		const { changes } = collectJobChanges(requireAgentJobs(orchestrator, ownerAgentId));
		await assignTask(orchestrator, ownerAgentId, workerAgentId);

		await orchestrator.disposeAgent(workerAgentId, { intent: "removed", reason: "Worker was killed" });

		// No executor watches a delegated job's signal, so the table itself has to
		// finish the transition rather than leave it stuck in `aborting`.
		expect(requireAgentJobs(orchestrator, ownerAgentId).list()).toEqual([]);
		// No `abort_requested` in between: nothing executes a delegated job, so the
		// table cancels it outright rather than asking and then confirming.
		expect(changes.map((change) => change.transition)).toEqual(["backgrounded", "settled"]);
		expect(changes.at(-1)).toMatchObject({ transition: "settled", outcome: { status: "cancelled" } });
		// The owner is untouched by its worker's teardown. Its exact phase here is
		// not asserted: the cancellation t1 is recorded before it is delivered, so
		// whether that delivery has already started a run by the time dispose
		// returns is a race between two independent chains.
		expect(orchestrator.getAgentActivity(ownerAgentId)).toBeDefined();
		await vi.waitFor(() => expect(ownerPrompt).toHaveBeenCalledTimes(1));
		// The owner is told which agent stopped owing it a result. The dispose
		// reason belongs to the worker's own teardown, not to this job's result.
		expect(harnessInputText(ownerPrompt.mock.calls[0]?.[0])).toContain(
			`Settler agent ${workerAgentId} was disposed before it reported a result.`,
		);
	});

	// Dispose detaches the owner's job listener before aborting its jobs, so the
	// `settled` changes that normally clear the index never arrive. A resumed
	// agent reuses the id with a table numbering from job-1 again, and a stale
	// entry would later cancel an unrelated job that shares the id. The second
	// owner is the control: it proves the sweep is targeted rather than the
	// index simply having been empty all along.
	it("forgets a disposed owner's tasks instead of leaving stale index entries", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const disposedOwnerId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const survivingOwnerId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const workerAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		await assignTask(orchestrator, disposedOwnerId, workerAgentId);
		const survivingTaskId = await assignTask(orchestrator, survivingOwnerId, workerAgentId);

		await orchestrator.disposeAgent(disposedOwnerId, { intent: "removed" });

		// The disposed owner's task is gone with it; the surviving owner's is not.
		expect(
			requireAgentJobs(orchestrator, survivingOwnerId)
				.list()
				.map((job) => job.jobId),
		).toEqual([survivingTaskId]);
	});
});
