/**
 * The orchestrator's half of the background job domain: routing a settled job's
 * t1 to its owner, translating the runtime's events into orchestrator events,
 * and handing the owner's capabilities to tools and extensions.
 *
 * The job runtime's own invariants are covered by background-job-runtime; what
 * is asserted here is only what needs an agent to be true.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentHarnessEvent, AgentToolResult } from "@widi/agent-core";
import { AgentHarnessError } from "@widi/agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import {
	type AgentProfile,
	AgentProfileRegistry,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
import type { LiveAgent } from "../../src/core/agent-types.ts";
import type { BackgroundJobHost, BackgroundJobOutcome } from "../../src/core/background/index.ts";
import type { ExtensionContext, ExtensionModule } from "../../src/core/extension/index.ts";
import { type ToolAdapterContext, ToolRegistry } from "../../src/core/tool-registry.ts";
import { registerCoreJobTools } from "../../src/core/tools/jobs/builtin.ts";
import type { ToolDefinition } from "../../src/core/tools/types.ts";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import jobToolsExtension from "../extensions/job-tools-extension.ts";
import { startBackgroundedJob } from "../helpers/background-jobs.ts";
import {
	createOrchestrator,
	createToolDefinition,
	createToolRegistry,
	defaultProfile,
	harnessInputText,
	MemoryExecutionEnv,
	requireAgentHarness,
	requireAgentJobs,
	requireLiveAgent,
} from "../helpers/orchestrator.ts";

interface SpawnedAgent {
	readonly orchestrator: AgentOrchestrator;
	readonly agentId: string;
	readonly liveAgent: LiveAgent;
	readonly jobs: BackgroundJobHost;
}

async function spawnAgent(): Promise<SpawnedAgent> {
	const env = new MemoryExecutionEnv();
	const orchestrator = await createOrchestrator(env);
	const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
	const liveAgent = requireLiveAgent(orchestrator, agentId);
	return { orchestrator, agentId, liveAgent, jobs: liveAgent.backgroundAttachment.host };
}

function requireExtensionContext(
	orchestrator: AgentOrchestrator,
	agentId: string,
	extensionId = "job-tools",
): ExtensionContext {
	return requireLiveAgent(orchestrator, agentId).extensionRunner.createContext(extensionId);
}

/** Background a job on the agent's own host and settle it in one step. */
function settleBackgroundedJob(jobs: BackgroundJobHost, outcome: BackgroundJobOutcome, toolCallId = "call-1"): string {
	const { execution, job } = startBackgroundedJob(jobs, { toolCallId, toolName: "sleeper" });
	execution.settle(outcome);
	return job.jobId;
}

/**
 * Hold the harness in a non-idle phase without running a model, so a settlement
 * stays buffered on the delivery queue.
 */
function holdAgentBusy(orchestrator: AgentOrchestrator, agentId: string): void {
	(requireAgentHarness(orchestrator, agentId) as unknown as { phase: "turn" }).phase = "turn";
}

