import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentHarness } from "@widi/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import { AgentProfileRegistry, InMemoryProfileStorageBackend } from "../../src/core/agent-profile.ts";
import type { OwnerAttachment } from "../../src/core/background/index.ts";
import type { AgentTreeEntry, AgentTreeRunningEntry, ToolAgentHost } from "../../src/core/host.ts";
import { createDisposeAgentToolDefinition } from "../../src/core/tools/agents/dispose-agent.ts";
import { createListAgentProfilesToolDefinition } from "../../src/core/tools/agents/list-agent-profiles.ts";
import { createListAgentsToolDefinition } from "../../src/core/tools/agents/list-agents.ts";
import { createSendMessageToolDefinition } from "../../src/core/tools/agents/send-message.ts";
import { createSpawnAgentToolDefinition } from "../../src/core/tools/agents/spawn-agent.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";
import {
	createOrchestrator,
	defaultProfile,
	MemoryExecutionEnv,
	requireAgentHarness,
	requireAgentJobs,
	requireLiveAgent,
	restoredProfile,
	spawnParentOf,
} from "../helpers/orchestrator.ts";

const listAgentProfiles = createListAgentProfilesToolDefinition();
const listAgents = createListAgentsToolDefinition();
const spawnAgent = createSpawnAgentToolDefinition();
const sendMessage = createSendMessageToolDefinition();
const disposeAgent = createDisposeAgentToolDefinition();

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * The execution context an agent's own turn would carry: the real host closure
 * the orchestrator builds for that agent, plus that agent's own job table.
 */
function toolContext<TDetails>(orchestrator: AgentOrchestrator, agentId: string): ToolExecutionContext<TDetails> {
	const host = (
		orchestrator as unknown as { _createToolAgentHost: (agentId: string, attachment: OwnerAttachment) => ToolAgentHost }
	)._createToolAgentHost(agentId, requireLiveAgent(orchestrator, agentId).backgroundAttachment);
	return {
		signal: undefined,
		onUpdate: undefined,
		extension: undefined,
		human: undefined,
		agents: host,
		jobs: requireAgentJobs(orchestrator, agentId),
	};
}

/**
 * Let the agent accept deliveries without running a model. A resolved prompt is
 * enough for the orchestrator to report the message as accepted.
 */
function stubPrompt(orchestrator: AgentOrchestrator, agentId: string) {
	return vi.spyOn(requireAgentHarness(orchestrator, agentId), "prompt").mockResolvedValue({} as AssistantMessage);
}

function createDeferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** The listing as indented lines, so the assertion covers nesting and order too. */
function treeLines(entries: readonly AgentTreeEntry[], depth = 0): string[] {
	return entries.flatMap((entry) => [
		`${"  ".repeat(depth)}${entry.status === "running" ? `running ${entry.agentId}` : `closed ${entry.sessionRef}`}`,
		...treeLines(entry.children, depth + 1),
	]);
}

function runningEntry(entries: readonly AgentTreeEntry[], agentId: string): AgentTreeRunningEntry {
	const entry = findRunning(entries, agentId);
	if (!entry) throw new Error(`No running entry for ${agentId}.`);
	return entry;
}

function findRunning(entries: readonly AgentTreeEntry[], agentId: string): AgentTreeRunningEntry | undefined {
	for (const entry of entries) {
		if (entry.status === "running" && entry.agentId === agentId) return entry;
		const nested = findRunning(entry.children, agentId);
		if (nested) return nested;
	}
	return undefined;
}

/** The address of an agent's session directory, which a persistent agent always has. */
function sessionRef(orchestrator: AgentOrchestrator, agentId: string): string {
	const ref = orchestrator.sessionManager.getAgentSessionRef(agentId);
	if (ref === undefined) throw new Error(`Expected a persistent session for ${agentId}.`);
	return ref;
}

async function spawnChild(orchestrator: AgentOrchestrator, parentAgentId: string, profile = "worker"): Promise<string> {
	const result = await spawnAgent.execute(
		`spawn-${parentAgentId}`,
		{ profile },
		toolContext(orchestrator, parentAgentId),
	);
	return result.details.agentId;
}

