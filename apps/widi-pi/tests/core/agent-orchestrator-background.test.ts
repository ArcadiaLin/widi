import type {
	AgentHarness,
	AgentHarnessEvent,
	AgentTool,
	AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { AgentHarnessError } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import jobToolsExtension from "../../../../.widi/extensions/job-tools/index.ts";
import type {
	AgentOrchestrator,
	OrchestratorEvent,
} from "../../src/core/agent-orchestrator.ts";
import {
	type AgentProfile,
	AgentProfileRegistry,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
import type { AgentRecord } from "../../src/core/agent-record.ts";
import type { BackgroundJobOutcome } from "../../src/core/background-job.ts";
import type { ExtensionModule } from "../../src/core/extension/index.ts";
import { ToolRegistry } from "../../src/core/tool-registry.ts";
import { registerCoreJobTools } from "../../src/core/tools/jobs/builtin.ts";
import type { ToolDefinition } from "../../src/core/tools/types.ts";
import {
	createOrchestrator,
	createToolDefinition,
	createToolRegistry,
	defaultProfile,
	MemoryExecutionEnv,
	requireAgentRecord,
} from "../helpers/orchestrator.ts";

async function spawnAgent(): Promise<{
	orchestrator: AgentOrchestrator;
	agentId: string;
	record: AgentRecord;
}> {
	const env = new MemoryExecutionEnv();
	const orchestrator = await createOrchestrator(env);
	const agentId = await orchestrator.spawnAgent();
	return {
		orchestrator,
		agentId,
		record: requireAgentRecord(orchestrator, agentId),
	};
}

/** Register, background, and settle a job on the agent's own table. */
function settleBackgroundedJob(
	record: AgentRecord,
	outcome: BackgroundJobOutcome,
	toolCallId = "call-1",
): string {
	const job = record.backgroundJobTable.create({
		toolCallId,
		toolName: "sleeper",
	});
	record.backgroundJobTable.background(job.id);
	record.backgroundJobTable.settle(job.id, outcome);
	return job.id;
}

/** Drive the harness `settled` event through the orchestrator's subscription. */
async function driveSettled(
	orchestrator: AgentOrchestrator,
	agentId: string,
): Promise<void> {
	const event: AgentHarnessEvent = { type: "settled", nextTurnCount: 0 };
	await (
		orchestrator as unknown as {
			_handleSubscribedAgentHarnessEvent: (
				agentId: string,
				event: AgentHarnessEvent,
			) => Promise<void>;
		}
	)._handleSubscribedAgentHarnessEvent(agentId, event);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const completedOutcome: BackgroundJobOutcome = {
	status: "completed",
	result: {
		content: [{ type: "text", text: "build done" }],
		details: undefined,
	},
};

describe("AgentOrchestrator background job router", () => {
	it("delivers a settled result to an idle agent as a prompt", async () => {
		const { record } = await spawnAgent();
		const prompt = vi.fn(async (_text: string) => ({}) as AssistantMessage);
		record.harness = { prompt } as unknown as AgentHarness;

		const jobId = settleBackgroundedJob(record, completedOutcome);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));

		const text = prompt.mock.calls[0]?.[0] as string;
		expect(text).toContain(jobId);
		expect(text).toContain("completed");
		expect(text).toContain("build done");
	});

	it("buffers while running and flushes on the next idle boundary", async () => {
		const { orchestrator, agentId, record } = await spawnAgent();
		const prompt = vi.fn(async (_text: string) => ({}) as AssistantMessage);
		record.harness = { prompt } as unknown as AgentHarness;
		record.status = "running";

		settleBackgroundedJob(record, completedOutcome);
		await tick();
		expect(prompt).not.toHaveBeenCalled();

		await driveSettled(orchestrator, agentId);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
		expect(prompt.mock.calls[0]?.[0] as string).toContain("build done");
	});

	it("joins multiple buffered results into a single prompt", async () => {
		const { orchestrator, agentId, record } = await spawnAgent();
		const prompt = vi.fn(async (_text: string) => ({}) as AssistantMessage);
		record.harness = { prompt } as unknown as AgentHarness;
		record.status = "running";

		const first = settleBackgroundedJob(record, completedOutcome, "call-1");
		const second = settleBackgroundedJob(record, completedOutcome, "call-2");
		await driveSettled(orchestrator, agentId);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));

		const text = prompt.mock.calls[0]?.[0] as string;
		expect(text).toContain(first);
		expect(text).toContain(second);
	});

	it("requeues on busy and retries at the next idle boundary", async () => {
		const { orchestrator, agentId, record } = await spawnAgent();
		let calls = 0;
		const prompt = vi.fn(async (_text: string) => {
			calls += 1;
			if (calls === 1) throw new AgentHarnessError("busy", "busy");
			return {} as AssistantMessage;
		});
		record.harness = { prompt } as unknown as AgentHarness;
		const internals = orchestrator as unknown as {
			_pendingBackgroundResults: Map<string, string[]>;
		};

		settleBackgroundedJob(record, completedOutcome);
		await tick();
		// One attempt, then it waits for `settled` rather than retrying inline.
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(internals._pendingBackgroundResults.get(agentId)).toHaveLength(1);

		await driveSettled(orchestrator, agentId);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
		expect(internals._pendingBackgroundResults.get(agentId) ?? []).toEqual([]);
	});

	it("does not hot-loop while the harness stays busy", async () => {
		const { orchestrator, agentId, record } = await spawnAgent();
		const prompt = vi.fn(async (_text: string) => {
			throw new AgentHarnessError("busy", "busy");
		});
		record.harness = { prompt } as unknown as AgentHarness;
		const internals = orchestrator as unknown as {
			_pendingBackgroundResults: Map<string, string[]>;
		};

		settleBackgroundedJob(record, completedOutcome);
		await tick();
		await tick();
		await tick();
		// A single attempt: no inline recursion spinning against a busy harness.
		expect(prompt).toHaveBeenCalledTimes(1);
		// The result is preserved for a later `settled`-driven retry.
		expect(internals._pendingBackgroundResults.get(agentId)).toHaveLength(1);
	});

	it("preserves results and retries when delivery fails with a non-busy error", async () => {
		const { orchestrator, agentId, record } = await spawnAgent();
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		let calls = 0;
		const prompt = vi.fn(async (_text: string) => {
			calls += 1;
			if (calls === 1) throw new Error("session write failed");
			return {} as AssistantMessage;
		});
		record.harness = { prompt } as unknown as AgentHarness;
		const internals = orchestrator as unknown as {
			_pendingBackgroundResults: Map<string, string[]>;
		};

		settleBackgroundedJob(record, completedOutcome);
		await tick();
		// The result is preserved (not dropped) and a diagnostic is recorded.
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(internals._pendingBackgroundResults.get(agentId)).toHaveLength(1);
		expect(
			events
				.filter((event) => event.type === "diagnostic")
				.map((event) => event.diagnostic.code),
		).toContain("orchestrator.background_job_delivery_failed");

		await driveSettled(orchestrator, agentId);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
		expect(internals._pendingBackgroundResults.get(agentId) ?? []).toEqual([]);
	});

	it("records a diagnostic instead of rejecting when a prompt throws unexpectedly", async () => {
		const { orchestrator, record } = await spawnAgent();
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		record.harness = {
			prompt: vi.fn(async (_text: string) => {
				throw new Error("session write failed");
			}),
		} as unknown as AgentHarness;

		settleBackgroundedJob(record, completedOutcome);
		await vi.waitFor(() => {
			const codes = events
				.filter((event) => event.type === "diagnostic")
				.map((event) => event.diagnostic.code);
			expect(codes).toContain("orchestrator.background_job_delivery_failed");
		});
	});

	it("cascades an abort to live jobs and detaches on dispose", async () => {
		const { orchestrator, agentId, record } = await spawnAgent();
		const job = record.backgroundJobTable.create({
			toolCallId: "call-1",
			toolName: "sleeper",
		});
		record.backgroundJobTable.background(job.id);
		expect(job.signal.aborted).toBe(false);

		await orchestrator.disposeAgent(agentId);

		expect(job.signal.aborted).toBe(true);
		const internals = orchestrator as unknown as {
			_unsubscribeAgentJobChanges: Map<string, unknown>;
			_pendingBackgroundResults: Map<string, unknown>;
			_backgroundFlushInFlight: Set<string>;
		};
		expect(internals._unsubscribeAgentJobChanges.has(agentId)).toBe(false);
		expect(internals._pendingBackgroundResults.has(agentId)).toBe(false);
		expect(internals._backgroundFlushInFlight.has(agentId)).toBe(false);
	});

	it("drops buffered results whose owning agent is gone, with a diagnostic", async () => {
		const { orchestrator } = await spawnAgent();
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const internals = orchestrator as unknown as {
			_pendingBackgroundResults: Map<string, string[]>;
			_flushBackgroundResults: (agentId: string) => Promise<void>;
		};
		internals._pendingBackgroundResults.set("missing-agent", ["stranded"]);

		await internals._flushBackgroundResults("missing-agent");

		const codes = events
			.filter((event) => event.type === "diagnostic")
			.map((event) => event.diagnostic.code);
		expect(codes).toContain("orchestrator.background_job_dropped");
		expect(internals._pendingBackgroundResults.has("missing-agent")).toBe(
			false,
		);
	});

	it("emits per-job change events as jobs background and settle", async () => {
		const { orchestrator, record } = await spawnAgent();
		// Keep the agent busy so the settlement stays buffered; we only assert the
		// change events here, not delivery.
		record.status = "running";
		const seen: Array<{
			transition: string;
			jobId: string;
			status?: string;
			liveCount: number;
		}> = [];
		orchestrator.subscribe((event) => {
			if (event.type === "agent_background_job_changed") {
				seen.push({
					transition: event.transition,
					jobId: event.job.jobId,
					status: event.job.status,
					liveCount: event.liveCount,
				});
			}
		});

		const job = record.backgroundJobTable.create({
			toolCallId: "call-1",
			toolName: "bash",
		});
		record.backgroundJobTable.background(job.id);
		await vi.waitFor(() =>
			expect(seen).toEqual([
				{
					transition: "backgrounded",
					jobId: job.id,
					status: undefined,
					liveCount: 1,
				},
			]),
		);

		record.backgroundJobTable.settle(job.id, completedOutcome);
		await vi.waitFor(() =>
			expect(seen).toEqual([
				{
					transition: "backgrounded",
					jobId: job.id,
					status: undefined,
					liveCount: 1,
				},
				{
					transition: "settled",
					jobId: job.id,
					status: "completed",
					liveCount: 0,
				},
			]),
		);
	});

	it("emits an aborting change when a live job is aborted", async () => {
		const { orchestrator, record } = await spawnAgent();
		record.status = "running";
		const transitions: string[] = [];
		orchestrator.subscribe((event) => {
			if (event.type === "agent_background_job_changed")
				transitions.push(event.transition);
		});

		const job = record.backgroundJobTable.create({
			toolCallId: "call-1",
			toolName: "bash",
		});
		record.backgroundJobTable.background(job.id);
		record.backgroundJobTable.abort(job.id);
		record.backgroundJobTable.settle(job.id, { status: "cancelled" });

		await vi.waitFor(() =>
			expect(transitions).toEqual(["backgrounded", "aborting", "settled"]),
		);
	});

	it("exposes live jobs and their output tails through the query API", async () => {
		const { orchestrator, agentId, record } = await spawnAgent();
		record.status = "running";
		const job = record.backgroundJobTable.create({
			toolCallId: "call-1",
			toolName: "bash",
		});
		// Pre-t0 (running phase) jobs are not observable.
		expect(orchestrator.listAgentBackgroundJobs(agentId)).toEqual([]);
		expect(
			orchestrator.readAgentBackgroundJobOutput(agentId, job.id),
		).toBeUndefined();

		record.backgroundJobTable.background(job.id);
		job.output.append("progress\n");
		expect(orchestrator.listAgentBackgroundJobs(agentId)).toEqual([
			{
				jobId: job.id,
				toolCallId: "call-1",
				toolName: "bash",
				phase: "backgrounded",
				status: undefined,
			},
		]);
		expect(orchestrator.readAgentBackgroundJobOutput(agentId, job.id)).toBe(
			"progress\n",
		);

		record.backgroundJobTable.settle(job.id, completedOutcome);
		expect(orchestrator.listAgentBackgroundJobs(agentId)).toEqual([]);
		expect(
			orchestrator.readAgentBackgroundJobOutput(agentId, job.id),
		).toBeUndefined();
	});
});