/** Drive the harness `settled` event through the orchestrator's subscription. */
async function driveSettled(orchestrator: AgentOrchestrator, agentId: string): Promise<void> {
	const event: AgentHarnessEvent = { type: "settled", nextTurnCount: 0 };
	const generation = requireLiveAgent(orchestrator, agentId).generation;
	await (
		orchestrator as unknown as {
			_handleHarnessEvent: (
				agentId: string,
				generation: number,
				event: AgentHarnessEvent,
				signal: AbortSignal | undefined,
			) => Promise<void>;
		}
	)._handleHarnessEvent(agentId, generation, event, undefined);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Whether the agent still has a message waiting on its delivery queue. */
function pendingMessages(orchestrator: AgentOrchestrator, agentId: string): boolean {
	return (orchestrator as unknown as { _messages: { hasPending: (agentId: string) => boolean } })._messages.hasPending(
		agentId,
	);
}

const completedOutcome: BackgroundJobOutcome = {
	status: "completed",
	result: { content: [{ type: "text", text: "build done" }], details: undefined },
};

async function resolveAgentToolContext(orchestrator: AgentOrchestrator, agentId: string): Promise<ToolAdapterContext> {
	const source = (
		requireAgentHarness(orchestrator, agentId) as unknown as {
			toolContext: ToolAdapterContext | (() => ToolAdapterContext | Promise<ToolAdapterContext>);
		}
	).toolContext;
	return await (typeof source === "function" ? source() : source);
}

describe("AgentOrchestrator background job router", () => {
	it("delivers a settled result to an idle agent as a prompt", async () => {
		const { orchestrator, agentId, jobs } = await spawnAgent();
		const prompt = vi
			.spyOn(requireAgentHarness(orchestrator, agentId), "prompt")
			.mockResolvedValue({} as AssistantMessage);

		const jobId = settleBackgroundedJob(jobs, completedOutcome);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));

		const text = harnessInputText(prompt.mock.calls[0]?.[0]);
		expect(text).toContain(jobId);
		expect(text).toContain("completed");
		expect(text).toContain("build done");
	});

	// A follow-up is only drained where the agent loop would otherwise stop, so a
	// job settling early in a long tool chain would go unread for the rest of the
	// run. A steer reaches the model at the next turn boundary instead, which is
	// the first point it can act on a result it was told to expect. Neither
	// preempts the turn in flight.
	it("steers a settled result into the active run while running", async () => {
		const { orchestrator, agentId, jobs } = await spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);
		const prompt = vi.spyOn(harness, "prompt").mockResolvedValue({} as AssistantMessage);
		const steer = vi.spyOn(harness, "steer").mockResolvedValue();
		const followUp = vi.spyOn(harness, "followUp").mockResolvedValue();
		holdAgentBusy(orchestrator, agentId);

		const jobId = settleBackgroundedJob(jobs, completedOutcome);
		await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
		expect(prompt).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
		const text = harnessInputText(steer.mock.calls[0]?.[0]);
		expect(text).toContain(jobId);
		expect(text).toContain("build done");
	});

	it("requeues on busy and retries at the next idle boundary", async () => {
		const { orchestrator, agentId, jobs } = await spawnAgent();
		let calls = 0;
		const prompt = vi.spyOn(requireAgentHarness(orchestrator, agentId), "prompt").mockImplementation(async () => {
			calls += 1;
			if (calls === 1) throw new AgentHarnessError("busy", "busy");
			return {} as AssistantMessage;
		});

		settleBackgroundedJob(jobs, completedOutcome);
		await tick();
		// One attempt, then it waits for `settled` rather than retrying inline.
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(pendingMessages(orchestrator, agentId)).toBe(true);

		await driveSettled(orchestrator, agentId);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
		expect(pendingMessages(orchestrator, agentId)).toBe(false);
	});

	it("preserves results and retries when delivery fails with a non-busy error", async () => {
		const { orchestrator, agentId, jobs } = await spawnAgent();
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		let calls = 0;
		const prompt = vi.spyOn(requireAgentHarness(orchestrator, agentId), "prompt").mockImplementation(async () => {
			calls += 1;
			if (calls === 1) throw new Error("session write failed");
			return {} as AssistantMessage;
		});

		settleBackgroundedJob(jobs, completedOutcome);
		// The retry belongs to the sink's binding now, so the warning is the
		// generic one every retrying producer gets, not a job-specific code.
		await vi.waitFor(() =>
			expect(events.filter((event) => event.type === "diagnostic").map((event) => event.diagnostic.code)).toContain(
				"orchestrator.message_delivery_deferred",
			),
		);
		// The result is preserved (not dropped) and a diagnostic is recorded.
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(pendingMessages(orchestrator, agentId)).toBe(true);

		await driveSettled(orchestrator, agentId);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
		expect(pendingMessages(orchestrator, agentId)).toBe(false);
	});

	it("cascades an abort to live jobs and detaches on dispose", async () => {
		const { orchestrator, agentId, jobs } = await spawnAgent();
		const { execution } = startBackgroundedJob(jobs, { toolName: "sleeper" });
		expect(execution.signal.aborted).toBe(false);

		await orchestrator.disposeAgent(agentId, { intent: "removed" });

		expect(execution.signal.aborted).toBe(true);
		// The attachment is dead: its capabilities refuse rather than reach a
		// runtime that no longer knows this agent.
		expect(jobs.list()).toEqual([]);
		expect(jobs.startLocal({ toolCallId: "call-2", toolName: "bash" })).toEqual({
			ok: false,
			reason: "stale_attachment",
		});
		expect(pendingMessages(orchestrator, agentId)).toBe(false);
	});

	// Delivery is the sink's job, so a result the owner can never take comes back
	// as a throw rather than as a routing decision the runtime makes itself.
	it("reports a result the owner can never take", async () => {
		const { orchestrator, agentId, jobs } = await spawnAgent();
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		vi.spyOn(orchestrator, "sendMessage").mockRejectedValue(new Error("owner is unreachable"));

		settleBackgroundedJob(jobs, completedOutcome);

		await vi.waitFor(() =>
			expect(events.filter((event) => event.type === "diagnostic").map((event) => event.diagnostic.code)).toContain(
				"background.result_delivery_failed",
			),
		);
		expect(pendingMessages(orchestrator, agentId)).toBe(false);
	});

	it("emits per-job change events as jobs background and settle", async () => {
		const { orchestrator, agentId, jobs } = await spawnAgent();
		// Keep the agent busy so the settlement stays buffered; we only assert the
		// change events here, not delivery.
		holdAgentBusy(orchestrator, agentId);
		const seen: Array<{ transition: string; jobId: string; state: string; liveCount: number }> = [];
		orchestrator.subscribe((event) => {
			if (event.type === "agent_background_job_changed") {
				seen.push({
					transition: event.transition,
					jobId: event.job.jobId,
					state: event.job.state,
					liveCount: event.liveCount,
				});
			}
		});

		const { execution, job } = startBackgroundedJob(jobs);
		await vi.waitFor(() =>
			expect(seen).toEqual([{ transition: "backgrounded", jobId: job.jobId, state: "backgrounded", liveCount: 1 }]),
		);

		execution.settle(completedOutcome);
		await vi.waitFor(() =>
			expect(seen).toEqual([
				{ transition: "backgrounded", jobId: job.jobId, state: "backgrounded", liveCount: 1 },
				{ transition: "settled", jobId: job.jobId, state: "completed", liveCount: 0 },
			]),
		);
	});

	it("streams output increments and flushes the final one before settling", async () => {
		const { orchestrator, agentId, jobs } = await spawnAgent();
		holdAgentBusy(orchestrator, agentId);
		const log: Array<
			{ kind: "progress"; sequence: number; chunk: string; startByte: number } | { kind: "changed"; transition: string }
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

		const { execution } = startBackgroundedJob(jobs);
		execution.output.append("line1\n");
		// Wait for the first increment to be emitted before appending the next, so
		// the two do not coalesce into one drain.
		await vi.waitFor(() => expect(log.some((e) => e.kind === "progress" && e.chunk === "line1\n")).toBe(true));

		execution.output.append("line2\n");
		execution.settle(completedOutcome);
		await vi.waitFor(() => expect(log.some((e) => e.kind === "changed" && e.transition === "settled")).toBe(true));

		const progresses = log.filter((e) => e.kind === "progress");
		expect(progresses).toEqual([
			{ kind: "progress", sequence: 0, chunk: "line1\n", startByte: 0 },
			{ kind: "progress", sequence: 1, chunk: "line2\n", startByte: 6 },
		]);
		// Barrier: the job's final increment is emitted before its terminal event.
		const lastProgress = log.lastIndexOf(progresses[progresses.length - 1] as (typeof log)[number]);
		const settledIndex = log.findIndex((e) => e.kind === "changed" && e.transition === "settled");
		expect(lastProgress).toBeLessThan(settledIndex);
	});

	it("publishes accumulated output only after the backgrounded lifecycle event", async () => {
		const { orchestrator, agentId, jobs } = await spawnAgent();
		holdAgentBusy(orchestrator, agentId);
		const log: Array<{ kind: "changed" | "progress"; value: string }> = [];
		orchestrator.subscribe((event) => {
			if (event.type === "agent_background_job_changed") {
				log.push({ kind: "changed", value: event.transition });
			}
			if (event.type === "agent_background_job_progress") {
				log.push({ kind: "progress", value: Buffer.from(event.chunk, "base64").toString("utf-8") });
			}
		});

		const started = jobs.startLocal({ toolCallId: "call-1", toolName: "bash" });
		if (!started.ok) throw new Error("Expected a local job.");
		started.execution.output.append("pre-t0\n");
		await tick();
		expect(log).toEqual([]);

		started.execution.acceptBackground();
		await vi.waitFor(() =>
			expect(log).toEqual([
				{ kind: "changed", value: "backgrounded" },
				{ kind: "progress", value: "pre-t0\n" },
			]),
		);
	});

	it("emits an abort_requested change when a live job is aborted", async () => {
		const { orchestrator, agentId, jobs } = await spawnAgent();
		holdAgentBusy(orchestrator, agentId);
		const transitions: string[] = [];
		orchestrator.subscribe((event) => {
			if (event.type === "agent_background_job_changed") transitions.push(event.transition);
		});

		const { execution, job } = startBackgroundedJob(jobs);
		jobs.abort(job.jobId);
		execution.settle({ status: "cancelled" });

		await vi.waitFor(() => expect(transitions).toEqual(["backgrounded", "abort_requested", "settled"]));
	});

	it("exposes live jobs and their output tails through the query API", async () => {
		const { orchestrator, agentId, jobs } = await spawnAgent();
		holdAgentBusy(orchestrator, agentId);
		const started = jobs.startLocal({ toolCallId: "call-1", toolName: "bash" });
		if (!started.ok) throw new Error("Expected a local job.");
		// Candidates are inside the pre-t0 window and are not observable.
		expect(orchestrator.listAgentBackgroundJobs(agentId)).toEqual([]);
		expect(orchestrator.readAgentBackgroundJobOutput(agentId, started.execution.jobId)).toBeUndefined();

		started.execution.acceptBackground();
		started.execution.output.append("progress\n");
		expect(orchestrator.listAgentBackgroundJobs(agentId)).toEqual([
			{
				jobId: started.execution.jobId,
				ownerAgentId: agentId,
				toolCallId: "call-1",
				toolName: "bash",
				name: undefined,
				description: undefined,
				report: undefined,
				state: "backgrounded",
				stopReason: undefined,
				startedAt: expect.any(Number),
				backgroundedAt: expect.any(Number),
				endedAt: undefined,
				totalBytesSeen: 9,
				tailDroppedBytes: 0,
				progressDroppedBytes: 0,
			},
		]);
		expect(orchestrator.readAgentBackgroundJobOutput(agentId, started.execution.jobId)).toBe("progress\n");

		started.execution.settle(completedOutcome);
		expect(orchestrator.listAgentBackgroundJobs(agentId)).toEqual([]);
		expect(orchestrator.readAgentBackgroundJobOutput(agentId, started.execution.jobId)).toBeUndefined();
	});

	it("emits the latest structured report before the settled lifecycle event", async () => {
		const { orchestrator, agentId, jobs } = await spawnAgent();
		holdAgentBusy(orchestrator, agentId);
		const log: Array<
			{ kind: "report"; revision: number; summary: string | undefined } | { kind: "changed"; transition: string }
		> = [];
		orchestrator.subscribe((event) => {
			if (event.type === "agent_background_job_report_updated") {
				log.push({ kind: "report", revision: event.report.revision, summary: event.report.value.summary });
			} else if (event.type === "agent_background_job_changed") {
				log.push({ kind: "changed", transition: event.transition });
			}
		});

		const { execution } = startBackgroundedJob(jobs, { toolName: "planner" });
		execution.setReport({ kind: "test.plan", schemaVersion: 1, summary: "step 1" });
		execution.setReport({ kind: "test.plan", schemaVersion: 1, summary: "step 2" });
		execution.settle(completedOutcome);

		await vi.waitFor(() =>
			expect(log.some((entry) => entry.kind === "changed" && entry.transition === "settled")).toBe(true),
		);
		expect(log).toEqual([
			{ kind: "changed", transition: "backgrounded" },
			{ kind: "report", revision: 2, summary: "step 2" },
			{ kind: "changed", transition: "settled" },
		]);
	});
});