/** An owner and a worker, both able to accept messages. */
async function createPair() {
	const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
	const owner = await orchestrator.spawnAgent({ origin: { kind: "new" } });
	const worker = await spawnChild(orchestrator, owner);
	return {
		orchestrator,
		owner,
		worker,
		ownerPrompt: stubPrompt(orchestrator, owner),
		workerPrompt: stubPrompt(orchestrator, worker),
	};
}

describe("list_agent_profiles", () => {
	it("lists enabled profiles only", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv(), { enabledProfileIds: ["main"] });
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		const result = await listAgentProfiles.execute("call-1", {}, toolContext(orchestrator, agentId));

		expect(result.details.profiles.map((profile) => profile.id)).toEqual(["main"]);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("main (Main Agent)") });
	});

	// The menu exists so the model can choose, and `whenToUse` is the only field
	// that tells it how. Indented under its own entry, because the advice runs to
	// a paragraph and flush-left it would read as the next profile.
	it("renders whenToUse indented under its profile", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv(), {
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: defaultProfile },
					{
						profile: {
							id: "explore",
							label: "Explore Agent",
							whenToUse: "Use for a wide search.\n\nIt cannot edit anything.",
							systemPrompt: "explore prompt",
							persist: false,
						},
					},
				]),
			),
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		const result = await listAgentProfiles.execute("call-1", {}, toolContext(orchestrator, agentId));

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: [
				"Agent profiles available to spawn_agent:",
				"- explore (Explore Agent) [ephemeral session]",
				"  Use for a wide search.",
				"",
				"  It cannot edit anything.",
				"- main (Main Agent) [persistent session]",
			].join("\n"),
		});
	});
});

describe("list_agents", () => {
	// The directories are the complete set and memory is a subset of them: a
	// disposed agent leaves the live registry and stays on the list as the
	// session it wrote, which is exactly what it now is.
	it("nests the caller's tree, keeps a disposed agent as a closed session, and excludes other trees", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const broken = await spawnChild(orchestrator, caller);
		const gone = await spawnChild(orchestrator, caller);
		const goneRef = sessionRef(orchestrator, gone);
		const otherRoot = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const otherChild = await spawnChild(orchestrator, otherRoot);
		await orchestrator.disposeAgent(gone, { intent: "removed" });

		const result = await listAgents.execute("call-1", {}, toolContext(orchestrator, caller));

		expect(result.details.callerAgentId).toBe(caller);
		expect(treeLines(result.details.entries)).toEqual([
			`running ${caller}`,
			`  running ${broken}`,
			`  closed ${goneRef}`,
		]);
		expect(runningEntry(result.details.entries, caller).activity).toBe("idle");
		expect(orchestrator.listAgents().agents.map((agent) => agent.agentId)).toEqual([
			caller,
			broken,
			otherRoot,
			otherChild,
		]);
	});

	it("gives roots, children, and grandchildren the same tree view", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const root = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const child = await spawnChild(orchestrator, root);
		const grandchild = await spawnChild(orchestrator, child);
		const sibling = await spawnChild(orchestrator, root);
		await orchestrator.spawnAgent({ origin: { kind: "new" } });

		for (const caller of [root, child, grandchild, sibling]) {
			const result = await listAgents.execute(`list-${caller}`, {}, toolContext(orchestrator, caller));
			expect(treeLines(result.details.entries)).toEqual([
				`running ${root}`,
				`  running ${child}`,
				`    running ${grandchild}`,
				`  running ${sibling}`,
			]);
		}
	});

	// The point of reading the directories: subagents never come back, so after a
	// resume the whole tree below the root is closed - and still visible, which is
	// how the model learns what this session did before.
	it("reads the subagents of an earlier run as closed sessions", async () => {
		const env = new MemoryExecutionEnv();
		const first = await createOrchestrator(env);
		const root = await first.spawnAgent({ origin: { kind: "new" } });
		const child = await spawnChild(first, root);
		const grandchild = await spawnChild(first, child);
		const rootRef = sessionRef(first, root);
		const childRef = sessionRef(first, child);
		const grandchildRef = sessionRef(first, grandchild);

		const second = await createOrchestrator(env);
		const resumed = await second.spawnAgent({ origin: { kind: "resume", reference: rootRef } });
		const result = await listAgents.execute("list-after-resume", {}, toolContext(second, resumed));

		expect(treeLines(result.details.entries)).toEqual([
			`running ${resumed}`,
			`  closed ${childRef}`,
			`    closed ${grandchildRef}`,
		]);
		expect(result.details.entries[0]?.children[0]).toMatchObject({ status: "closed", profileId: "worker" });
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("cannot be messaged or disposed"),
		});
	});

	// An ephemeral agent owns no directory, so its children are top-level
	// sessions. The spawn edge is still the truth about who spawned whom.
	it("keeps a child of an ephemeral agent under it", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv(), {
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: { ...defaultProfile, persist: false } },
					{ profile: restoredProfile },
				]),
			),
		});
		const root = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const child = await spawnChild(orchestrator, root);

		const result = await listAgents.execute("list-from-ephemeral", {}, toolContext(orchestrator, root));

		expect(treeLines(result.details.entries)).toEqual([`running ${root}`, `  running ${child}`]);
		expect(result.details.entries[0]).not.toHaveProperty("sessionRef");
		expect(result.details.entries[0]?.children[0]).toMatchObject({
			status: "running",
			sessionRef: sessionRef(orchestrator, child),
		});
	});
});

