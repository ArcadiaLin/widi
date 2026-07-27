import { AgentHarness } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolAgentHost } from "../../src/core/agent-host.ts";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import {
	AgentProfileRegistry,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
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
	requireAgentRecord,
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
function toolContext<TDetails>(
	orchestrator: AgentOrchestrator,
	agentId: string,
): ToolExecutionContext<TDetails> {
	const host = (
		orchestrator as unknown as {
			_createToolAgentHost: (agentId: string) => ToolAgentHost;
		}
	)._createToolAgentHost(agentId);
	return {
		signal: undefined,
		onUpdate: undefined,
		extension: undefined,
		human: undefined,
		agents: host,
		backgroundJobTable: requireAgentRecord(orchestrator, agentId)
			.backgroundJobTable,
	};
}

/**
 * Let the agent accept deliveries without running a model. A resolved prompt is
 * enough for the orchestrator to report the message as accepted.
 */
function stubPrompt(orchestrator: AgentOrchestrator, agentId: string) {
	return vi
		.spyOn(requireAgentHarness(orchestrator, agentId), "prompt")
		.mockResolvedValue({} as AssistantMessage);
}

function createDeferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** An owner and a worker, both able to accept messages. */
async function createPair() {
	const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
	const owner = await orchestrator.spawnAgent();
	const worker = await orchestrator.spawnAgent();
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
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv(), {
			enabledProfileIds: ["main"],
		});
		const agentId = await orchestrator.spawnAgent();

		const result = await listAgentProfiles.execute(
			"call-1",
			{},
			toolContext(orchestrator, agentId),
		);

		expect(result.details.profiles.map((profile) => profile.id)).toEqual([
			"main",
		]);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("main (Main Agent)"),
		});
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
		const agentId = await orchestrator.spawnAgent();

		const result = await listAgentProfiles.execute(
			"call-1",
			{},
			toolContext(orchestrator, agentId),
		);

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
	it("marks the caller, omits disposed agents, and reports unavailable ones", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent();
		const broken = await orchestrator.spawnAgent();
		const gone = await orchestrator.spawnAgent();
		requireAgentRecord(orchestrator, broken).status = "unavailable";
		await orchestrator.disposeAgent(gone);

		const result = await listAgents.execute(
			"call-1",
			{},
			toolContext(orchestrator, caller),
		);

		expect(result.details.callerAgentId).toBe(caller);
		expect(result.details.agents.map((agent) => agent.agentId)).toEqual([
			caller,
			broken,
		]);
		expect(
			result.details.agents.find((agent) => agent.agentId === broken)
				?.addressable,
		).toBe(false);
		expect(
			result.details.agents.find((agent) => agent.agentId === caller)
				?.addressable,
		).toBe(true);
	});
});

describe("spawn_agent", () => {
	it("creates an idle agent and registers no task", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent();
		const context = toolContext(orchestrator, caller);

		const result = await spawnAgent.execute(
			"call-1",
			{ profile: "worker" },
			context,
		);

		expect(result.details.profileId).toBe("worker");
		expect(result.details.taskId).toBeUndefined();
		expect(orchestrator.getAgentStatus(result.details.agentId)).toBe("idle");
		expect(context.backgroundJobTable?.list()).toEqual([]);
	});

	it("delegates the first task when one is given", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent();
		// The child does not exist yet when the call starts, so its harness cannot
		// be stubbed per instance the way the other tests do it.
		const prompt = vi
			.spyOn(AgentHarness.prototype, "prompt")
			.mockResolvedValue({} as AssistantMessage);

		const result = await spawnAgent.execute(
			"call-1",
			{ profile: "worker", task: "audit the parser" },
			toolContext(orchestrator, caller),
		);

		expect(result.details.profileId).toBe("worker");
		expect(result.details.taskId).toBe("job-1");
		expect(orchestrator.getAgentStatus(result.details.agentId)).toBe("idle");
		expect(prompt.mock.calls[0]?.[0]).toContain("Task job-1 assigned to you.");
		expect(prompt.mock.calls[0]?.[0]).toContain("audit the parser");
	});

	it("fails without leaving a half-built agent when the profile is unknown", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const caller = await orchestrator.spawnAgent();
		const context = toolContext(orchestrator, caller);

		await expect(
			spawnAgent.execute("call-1", { profile: "nonexistent" }, context),
		).rejects.toThrow(/nonexistent/);

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
				{
					agentId: worker,
					message: "both",
					assignTask: true,
					completeTask: "job-1",
				},
				context,
			),
		).rejects.toThrow(/cannot both assign a task and complete one/);
		await expect(
			sendMessage.execute(
				"call-2",
				{ agentId: worker, message: "orphan flag", taskFailed: true },
				context,
			),
		).rejects.toThrow(/only accepts taskFailed together with completeTask/);
		await expect(
			sendMessage.execute(
				"call-3",
				{ agentId: owner, message: "to myself" },
				context,
			),
		).rejects.toThrow(/cannot target yourself/);

		expect(workerPrompt).not.toHaveBeenCalled();
		expect(
			requireAgentRecord(orchestrator, owner).backgroundJobTable.list(),
		).toEqual([]);
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
		expect(workerPrompt.mock.calls[0]?.[0]).toBe(
			`[Message from ${owner}]\n\nhave a look at the diff`,
		);
	});

	it("fails against an agent that is already disposed", async () => {
		const { orchestrator, owner, worker } = await createPair();
		await orchestrator.disposeAgent(worker);

		await expect(
			sendMessage.execute(
				"call-1",
				{ agentId: worker, message: "anyone there" },
				toolContext(orchestrator, owner),
			),
		).rejects.toThrow(/can no longer be given work/);
	});
});