describe("AgentOrchestrator background job extension observability", () => {
	async function spawnWithJobExtension(options: {
		module: ExtensionModule;
		toolRegistry?: ToolRegistry;
	}): Promise<SpawnedAgent> {
		const env = new MemoryExecutionEnv();
		const profile: AgentProfile = { ...defaultProfile, id: "gated", label: "Gated", persist: false };
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: profile.id,
			profileRegistry: new AgentProfileRegistry(InMemoryProfileStorageBackend.fromProfiles([{ profile }])),
			toolRegistry: options.toolRegistry,
		});
		orchestrator.registerExtension("job-tools", options.module);
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const liveAgent = requireLiveAgent(orchestrator, agentId);
		return { orchestrator, agentId, liveAgent, jobs: liveAgent.backgroundAttachment.host };
	}

	it("delivers job change events to extension observers", async () => {
		const seen: Array<{ transition: string; liveCount: number }> = [];
		const { orchestrator, agentId, jobs } = await spawnWithJobExtension({
			module: (api) => {
				api.observe("agent_background_job_changed", (event) => {
					seen.push({ transition: event.transition, liveCount: event.liveCount });
				});
			},
		});
		holdAgentBusy(orchestrator, agentId);

		const { execution } = startBackgroundedJob(jobs);
		// Let the backgrounded change reach the observer before settling: the count
		// it carries is the runtime's at dispatch, and settling first would make
		// both events report the same emptied table.
		await vi.waitFor(() => expect(seen).toEqual([{ transition: "backgrounded", liveCount: 1 }]));
		execution.settle(completedOutcome);

		await vi.waitFor(() =>
			expect(seen).toEqual([
				{ transition: "backgrounded", liveCount: 1 },
				{ transition: "settled", liveCount: 0 },
			]),
		);
	});

	it("delivers byte-exact progress events to extension observers", async () => {
		const seen: Array<{ text: string; startByte: number; endByte: number }> = [];
		const { orchestrator, agentId, jobs } = await spawnWithJobExtension({
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
		holdAgentBusy(orchestrator, agentId);

		const { execution } = startBackgroundedJob(jobs);
		execution.output.append("progress\n");

		await vi.waitFor(() => expect(seen).toEqual([{ text: "progress\n", startByte: 0, endByte: 9 }]));
	});

	it("delivers structured report events to extension observers", async () => {
		const seen: Array<{ revision: number; summary: string | undefined }> = [];
		const { orchestrator, agentId, jobs } = await spawnWithJobExtension({
			module: (api) => {
				api.observe("agent_background_job_report_updated", (event) => {
					seen.push({ revision: event.report.revision, summary: event.report.value.summary });
				});
			},
		});
		holdAgentBusy(orchestrator, agentId);

		const { execution } = startBackgroundedJob(jobs, { toolName: "planner" });
		execution.setReport({ kind: "test.plan", schemaVersion: 1, summary: "Planning" });
		execution.settle(completedOutcome);

		await vi.waitFor(() => expect(seen).toEqual([{ revision: 1, summary: "Planning" }]));
	});

	it("supports gating job tools on live jobs via the job-tools sample extension", async () => {
		const registry = new ToolRegistry();
		registry.defineTool(createToolDefinition("probe"), { kind: "core", id: "test" });
		registerCoreJobTools(registry);
		const { orchestrator, agentId, jobs } = await spawnWithJobExtension({
			module: jobToolsExtension,
			toolRegistry: registry,
		});

		// Initial retraction at spawn: the job tools stay registered but inactive.
		expect(orchestrator.getAgentTools(agentId).toolNames).toContain("read_job");
		await vi.waitFor(() => expect(orchestrator.getAgentTools(agentId).activeToolNames).toEqual(["probe"]));

		// Keep the settlement buffered; delivery is not under test here.
		holdAgentBusy(orchestrator, agentId);
		const { execution } = startBackgroundedJob(jobs);
		await vi.waitFor(() =>
			expect(orchestrator.getAgentTools(agentId).activeToolNames).toEqual([
				"probe",
				"read_job",
				"wait_for_jobs",
				"kill_job",
			]),
		);

		execution.settle(completedOutcome);
		await vi.waitFor(() => expect(orchestrator.getAgentTools(agentId).activeToolNames).toEqual(["probe"]));
	});

	// The job observers report transitions but never carry output, so an
	// extension that reacts to them needs a pull side to be useful at all.
	it("lets an extension list live jobs and pull their output tail", async () => {
		const { orchestrator, agentId, jobs } = await spawnWithJobExtension({ module: () => {} });
		const actions = requireExtensionContext(orchestrator, agentId).actions;
		holdAgentBusy(orchestrator, agentId);
		const started = jobs.startLocal({ toolCallId: "call-1", toolName: "bash", description: "sleep 60" });
		if (!started.ok) throw new Error("Expected a local job.");

		// A candidate is still inside the pre-t0 window: the model never saw its
		// handle, so no external caller may name it.
		expect(actions.listJobs()).toEqual([]);
		expect(actions.readJobOutput(started.execution.jobId)).toBeUndefined();

		started.execution.acceptBackground();
		started.execution.output.append("partial output");

		expect(actions.listJobs()).toEqual([
			expect.objectContaining({
				jobId: started.execution.jobId,
				toolName: "bash",
				description: "sleep 60",
				state: "backgrounded",
			}),
		]);
		expect(actions.readJobOutput(started.execution.jobId)).toBe("partial output");

		started.execution.settle(completedOutcome);

		expect(actions.listJobs()).toEqual([]);
		expect(actions.readJobOutput(started.execution.jobId)).toBeUndefined();
	});

	it("lets an extension kill a live job and reports a stale id as missed", async () => {
		const { orchestrator, agentId, jobs } = await spawnWithJobExtension({ module: () => {} });
		const actions = requireExtensionContext(orchestrator, agentId).actions;
		holdAgentBusy(orchestrator, agentId);
		const transitions: string[] = [];
		orchestrator.subscribe((event) => {
			if (event.type === "agent_background_job_changed") transitions.push(event.transition);
		});
		const { execution, job } = startBackgroundedJob(jobs);

		expect(await actions.killJob(job.jobId, "Budget exhausted")).toBe(true);
		expect(execution.signal.aborted).toBe(true);
		await vi.waitFor(() => expect(transitions).toEqual(["backgrounded", "abort_requested"]));

		// A local job ends only when its tool honors the signal; the extension's
		// request does not settle it on the tool's behalf.
		expect(jobs.list().map((live) => live.jobId)).toEqual([job.jobId]);
		expect(jobs.list()[0]?.stopReason).toBe("Budget exhausted");
		execution.settle({ status: "cancelled" });

		// A listed job may settle before the extension acts on it.
		expect(await actions.killJob(job.jobId)).toBe(false);
	});
});