describe("spawn_agent", () => {
	it("creates an idle agent and registers no task", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const context = toolContext(orchestrator, caller);

		const result = await spawnAgent.execute("call-1", { profile: "worker" }, context);

		expect(result.details.profileId).toBe("worker");
		expect(result.details.taskId).toBeUndefined();
		expect(orchestrator.getAgentActivity(result.details.agentId).activity).toBe("idle");
		expect(context.jobs?.list()).toEqual([]);
	});

	it("delegates the first task when one is given", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		// The child does not exist yet when the call starts, so its harness cannot
		// be stubbed per instance the way the other tests do it.
		const prompt = vi.spyOn(AgentHarness.prototype, "prompt").mockResolvedValue({} as AssistantMessage);

		const result = await spawnAgent.execute(
			"call-1",
			{ profile: "worker", task: "audit the parser" },
			toolContext(orchestrator, caller),
		);

		expect(result.details.profileId).toBe("worker");
		expect(result.details.taskId).toBe("job-1");
		expect(orchestrator.getAgentActivity(result.details.agentId).activity).toBe("idle");
		expect(prompt.mock.calls[0]?.[0]).toContain("Task job-1 assigned to you.");
		expect(prompt.mock.calls[0]?.[0]).toContain("audit the parser");
	});

	it("fails without leaving a half-built agent when the profile is unknown", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const context = toolContext(orchestrator, caller);

		await expect(spawnAgent.execute("call-1", { profile: "nonexistent" }, context)).rejects.toThrow(/nonexistent/);

		expect(orchestrator.listAgents().agents).toHaveLength(1);
	});
});

describe("send_message argument validation", () => {
	it("rejects the illegal combinations before anything happens", async () => {
		const { orchestrator, owner, worker, workerPrompt } = await createPair();
		const context = toolContext(orchestrator, owner);

		await expect(
			sendMessage.execute(
				"call-1",
				{ agentId: worker, message: "both", assignTask: true, completeTask: "job-1" },
				context,
			),
		).rejects.toThrow(/cannot both assign a task and complete one/);
		await expect(
			sendMessage.execute("call-2", { agentId: worker, message: "orphan flag", taskFailed: true }, context),
		).rejects.toThrow(/only accepts taskFailed together with completeTask/);
		await expect(sendMessage.execute("call-3", { agentId: owner, message: "to myself" }, context)).rejects.toThrow(
			/cannot target yourself/,
		);

		expect(workerPrompt).not.toHaveBeenCalled();
		expect(requireAgentJobs(orchestrator, owner).list()).toEqual([]);
	});
});