describe("AgentOrchestrator background job extension observability", () => {
	async function spawnWithJobExtension(options: {
		module: ExtensionModule;
		toolRegistry?: ToolRegistry;
	}): Promise<{
		orchestrator: AgentOrchestrator;
		agentId: string;
		record: AgentRecord;
	}> {
		const env = new MemoryExecutionEnv();
		const profile: AgentProfile = {
			...defaultProfile,
			id: "gated",
			label: "Gated",
			persist: false,
			extensions: ["job-tools"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: profile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([{ profile }]),
			),
			toolRegistry: options.toolRegistry,
		});
		orchestrator.registerExtension("job-tools", options.module);
		const agentId = await orchestrator.spawnAgent();
		return {
			orchestrator,
			agentId,
			record: requireAgentRecord(orchestrator, agentId),
		};
	}

	it("delivers job change events to extension observers", async () => {
		const seen: Array<{ transition: string; liveCount: number }> = [];
		const { record } = await spawnWithJobExtension({
			module: (api) => {
				api.observe("agent_background_job_changed", (event) => {
					seen.push({
						transition: event.transition,
						liveCount: event.liveCount,
					});
				});
			},
		});
		record.status = "running";

		const job = record.backgroundJobTable.create({
			toolCallId: "call-1",
			toolName: "bash",
		});
		record.backgroundJobTable.background(job.id);
		record.backgroundJobTable.settle(job.id, completedOutcome);

		await vi.waitFor(() =>
			expect(seen).toEqual([
				{ transition: "backgrounded", liveCount: 1 },
				{ transition: "settled", liveCount: 0 },
			]),
		);
	});

	it("supports gating job tools on live jobs via the job-tools sample extension", async () => {
		const registry = new ToolRegistry();
		registry.defineTool(createToolDefinition("probe"), {
			kind: "core",
			id: "test",
		});
		registerCoreJobTools(registry);
		const { orchestrator, agentId, record } = await spawnWithJobExtension({
			module: jobToolsExtension,
			toolRegistry: registry,
		});

		// Initial retraction at spawn: the job tools stay registered but inactive.
		expect(orchestrator.getAgentTools(agentId).toolNames).toContain("read_job");
		await vi.waitFor(() =>
			expect(orchestrator.getAgentActiveTools(agentId)).toEqual(["probe"]),
		);

		// Keep the settlement buffered; delivery is not under test here.
		record.status = "running";
		const job = record.backgroundJobTable.create({
			toolCallId: "call-1",
			toolName: "bash",
		});
		record.backgroundJobTable.background(job.id);
		await vi.waitFor(() =>
			expect(orchestrator.getAgentActiveTools(agentId)).toEqual([
				"probe",
				"read_job",
				"wait_for_jobs",
				"kill_job",
			]),
		);

		record.backgroundJobTable.settle(job.id, completedOutcome);
		await vi.waitFor(() =>
			expect(orchestrator.getAgentActiveTools(agentId)).toEqual(["probe"]),
		);
	});
});