describe("AgentOrchestrator background job context", () => {
	// A plain (non-backgroundable) tool that reports whether the adapter injected
	// the owner's job capabilities into its execution context.
	const probeTool: ToolDefinition = {
		name: "probe",
		label: "probe",
		description: "reports whether the job host was injected",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, context) => ({
			content: [{ type: "text", text: context.jobs ? "has-jobs" : "no-jobs" }],
			details: undefined,
		}),
	};

	async function probeJobHostState(
		orchestrator: AgentOrchestrator,
		agentId: string,
	): Promise<AgentToolResult<unknown>> {
		const probe = requireAgentHarness(orchestrator, agentId)
			.getTools()
			.find((tool) => tool.name === "probe");
		if (!probe) throw new Error("probe tool not resolved for agent");
		const context = await resolveAgentToolContext(orchestrator, agentId);
		return await probe.execute("call-1", {}, undefined, undefined, context);
	}

	const textOf = (result: AgentToolResult<unknown>): string =>
		result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

	it("always injects the agent's job capabilities", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, { toolRegistry: createToolRegistry(probeTool) });
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		expect(textOf(await probeJobHostState(orchestrator, agentId))).toBe("has-jobs");
	});

	it("provides fresh turn contexts with per-agent job isolation", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, { toolRegistry: createToolRegistry(probeTool) });
		const firstAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		const secondAgentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		const firstContext = await resolveAgentToolContext(orchestrator, firstAgentId);
		const nextFirstContext = await resolveAgentToolContext(orchestrator, firstAgentId);
		const secondContext = await resolveAgentToolContext(orchestrator, secondAgentId);

		expect(nextFirstContext).not.toBe(firstContext);
		expect(firstContext.jobs).toBe(requireAgentJobs(orchestrator, firstAgentId));
		expect(nextFirstContext.jobs).toBe(requireAgentJobs(orchestrator, firstAgentId));
		expect(secondContext.jobs).toBe(requireAgentJobs(orchestrator, secondAgentId));
		expect(secondContext.jobs).not.toBe(firstContext.jobs);
	});
});