describe("send_message plain delivery", () => {
	it("delivers attributed text and does not wait for a reply", async () => {
		const { orchestrator, owner, worker, workerPrompt } = await createPair();

		const result = await sendMessage.execute(
			"call-1",
			{ agentId: worker, message: "have a look at the diff" },
			toolContext(orchestrator, owner),
		);

		expect(result.details.mode).toBe("message");
		expect(workerPrompt.mock.calls[0]?.[0]).toBe(`[Message from ${owner}]\n\nhave a look at the diff`);
	});

	it("delivers across trees when the caller knows the exact agent id", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const firstRoot = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const secondRoot = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const secondPrompt = stubPrompt(orchestrator, secondRoot);

		const listed = await listAgents.execute("list-first-tree", {}, toolContext(orchestrator, firstRoot));
		expect(treeLines(listed.details.entries)).toEqual([`running ${firstRoot}`]);

		await sendMessage.execute(
			"cross-tree-message",
			{ agentId: secondRoot, message: "shared id bridge" },
			toolContext(orchestrator, firstRoot),
		);

		expect(secondPrompt.mock.calls[0]?.[0]).toBe(`[Message from ${firstRoot}]\n\nshared id bridge`);
	});

	it("fails against an agent that is already disposed", async () => {
		const { orchestrator, owner, worker } = await createPair();
		await orchestrator.disposeAgent(worker, { intent: "removed" });

		await expect(
			sendMessage.execute("call-1", { agentId: worker, message: "anyone there" }, toolContext(orchestrator, owner)),
		).rejects.toThrow(/can no longer be given work/);
	});
});