describe("send_message task delegation", () => {
	it("tracks the task as a job the worker settles", async () => {
		const { orchestrator, owner, worker, ownerPrompt, workerPrompt } =
			await createPair();

		const assigned = await sendMessage.execute(
			"call-1",
			{ agentId: worker, message: "rename the module", assignTask: true },
			toolContext(orchestrator, owner),
		);

		expect(assigned.details).toMatchObject({
			mode: "assign_task",
			taskId: "job-1",
			targetAgentId: worker,
		});
		expect(workerPrompt.mock.calls[0]?.[0]).toContain(
			"Task job-1 assigned to you.",
		);
		const job = requireAgentRecord(orchestrator, owner).backgroundJobTable.get(
			"job-1",
		);
		expect(job?.phase).toBe("backgrounded");
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
			requireAgentRecord(orchestrator, owner).backgroundJobTable.get("job-1")
				?.phase,
		).toBe("backgrounded");
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

		expect(completion.details).toMatchObject({
			mode: "complete_task",
			taskId: "job-1",
		});
		await vi.waitFor(() => expect(ownerPrompt).toHaveBeenCalledTimes(1));
		const delivered = ownerPrompt.mock.calls[0]?.[0] as string;
		expect(delivered).toContain("Background job job-1");
		expect(delivered).toContain("completed");
		expect(delivered).toContain("renamed 3 files");
		expect(orchestrator.getAgentStatus(worker)).not.toBe("disposed");
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
			{
				agentId: owner,
				message: "the module does not exist",
				completeTask: "job-1",
				taskFailed: true,
			},
			toolContext(orchestrator, worker),
		);

		await vi.waitFor(() => expect(ownerPrompt).toHaveBeenCalledTimes(1));
		const delivered = ownerPrompt.mock.calls[0]?.[0] as string;
		expect(delivered).toContain("failed");
		expect(delivered).toContain("the module does not exist");
	});

	it("refuses a settlement from an agent the task was not assigned to", async () => {
		const { orchestrator, owner, worker } = await createPair();
		const bystander = await orchestrator.spawnAgent();
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
			requireAgentRecord(orchestrator, owner).backgroundJobTable.get("job-1")
				?.phase,
		).toBe("backgrounded");
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
		expect(orchestrator.getAgentStatus(worker)).toBe("idle");

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

		await disposeAgent.execute(
			"call-2",
			{ agentIds: [worker] },
			toolContext(orchestrator, owner),
		);

		await vi.waitFor(() => expect(ownerPrompt).toHaveBeenCalledTimes(1));
		expect(ownerPrompt.mock.calls[0]?.[0]).toContain("cancelled");
		expect(orchestrator.getAgentStatus(worker)).toBe("disposed");
		expect(orchestrator.getAgentStatus(owner)).toBe("idle");
	});

	it("retires the task when the assignment message cannot be delivered", async () => {
		const { orchestrator, owner, worker, ownerPrompt } = await createPair();
		vi.spyOn(
			requireAgentHarness(orchestrator, worker),
			"prompt",
		).mockRejectedValue(new Error("harness exploded"));

		await expect(
			sendMessage.execute(
				"call-1",
				{ agentId: worker, message: "rename the module", assignTask: true },
				toolContext(orchestrator, owner),
			),
		).rejects.toThrow(/harness exploded/);

		const table = requireAgentRecord(orchestrator, owner).backgroundJobTable;
		expect(table.get("job-1")).toBeUndefined();
		await vi.waitFor(() => expect(ownerPrompt).toHaveBeenCalledTimes(1));
		expect(ownerPrompt.mock.calls[0]?.[0]).toContain("never assigned");
	});

	it("refuses to delegate into a dispose already under way", async () => {
		const { orchestrator, owner, worker } = await createPair();
		const harness = requireAgentHarness(orchestrator, worker);
		const teardown =
			createDeferred<Awaited<ReturnType<typeof harness.abort>>>();
		vi.spyOn(harness, "abort").mockReturnValue(teardown.promise);
		const disposing = orchestrator.disposeAgent(worker);
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The teardown has not committed the status yet, so `idle` is still what a
		// status check would report.
		expect(orchestrator.getAgentStatus(worker)).toBe("idle");

		await expect(
			sendMessage.execute(
				"call-1",
				{ agentId: worker, message: "one more thing", assignTask: true },
				toolContext(orchestrator, owner),
			),
		).rejects.toThrow(/can no longer be given work/);
		expect(
			requireAgentRecord(orchestrator, owner).backgroundJobTable.list(),
		).toEqual([]);

		teardown.resolve({ clearedSteer: [], clearedFollowUp: [] });
		await disposing;
	});
});

describe("dispose_agent", () => {
	it("handles each target on its own and refuses self-disposal", async () => {
		const { orchestrator, owner, worker } = await createPair();
		const alreadyGone = await orchestrator.spawnAgent();
		await orchestrator.disposeAgent(alreadyGone);

		const result = await disposeAgent.execute(
			"call-1",
			{ agentIds: [worker, alreadyGone, "nobody", owner], reason: "cleanup" },
			toolContext(orchestrator, owner),
		);

		expect(result.details.agents).toEqual([
			{ agentId: worker, state: "disposed" },
			{ agentId: alreadyGone, state: "already_disposed" },
			{ agentId: "nobody", state: "unknown" },
			{ agentId: owner, state: "self" },
		]);
		expect(orchestrator.getAgentStatus(owner)).toBe("idle");
	});
});