describe("AgentOrchestrator background job context", () => {
	// A plain (non-backgroundable) tool that reports whether the adapter injected
	// a background job table into its execution context.
	const probeTool: ToolDefinition = {
		name: "probe",
		label: "probe",
		description: "reports whether the background job table was injected",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, context) => ({
			content: [
				{
					type: "text",
					text: context.backgroundJobTable ? "has-table" : "no-table",
				},
			],
			details: undefined,
		}),
	};

	function probeTableState(
		orchestrator: AgentOrchestrator,
		agentId: string,
	): Promise<AgentToolResult<unknown>> {
		const toolSet = (
			orchestrator as unknown as {
				_agentToolSets: Map<string, { tools: AgentTool[] }>;
			}
		)._agentToolSets.get(agentId);
		const probe = toolSet?.tools.find((tool) => tool.name === "probe");
		if (!probe) throw new Error("probe tool not resolved for agent");
		return probe.execute("call-1", {}, undefined, undefined);
	}

	const textOf = (result: AgentToolResult<unknown>): string =>
		result.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("");

	it("always injects the agent's job table", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, {
			toolRegistry: createToolRegistry(probeTool),
		});
		const agentId = await orchestrator.spawnAgent();

		expect(textOf(await probeTableState(orchestrator, agentId))).toBe(
			"has-table",
		);
	});
});