describe("send_message task delegation", () => {
	it("assigns and completes a task across trees by exact ids", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const owner = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const worker = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const ownerPrompt = stubPrompt(orchestrator, owner);
		stubPrompt(orchestrator, worker);

		const assigned = await sendMessage.execute(
			"cross-tree-task",
			{ agentId: worker, message: "inspect the boundary", assignTask: true },
			toolContext(orchestrator, owner),
		);
		const taskId = assigned.details.taskId;
		if (!taskId) throw new Error("Expected a delegated task id.");
		await sendMessage.execute(
			"cross-tree-completion",
			{ agentId: owner, message: "boundary inspected", completeTask: taskId },
			toolContext(orchestrator, worker),
		);

		await vi.waitFor(() => expect(ownerPrompt).toHaveBeenCalledTimes(1));
		expect(ownerPrompt.mock.calls[0]?.[0]).toContain("boundary inspected");
	});

	it("tracks the task as a job the worker settles", async () => {
		const { orchestrator, owner, worker, ownerPrompt, workerPrompt } = await createPair();

		const assigned = await sendMessage.execute(
			"call-1",
			{ agentId: worker, message: "rename the module", assignTask: true },
			toolContext(orchestrator, owner),
		);

		expect(assigned.details).toMatchObject({ mode: "assign_task", taskId: "job-1", targetAgentId: worker });
		expect(workerPrompt.mock.calls[0]?.[0]).toContain("Task job-1 assigned to you.");
		const job = requireAgentJobs(orchestrator, owner).list()[0];
		expect(job?.jobId).toBe("job-1");
		expect(job?.origin).toEqual({ kind: "external", settlerId: worker });
		expect(job?.description).toBe("rename the module");

		// An ordinary message from the worker is not a completion.
		await sendMessage.execute(
			"call-2",
			{ agentId: owner, message: "still working on it" },
			toolContext(orchestrator, worker),
		);
		await vi.waitFor(() => expect(ownerPrompt).toHaveBeenCalledTimes(1));
		expect(
			requireAgentJobs(orchestrator, owner)
				.list()
				.map((job) => job.jobId),
		).toEqual(["job-1"]);
	});

	it("settles the task through exactly one result message", async () => {
		const { orchestrator, owner, worker, ownerPrompt } = await createPair();
		await sendMessage.execute(
			"call-1",
			{ agentId: worker, message: "rename the module", assignTask: true },
			toolContext(orchestrator, owner),
		);

		const completion = await sendMessage.execute(
			"call-2",
			{ agentId: owner, message: "renamed 3 files", completeTask: "job-1" },
			toolContext(orchestrator, worker),
		);

		expect(completion.details).toMatchObject({ mode: "complete_task", taskId: "job-1" });
		await vi.waitFor(() => expect(ownerPrompt).toHaveBeenCalledTimes(1));
		const delivered = ownerPrompt.mock.calls[0]?.[0] as string;
		expect(delivered).toContain("Background job job-1");
		expect(delivered).toContain("completed");
		expect(delivered).toContain("renamed 3 files");
		expect(orchestrator.getAgentActivity(worker).activity).not.toBe("disposed");
		// The report is the job result; no second ordinary message follows it.
		expect(ownerPrompt).toHaveBeenCalledTimes(1);
	});

	it("reports a failed task through the same result channel", async () => {
		const { orchestrator, owner, worker, ownerPrompt } = await createPair();
		await sendMessage.execute(
			"call-1",
			{ agentId: worker, message: "rename the module", assignTask: true },
			toolContext(orchestrator, owner),
		);

		await sendMessage.execute(
			"call-2",
			{ agentId: owner, message: "the module does not exist", completeTask: "job-1", taskFailed: true },
			toolContext(orchestrator, worker),
		);

		await vi.waitFor(() => expect(ownerPrompt).toHaveBeenCalledTimes(1));
		const delivered = ownerPrompt.mock.calls[0]?.[0] as string;
		expect(delivered).toContain("failed");
		expect(delivered).toContain("the module does not exist");
	});

	it("refuses a settlement from an agent the task was not assigned to", async () => {
		const { orchestrator, owner, worker } = await createPair();
		const bystander = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		stubPrompt(orchestrator, bystander);
		await sendMessage.execute(
			"call-1",
			{ agentId: worker, message: "rename the module", assignTask: true },
			toolContext(orchestrator, owner),
		);

		await expect(
			sendMessage.execute(
				"call-2",
				{ agentId: owner, message: "I did it", completeTask: "job-1" },
				toolContext(orchestrator, bystander),
			),
		).rejects.toThrow(/assigned to a different agent/);

		expect(
			requireAgentJobs(orchestrator, owner)
				.list()
				.map((job) => job.jobId),
		).toEqual(["job-1"]);
	});

	it("refuses a settlement for a task that is no longer open", async () => {
		const { orchestrator, owner, worker, ownerPrompt } = await createPair();
		await sendMessage.execute(
			"call-1",
			{ agentId: worker, message: "rename the module", assignTask: true },
			toolContext(orchestrator, owner),
		);

		// The owner giving up on the task is an abort of its own job; the worker
		// keeps running and simply finds the task closed.
		expect(orchestrator.abortAgentBackgroundJob(owner, "job-1")).toBe(true);
		await vi.waitFor(() => expect(ownerPrompt).toHaveBeenCalledTimes(1));
		expect(ownerPrompt.mock.calls[0]?.[0]).toContain("cancelled");
		expect(orchestrator.getAgentActivity(worker).activity).toBe("idle");

		await expect(
			sendMessage.execute(
				"call-2",
				{ agentId: owner, message: "done anyway", completeTask: "job-1" },
				toolContext(orchestrator, worker),
			),
		).rejects.toThrow(/is not open/);
	});

	it("cancels the task and keeps the owner alive when the worker is disposed", async () => {
		const { orchestrator, owner, worker, ownerPrompt } = await createPair();
		await sendMessage.execute(
			"call-1",
			{ agentId: worker, message: "rename the module", assignTask: true },
			toolContext(orchestrator, owner),
		);

		await disposeAgent.execute("call-2", { agentIds: [worker] }, toolContext(orchestrator, owner));

		await vi.waitFor(() => expect(ownerPrompt).toHaveBeenCalledTimes(1));
		expect(ownerPrompt.mock.calls[0]?.[0]).toContain("cancelled");
		expect(orchestrator.getAgentActivity(worker).activity).toBe("disposed");
		expect(orchestrator.getAgentActivity(owner).activity).toBe("idle");
	});

	it("retires the task when the assignment message cannot be delivered", async () => {
		const { orchestrator, owner, worker, ownerPrompt } = await createPair();
		vi.spyOn(requireAgentHarness(orchestrator, worker), "prompt").mockRejectedValue(new Error("harness exploded"));

		await expect(
			sendMessage.execute(
				"call-1",
				{ agentId: worker, message: "rename the module", assignTask: true },
				toolContext(orchestrator, owner),
			),
		).rejects.toThrow(/harness exploded/);

		expect(requireAgentJobs(orchestrator, owner).list()).toEqual([]);
		await vi.waitFor(() => expect(ownerPrompt).toHaveBeenCalledTimes(1));
		expect(ownerPrompt.mock.calls[0]?.[0]).toContain("never assigned");
	});

	it("refuses to delegate into a dispose already under way", async () => {
		const { orchestrator, owner, worker } = await createPair();
		const harness = requireAgentHarness(orchestrator, worker);
		const teardown = createDeferred<Awaited<ReturnType<typeof harness.abort>>>();
		vi.spyOn(harness, "abort").mockReturnValue(teardown.promise);
		const disposing = orchestrator.disposeAgent(worker, { intent: "removed" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The teardown has not committed the status yet, so `idle` is still what a
		// status check would report.
		expect(orchestrator.getAgentActivity(worker).activity).toBe("idle");

		await expect(
			sendMessage.execute(
				"call-1",
				{ agentId: worker, message: "one more thing", assignTask: true },
				toolContext(orchestrator, owner),
			),
		).rejects.toThrow(/can no longer be given work/);
		expect(requireAgentJobs(orchestrator, owner).list()).toEqual([]);

		teardown.resolve({ clearedSteer: [], clearedFollowUp: [] });
		await disposing;
	});
});

describe("dispose_agent", () => {
	it("handles each target on its own and enforces the tree boundary", async () => {
		const { orchestrator, owner, worker } = await createPair();
		const alreadyGone = await spawnChild(orchestrator, owner);
		const outsideTree = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		await orchestrator.disposeAgent(alreadyGone, { intent: "removed" });

		const result = await disposeAgent.execute(
			"call-1",
			{ agentIds: [worker, alreadyGone, outsideTree, "nobody", owner], reason: "cleanup" },
			toolContext(orchestrator, owner),
		);

		expect(result.details.scope).toBe("agent");
		expect(result.details.agents).toEqual([
			{ agentId: worker, state: "disposed" },
			{ agentId: alreadyGone, state: "already_disposed" },
			{ agentId: outsideTree, state: "outside_tree" },
			{ agentId: "nobody", state: "unknown" },
			{ agentId: owner, state: "self" },
		]);
		expect(orchestrator.getAgentActivity(owner).activity).toBe("idle");
		expect(orchestrator.getAgentActivity(outsideTree).activity).toBe("idle");
	});

	it("keeps surviving descendants in the original tree after single-agent disposal", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const root = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const parent = await spawnChild(orchestrator, root);
		const grandchild = await spawnChild(orchestrator, parent);
		const sibling = await spawnChild(orchestrator, root);
		const parentRef = sessionRef(orchestrator, parent);

		await disposeAgent.execute(
			"dispose-parent-only",
			{ agentIds: [parent], scope: "agent" },
			toolContext(orchestrator, root),
		);

		expect(orchestrator.getAgentActivity(parent).activity).toBe("disposed");
		expect(orchestrator.getAgentActivity(grandchild).activity).toBe("idle");
		expect(spawnParentOf(orchestrator, parent)).toBe(root);
		expect(spawnParentOf(orchestrator, grandchild)).toBe(parent);
		// The disposed agent's directory still holds the grandchild's, so the
		// surviving descendant keeps its place under a closed entry.
		const listed = await listAgents.execute("list-from-grandchild", {}, toolContext(orchestrator, grandchild));
		expect(treeLines(listed.details.entries)).toEqual([
			`running ${root}`,
			`  closed ${parentRef}`,
			`    running ${grandchild}`,
			`  running ${sibling}`,
		]);

		await orchestrator.spawnAgent({ origin: { kind: "resume", reference: parentRef } });
		expect(spawnParentOf(orchestrator, parent)).toBe(root);
		const relisted = await listAgents.execute("list-after-parent-resume", {}, toolContext(orchestrator, grandchild));
		expect(treeLines(relisted.details.entries)).toEqual([
			`running ${root}`,
			`  running ${parent}`,
			`    running ${grandchild}`,
			`  running ${sibling}`,
		]);
	});

	it("recursively disposes a subtree in leaf-to-root order", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const root = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const parent = await spawnChild(orchestrator, root);
		const firstChild = await spawnChild(orchestrator, parent);
		const grandchild = await spawnChild(orchestrator, firstChild);
		const secondChild = await spawnChild(orchestrator, parent);
		const sibling = await spawnChild(orchestrator, root);

		const result = await disposeAgent.execute(
			"dispose-subtree",
			{ agentIds: [parent], scope: "subtree", reason: "branch complete" },
			toolContext(orchestrator, root),
		);

		expect(result.details).toEqual({
			scope: "subtree",
			agents: [{ agentId: parent, state: "disposed", disposedAgentIds: [grandchild, firstChild, secondChild, parent] }],
		});
		for (const agentId of [parent, firstChild, grandchild, secondChild]) {
			expect(orchestrator.getAgentActivity(agentId).activity).toBe("disposed");
		}
		expect(orchestrator.getAgentActivity(root).activity).toBe("idle");
		expect(orchestrator.getAgentActivity(sibling).activity).toBe("idle");
		expect(spawnParentOf(orchestrator, parent)).toBe(root);
	});

	it("waits for an overlapping descendant disposal before removing its parent", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const root = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const parent = await spawnChild(orchestrator, root);
		const leaf = await spawnChild(orchestrator, parent);
		const leafHarness = requireAgentHarness(orchestrator, leaf);
		const teardown = createDeferred<Awaited<ReturnType<typeof leafHarness.abort>>>();
		const abort = vi.spyOn(leafHarness, "abort").mockReturnValue(teardown.promise);

		const leafDisposal = orchestrator.disposeAgent(leaf, { intent: "removed" });
		await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
		let parentFinished = false;
		const parentDisposal = orchestrator
			.disposeAgent(parent, { intent: "removed", scope: "subtree" })
			.then((agentIds) => {
				parentFinished = true;
				return agentIds;
			});
		await Promise.resolve();

		expect(parentFinished).toBe(false);
		expect(orchestrator.getAgentActivity(parent).activity).toBe("idle");

		teardown.resolve({ clearedSteer: [], clearedFollowUp: [] });
		await expect(leafDisposal).resolves.toEqual([leaf]);
		await expect(parentDisposal).resolves.toEqual([parent]);
		expect(orchestrator.getAgentActivity(leaf).activity).toBe("disposed");
		expect(orchestrator.getAgentActivity(parent).activity).toBe("disposed");
	});

	it("marks the whole subtree unaddressable before recursive teardown awaits", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const root = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const parent = await spawnChild(orchestrator, root);
		const leaf = await spawnChild(orchestrator, parent);
		const leafHarness = requireAgentHarness(orchestrator, leaf);
		const teardown = createDeferred<Awaited<ReturnType<typeof leafHarness.abort>>>();
		vi.spyOn(leafHarness, "abort").mockReturnValue(teardown.promise);

		const escapingSpawn = spawnAgent.execute(
			"late-subtree-spawn",
			{ profile: "worker" },
			toolContext(orchestrator, leaf),
		);
		const escapingSpawnFailure = expect(escapingSpawn).rejects.toThrow(/can no longer spawn child agents/);
		const disposing = disposeAgent.execute(
			"dispose-blocked-subtree",
			{ agentIds: [parent], scope: "subtree" },
			toolContext(orchestrator, root),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		await escapingSpawnFailure;
		await expect(
			sendMessage.execute(
				"late-subtree-task",
				{ agentId: parent, message: "late task", assignTask: true },
				toolContext(orchestrator, root),
			),
		).rejects.toThrow(/can no longer be given work/);

		teardown.resolve({ clearedSteer: [], clearedFollowUp: [] });
		await disposing;
	});

	it("refuses a recursive selection that contains the caller", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const root = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const child = await spawnChild(orchestrator, root);

		const result = await disposeAgent.execute(
			"dispose-own-tree",
			{ agentIds: [root], scope: "subtree" },
			toolContext(orchestrator, child),
		);

		expect(result.details.agents).toEqual([{ agentId: root, state: "self" }]);
		expect(orchestrator.getAgentActivity(root).activity).toBe("idle");
		expect(orchestrator.getAgentActivity(child).activity).toBe("idle");
	});
});
