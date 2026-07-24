import type {
	AgentHarnessEvent,
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
import {
	type ResolvedAgentHarnessTool,
	type ToolAdapterContext,
	ToolRegistry,
} from "../../src/core/tool-registry.ts";
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

async function resolveRecordToolContext(
	record: AgentRecord,
): Promise<ToolAdapterContext> {
	const source = (
		record.harness as unknown as {
			toolContext:
				| ToolAdapterContext
				| (() => ToolAdapterContext | Promise<ToolAdapterContext>);
		}
	).toolContext;
	return await (typeof source === "function" ? source() : source);
}

describe("AgentOrchestrator background job router", () => {
	it("delivers a settled result to an idle agent as a prompt", async () => {
		const { record } = await spawnAgent();
		const prompt = vi.fn(async (_text: string) => ({}) as AssistantMessage);
		record.harness = {
			prompt,
		} as unknown as NonNullable<AgentRecord["harness"]>;

		const jobId = settleBackgroundedJob(record, completedOutcome);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));

		const text = prompt.mock.calls[0]?.[0] as string;
		expect(text).toContain(jobId);
		expect(text).toContain("completed");
		expect(text).toContain("build done");
	});

	it("steers a settled result into the active run while running", async () => {
		const { record } = await spawnAgent();
		const prompt = vi.fn(async (_text: string) => ({}) as AssistantMessage);
		const steer = vi.fn(async (_text: string) => {});
		record.harness = {
			prompt,
			steer,
		} as unknown as NonNullable<AgentRecord["harness"]>;
		record.status = "running";

		const jobId = settleBackgroundedJob(record, completedOutcome);
		await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
		expect(prompt).not.toHaveBeenCalled();
		const text = steer.mock.calls[0]?.[0] as string;
		expect(text).toContain(jobId);
		expect(text).toContain("build done");
	});

	it("joins results buffered before the agent is deliverable into a single prompt", async () => {
		const { orchestrator, agentId, record } = await spawnAgent();
		const prompt = vi.fn(async (_text: string) => ({}) as AssistantMessage);
		record.harness = {
			prompt,
		} as unknown as NonNullable<AgentRecord["harness"]>;
		// Not yet deliverable: results accumulate in the buffer until the agent
		// reaches an idle boundary, then flush together as one prompt.
		record.status = "creating";

		const first = settleBackgroundedJob(record, completedOutcome, "call-1");
		const second = settleBackgroundedJob(record, completedOutcome, "call-2");
		await tick();
		expect(prompt).not.toHaveBeenCalled();

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
		record.harness = {
			prompt,
		} as unknown as NonNullable<AgentRecord["harness"]>;
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
		record.harness = {
			prompt,
		} as unknown as NonNullable<AgentRecord["harness"]>;
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
		record.harness = {
			prompt,
		} as unknown as NonNullable<AgentRecord["harness"]>;
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
		} as unknown as NonNullable<AgentRecord["harness"]>;

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

	it("streams output increments and flushes the final one before settling", async () => {
		const { orchestrator, record } = await spawnAgent();
		// Busy so settlements stay buffered; we only assert the emitted stream here.
		record.status = "running";
		const log: Array<
			| { kind: "progress"; sequence: number; chunk: string; startByte: number }
			| { kind: "changed"; transition: string }
		> = [];
		orchestrator.subscribe((event) => {
			if (event.type === "agent_background_job_progress") {
				log.push({
					kind: "progress",
					sequence: event.sequence,
					chunk: Buffer.from(event.chunk, "base64").toString("utf-8"),
					startByte: event.startByte,
				});
			} else if (event.type === "agent_background_job_changed") {
				log.push({ kind: "changed", transition: event.transition });
			}
		});

		const job = record.backgroundJobTable.create({
			toolCallId: "call-1",
			toolName: "bash",
		});
		record.backgroundJobTable.background(job.id);
		job.output.append("line1\n");
		// Wait for the first increment to be emitted before appending the next, so
		// the two do not coalesce into one drain.
		await vi.waitFor(() =>
			expect(
				log.some((e) => e.kind === "progress" && e.chunk === "line1\n"),
			).toBe(true),
		);

		job.output.append("line2\n");
		record.backgroundJobTable.settle(job.id, completedOutcome);
		await vi.waitFor(() =>
			expect(
				log.some((e) => e.kind === "changed" && e.transition === "settled"),
			).toBe(true),
		);

		const progresses = log.filter((e) => e.kind === "progress");
		expect(progresses).toEqual([
			{ kind: "progress", sequence: 0, chunk: "line1\n", startByte: 0 },
			{ kind: "progress", sequence: 1, chunk: "line2\n", startByte: 6 },
		]);
		// Barrier: the job's final increment is emitted before its terminal event.
		const lastProgress = log.lastIndexOf(
			progresses[progresses.length - 1] as (typeof log)[number],
		);
		const settledIndex = log.findIndex(
			(e) => e.kind === "changed" && e.transition === "settled",
		);
		expect(lastProgress).toBeLessThan(settledIndex);
	});

	it("publishes accumulated output only after the backgrounded lifecycle event", async () => {
		const { orchestrator, record } = await spawnAgent();
		record.status = "running";
		const log: Array<{ kind: "changed" | "progress"; value: string }> = [];
		orchestrator.subscribe((event) => {
			if (event.type === "agent_background_job_changed") {
				log.push({ kind: "changed", value: event.transition });
			}
			if (event.type === "agent_background_job_progress") {
				log.push({
					kind: "progress",
					value: Buffer.from(event.chunk, "base64").toString("utf-8"),
				});
			}
		});

		const job = record.backgroundJobTable.create({
			toolCallId: "call-1",
			toolName: "bash",
		});
		job.output.append("pre-t0\n");
		await tick();
		expect(log).toEqual([]);

		record.backgroundJobTable.background(job.id);
		await vi.waitFor(() =>
			expect(log).toEqual([
				{ kind: "changed", value: "backgrounded" },
				{ kind: "progress", value: "pre-t0\n" },
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
				description: undefined,
				phase: "backgrounded",
				status: undefined,
				stopReason: undefined,
				startedAt: expect.any(Number),
				backgroundedAt: expect.any(Number),
				endedAt: undefined,
				totalBytesSeen: 9,
				droppedBytes: 0,
				tailDroppedBytes: 0,
				progressDroppedBytes: 0,
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

	it("delivers byte-exact progress events to extension observers", async () => {
		const seen: Array<{
			text: string;
			startByte: number;
			endByte: number;
		}> = [];
		const { record } = await spawnWithJobExtension({
			module: (api) => {
				api.observe("agent_background_job_progress", (event) => {
					seen.push({
						text: Buffer.from(event.chunk, "base64").toString("utf-8"),
						startByte: event.startByte,
						endByte: event.endByte,
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
		job.output.append("progress\n");

		await vi.waitFor(() =>
			expect(seen).toEqual([{ text: "progress\n", startByte: 0, endByte: 9 }]),
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
				_agentToolSets: Map<string, { tools: ResolvedAgentHarnessTool[] }>;
			}
		)._agentToolSets.get(agentId);
		const probe = toolSet?.tools.find((tool) => tool.name === "probe");
		if (!probe) throw new Error("probe tool not resolved for agent");
		const record = requireAgentRecord(orchestrator, agentId);
		return resolveRecordToolContext(record).then((context) =>
			probe.execute("call-1", {}, undefined, undefined, context),
		);
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

	it("provides fresh turn contexts with per-agent job table isolation", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, {
			toolRegistry: createToolRegistry(probeTool),
		});
		const firstAgentId = await orchestrator.spawnAgent();
		const secondAgentId = await orchestrator.spawnAgent();
		const firstRecord = requireAgentRecord(orchestrator, firstAgentId);
		const secondRecord = requireAgentRecord(orchestrator, secondAgentId);

		const firstContext = await resolveRecordToolContext(firstRecord);
		const nextFirstContext = await resolveRecordToolContext(firstRecord);
		const secondContext = await resolveRecordToolContext(secondRecord);

		expect(nextFirstContext).not.toBe(firstContext);
		expect(firstContext.backgroundJobTable).toBe(
			firstRecord.backgroundJobTable,
		);
		expect(nextFirstContext.backgroundJobTable).toBe(
			firstRecord.backgroundJobTable,
		);
		expect(secondContext.backgroundJobTable).toBe(
			secondRecord.backgroundJobTable,
		);
		expect(secondContext.backgroundJobTable).not.toBe(
			firstContext.backgroundJobTable,
		);
	});
});
