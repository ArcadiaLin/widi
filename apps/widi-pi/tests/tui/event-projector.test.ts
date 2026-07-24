import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentRecordSnapshot } from "../../src/core/agent-record.ts";
import type {
	BackgroundJobReportSnapshot,
	BackgroundJobSnapshot,
} from "../../src/core/background-job.ts";
import type { OrchestratorEvent, RuntimeModel } from "../../src/core/types.ts";
import {
	applyAgentSnapshot,
	EventProjector,
} from "../../src/tui/event-projector.ts";
import { hydrateSessionEntries } from "../../src/tui/session-hydrator.ts";
import {
	createTuiApplicationState,
	setActiveAgent,
} from "../../src/tui/state.ts";

describe("EventProjector", () => {
	it("lazily creates provisional agents before spawn and tracks background facts", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");

		projector.apply({
			type: "agent_status_changed",
			agentId: "worker",
			status: "running",
			changedAt: timestamp(1),
		});
		projector.apply({
			type: "extension_output",
			presentationId: "output-1",
			agentId: "worker",
			extensionId: "search",
			text: "Searching…",
			createdAt: timestamp(2),
		});
		projector.apply({
			type: "extension_status_changed",
			presentationId: "status-1",
			agentId: "worker",
			extensionId: "search",
			key: "progress",
			status: { text: "Searching", progress: { completed: 1, total: 3 } },
			changedAt: timestamp(3),
		});
		projector.apply({
			type: "extension_notification",
			presentationId: "notice-1",
			agentId: "worker",
			extensionId: "search",
			text: "Index warmed",
			createdAt: timestamp(4),
		});

		const worker = state.agents.get("worker");
		expect(worker).toMatchObject({
			status: "running",
			unreadCount: 1,
			attention: "none",
		});
		expect(worker?.timeline).toMatchObject([
			{
				type: "extension-output",
				id: "output-1",
				text: "Searching…",
			},
		]);
		if (!worker) throw new Error("Expected worker projection.");
		expect([...worker.extensionStatuses.values()]).toMatchObject([
			{
				extensionId: "search",
				key: "progress",
				status: { text: "Searching" },
			},
		]);
		expect(state.globalNotices).toMatchObject([
			{
				id: "notice-1",
				kind: "extension-notification",
				agentId: "worker",
			},
		]);
	});

	it("unwraps streaming harness events and consumes pending original input", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		agent.pendingInput = {
			originalText: "show <file:README.md>",
			submittedAt: timestamp(1),
		};

		projector.apply(
			harness("main", {
				type: "message_start",
				message: userMessage("show expanded README"),
			}),
		);
		projector.apply(
			harness("main", {
				type: "message_start",
				message: assistantMessage(""),
			}),
		);
		projector.apply(
			harness("main", {
				type: "message_update",
				message: assistantMessage("Hello"),
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "Hello",
					partial: assistantMessage("Hello"),
				},
			}),
		);
		projector.apply(
			harness("main", {
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "read",
				args: { path: "README.md" },
			}),
		);
		projector.apply(
			harness("main", {
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "read",
				result: { content: [{ type: "text", text: "contents" }] },
				isError: false,
			}),
		);
		projector.apply(
			harness("main", {
				type: "message_end",
				message: assistantMessage("Hello"),
			}),
		);

		expect(agent.timeline).toMatchObject([
			{
				type: "user-message",
				text: "show <file:README.md>",
				modelText: "show expanded README",
			},
			{
				type: "assistant-message",
				text: "Hello",
				streaming: false,
			},
			{
				type: "tool-execution",
				toolCallId: "tool-1",
				status: "completed",
				isError: false,
			},
		]);
		expect(agent.pendingInput).toBeUndefined();
	});

	it("buffers timeline and extension status events until hydration completes", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");
		projector.apply({
			type: "agent_spawned",
			agentId: "main",
			profile: {
				id: "default",
				label: "Default",
				systemPrompt: "test",
				persist: true,
			},
			model: model(),
		});
		projector.apply({
			type: "extension_message_published",
			presentationId: "published-1",
			entryId: "entry-1",
			agentId: "main",
			extensionId: "reports",
			message: { kind: "text", content: "same durable message" },
			createdAt: timestamp(2),
		});
		projector.apply({
			type: "extension_output",
			presentationId: "output-1",
			agentId: "main",
			extensionId: "reports",
			text: "live-only output",
			createdAt: timestamp(3),
		});
		projector.apply({
			type: "extension_status_changed",
			presentationId: "status-new",
			agentId: "main",
			extensionId: "reports",
			key: "run",
			status: { text: "new status" },
			changedAt: timestamp(4),
		});

		const agent = state.agents.get("main");
		if (!agent) throw new Error("Expected main projection.");
		expect(agent.timeline).toEqual([]);
		expect(agent.bufferedEvents).toHaveLength(3);

		const history = hydrateSessionEntries([
			{
				type: "custom",
				id: "entry-1",
				parentId: null,
				timestamp: timestamp(1),
				customType: "core:extension_message",
				data: {
					extensionId: "reports",
					message: { kind: "text", content: "same durable message" },
				},
			},
		]);
		projector.completeHydration("main", history, [
			{
				agentId: "main",
				extensionId: "reports",
				key: "run",
				status: { text: "old snapshot" },
				updatedAt: timestamp(1),
			},
		]);

		expect(agent.hydration).toBe("ready");
		expect(agent.bufferedEvents).toEqual([]);
		expect(agent.timeline.map((item) => item.type)).toEqual([
			"extension-message",
			"extension-output",
		]);
		expect(
			agent.timeline.filter((item) => item.type === "extension-message"),
		).toHaveLength(1);
		expect([...agent.extensionStatuses.values()]).toMatchObject([
			{ status: { text: "new status" } },
		]);
	});

	it("does not discard buffered events when hydration is requested twice", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		projector.beginHydration("main");
		projector.apply({
			type: "extension_output",
			presentationId: "output-1",
			agentId: "main",
			extensionId: "search",
			text: "still buffered",
			createdAt: timestamp(1),
		});

		projector.beginHydration("main");

		expect(state.agents.get("main")?.bufferedEvents).toMatchObject([
			{ type: "extension_output", presentationId: "output-1" },
		]);
	});

	it("records fork lineage on the target projection and retains it on resume", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);

		projector.apply({
			type: "agent_session_forked",
			agentId: "widi-dev",
			forkedSessionId: "019f784f-4342-781c-8472-93e6547da47e",
			createdAt: timestamp(1),
		});
		projector.apply({
			type: "agent_resumed",
			agentId: "019f784f-4342-781c-8472-93e6547da47e",
			profile: {
				id: "widi-dev",
				label: "WIDI Dev",
				systemPrompt: "test",
				persist: true,
			},
			model: model(),
		});

		expect(
			state.agents.get("019f784f-4342-781c-8472-93e6547da47e")?.display
				.forkedFromAgentId,
		).toBe("widi-dev");
	});

	it("retains explicit fork lineage through snapshot application and hydration", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const targetId = "019f784f-4342-781c-8472-93e6547da47e";

		projector.apply({
			type: "agent_session_forked",
			agentId: "widi-dev",
			forkedSessionId: targetId,
			createdAt: timestamp(1),
		});
		applyAgentSnapshot(
			state,
			snapshot(targetId, "/sessions/fork.jsonl", "/sessions/source.jsonl"),
		);

		expect(state.agents.get(targetId)?.display.forkedFromAgentId).toBe(
			"widi-dev",
		);

		projector.beginHydration(targetId);
		projector.completeHydration(
			targetId,
			hydrateSessionEntries([
				{
					type: "session_info",
					id: "session-info",
					parentId: null,
					timestamp: timestamp(2),
					name: "fork work",
				},
			]),
		);

		expect(state.agents.get(targetId)?.display).toMatchObject({
			forkedFromAgentId: "widi-dev",
			sessionName: "fork work",
		});
	});

	it("routes diagnostics and records privacy-safe human request traces", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");

		projector.apply({
			type: "human_request_pending",
			agentId: "worker",
			request: {
				id: "request-1",
				agentId: "worker",
				source: { kind: "human" },
				kind: "select",
				title: "Choose target",
				options: ["safe", "fast"],
				createdAt: timestamp(1),
			},
		});
		projector.apply({
			type: "human_request_resolved",
			agentId: "worker",
			requestId: "request-1",
			response: { kind: "select", value: "safe" },
			completedAt: timestamp(2),
		});
		projector.apply({
			type: "diagnostic",
			diagnostic: {
				id: "diag-1",
				domain: "extension",
				code: "extension.failed",
				severity: "error",
				disposition: "degraded",
				recoverable: true,
				message: "Worker failed",
				agentId: "worker",
			},
			createdAt: timestamp(3),
		});

		const worker = state.agents.get("worker");
		if (!worker) throw new Error("Expected worker projection.");
		expect(worker.attention).toBe("error");
		expect(worker.timeline).toMatchObject([
			{
				type: "human-request-trace",
				answer: { kind: "selected-option", value: "safe" },
			},
			{
				type: "diagnostic",
				id: "diag-1",
			},
		]);
		expect(state.humanRequests).toEqual([]);
		expect(state.mode).toBe("editor");
	});

	it("summarizes a multi-select resolution with option labels", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");

		projector.apply({
			type: "human_request_pending",
			agentId: "worker",
			request: {
				id: "request-multi",
				agentId: "worker",
				source: { kind: "human" },
				kind: "multi-select",
				title: "Pick targets",
				options: [
					{ label: "Safe", value: "safe" },
					{ label: "Fast", value: "fast" },
					{ label: "Cheap", value: "cheap" },
				],
				createdAt: timestamp(1),
			},
		});
		projector.apply({
			type: "human_request_resolved",
			agentId: "worker",
			requestId: "request-multi",
			response: { kind: "multi-select", values: ["safe", "cheap"] },
			completedAt: timestamp(2),
		});

		expect(state.agents.get("worker")?.timeline).toMatchObject([
			{
				type: "human-request-trace",
				options: ["Safe", "Fast", "Cheap"],
				answer: { kind: "selected-options", values: ["Safe", "Cheap"] },
			},
		]);
	});

	it("summarizes a questions batch resolution with per-question labels", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");

		projector.apply({
			type: "human_request_pending",
			agentId: "worker",
			request: {
				id: "request-q",
				agentId: "worker",
				source: { kind: "human" },
				kind: "questions",
				title: "Deploy setup",
				questions: [
					{
						title: "Target",
						options: [
							{ label: "Staging", value: "staging" },
							{ label: "Prod", value: "prod" },
						],
					},
					{ title: "Regions", multiSelect: true, options: ["us", "eu"] },
				],
				createdAt: timestamp(1),
			},
		});
		projector.apply({
			type: "human_request_resolved",
			agentId: "worker",
			requestId: "request-q",
			response: {
				kind: "questions",
				answers: [
					{ kind: "select", value: "staging" },
					{ kind: "multi-select", values: ["us", "eu"] },
				],
			},
			completedAt: timestamp(2),
		});

		expect(state.agents.get("worker")?.timeline).toMatchObject([
			{
				type: "human-request-trace",
				answer: {
					kind: "answered-questions",
					items: [
						{ title: "Target", values: ["Staging"] },
						{ title: "Regions", values: ["us", "eu"] },
					],
				},
			},
		]);
	});

	it("keeps active tool failures inline and gives background ones a transient warning", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const main = setActiveAgent(state, "main");

		projector.apply(
			harness("main", {
				type: "tool_execution_start",
				toolCallId: "tool-main",
				toolName: "ls",
				args: { path: "missing" },
			}),
		);
		projector.apply(
			harness("main", {
				type: "tool_execution_end",
				toolCallId: "tool-main",
				toolName: "ls",
				result: { content: [{ type: "text", text: "Path not found" }] },
				isError: true,
			}),
		);
		expect(main.attention).toBe("none");

		projector.apply(
			harness("worker", {
				type: "tool_execution_end",
				toolCallId: "tool-worker",
				toolName: "ls",
				result: { content: [{ type: "text", text: "Path not found" }] },
				isError: true,
			}),
		);
		expect(state.agents.get("worker")?.attention).toBe("warning");

		setActiveAgent(state, "worker");
		expect(state.agents.get("worker")?.attention).toBe("none");
	});

	it("retains diagnostic-backed attention when the agent is viewed", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");
		projector.apply({
			type: "diagnostic",
			diagnostic: {
				id: "warn-1",
				domain: "extension",
				code: "extension.degraded",
				severity: "warning",
				disposition: "degraded",
				recoverable: true,
				message: "Still degraded",
				agentId: "worker",
			},
			createdAt: timestamp(1),
		});

		setActiveAgent(state, "worker");

		expect(state.agents.get("worker")?.attention).toBe("warning");
	});

	it("joins multiple assistant text blocks with a blank line", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		const message = assistantMessage("first");
		message.content = [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		];

		projector.apply(harness("main", { type: "message_start", message }));
		projector.apply(harness("main", { type: "message_end", message }));

		expect(agent.timeline).toMatchObject([
			{ type: "assistant-message", text: "first\n\nsecond" },
		]);
	});

	it("restores diagnostic attention after a human request is resolved", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		setActiveAgent(state, "main");
		projector.apply({
			type: "diagnostic",
			diagnostic: {
				id: "warning-1",
				domain: "extension",
				code: "extension.warning",
				severity: "warning",
				disposition: "degraded",
				recoverable: true,
				message: "Still degraded",
				agentId: "worker",
			},
			createdAt: timestamp(1),
		});
		projector.apply({
			type: "human_request_pending",
			agentId: "worker",
			request: {
				id: "request-1",
				agentId: "worker",
				source: { kind: "human" },
				kind: "confirm",
				title: "Continue?",
				createdAt: timestamp(2),
			},
		});
		expect(state.agents.get("worker")?.attention).toBe("human-request");

		projector.apply({
			type: "human_request_resolved",
			agentId: "worker",
			requestId: "request-1",
			response: { kind: "confirm", confirmed: true },
			completedAt: timestamp(3),
		});
		expect(state.agents.get("worker")?.attention).toBe("warning");
	});

	it("tracks the live background job count from per-job change events", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);

		projector.apply({
			type: "agent_background_job_changed",
			agentId: "worker",
			job: {
				jobId: "job-1",
				toolCallId: "call-1",
				toolName: "bash",
				phase: "backgrounded",
				startedAt: 1,
				totalBytesSeen: 0,
				droppedBytes: 0,
			},
			transition: "backgrounded",
			liveCount: 3,
			changedAt: timestamp(1),
		});
		expect(projector.ensureAgent("worker").backgroundJobCount).toBe(3);

		projector.apply({
			type: "agent_background_job_changed",
			agentId: "worker",
			job: {
				jobId: "job-1",
				toolCallId: "call-1",
				toolName: "bash",
				phase: "backgrounded",
				status: "completed",
				startedAt: 1,
				endedAt: 2,
				totalBytesSeen: 0,
				droppedBytes: 0,
			},
			transition: "settled",
			liveCount: 0,
			changedAt: timestamp(2),
		});
		expect(projector.ensureAgent("worker").backgroundJobCount).toBe(0);
	});

	it("tracks per-job view state through backgrounded, aborting and settled", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");

		projector.apply({
			type: "agent_background_job_changed",
			agentId: "main",
			job: jobSnapshot("job-1"),
			transition: "backgrounded",
			liveCount: 1,
			changedAt: timestamp(1),
		});
		expect(agent.backgroundJobs.get("job-1")).toMatchObject({
			status: "live",
			toolName: "bash",
			description: "run job-1",
			startedAt: 1_000,
		});

		projector.apply({
			type: "agent_background_job_changed",
			agentId: "main",
			job: jobSnapshot("job-1"),
			transition: "aborting",
			liveCount: 1,
			changedAt: timestamp(2),
		});
		expect(agent.backgroundJobs.get("job-1")?.status).toBe("aborting");

		projector.apply({
			type: "agent_background_job_changed",
			agentId: "main",
			job: jobSnapshot("job-1", {
				status: "failed",
				endedAt: 2_000,
				totalBytesSeen: 42,
			}),
			transition: "settled",
			liveCount: 0,
			changedAt: timestamp(3),
		});
		expect(agent.backgroundJobs.get("job-1")).toMatchObject({
			status: "failed",
			endedAt: 2_000,
			totalBytesSeen: 42,
		});
		expect(agent.backgroundJobCount).toBe(0);
	});

	it("keeps only the latest structured job report revision", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		projector.apply({
			type: "agent_background_job_changed",
			agentId: "main",
			job: jobSnapshot("job-1", { report: jobReport(1, "Starting") }),
			transition: "backgrounded",
			liveCount: 1,
			changedAt: timestamp(1),
		});

		projector.apply({
			type: "agent_background_job_report_updated",
			agentId: "main",
			jobId: "job-1",
			report: jobReport(3, "Newest"),
			changedAt: timestamp(3),
		});
		projector.apply({
			type: "agent_background_job_report_updated",
			agentId: "main",
			jobId: "job-1",
			report: jobReport(2, "Stale"),
			changedAt: timestamp(2),
		});

		expect(agent.backgroundJobs.get("job-1")?.report).toMatchObject({
			revision: 3,
			value: { summary: "Newest" },
		});
	});

	it("retains settled jobs until a new user turn starts", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		for (const jobId of ["job-1", "job-2"]) {
			projector.apply({
				type: "agent_background_job_changed",
				agentId: "main",
				job: jobSnapshot(jobId),
				transition: "backgrounded",
				liveCount: 2,
				changedAt: timestamp(1),
			});
		}
		projector.apply({
			type: "agent_background_job_changed",
			agentId: "main",
			job: jobSnapshot("job-1", { status: "completed", endedAt: 2_000 }),
			transition: "settled",
			liveCount: 1,
			changedAt: timestamp(2),
		});
		expect(agent.backgroundJobs.has("job-1")).toBe(true);

		projector.apply(
			harness("main", { type: "message_start", message: userMessage("next") }),
		);

		expect(agent.backgroundJobs.has("job-1")).toBe(false);
		expect(agent.backgroundJobs.get("job-2")?.status).toBe("live");
	});

	it("decodes progress chunks into the last output line across split UTF-8", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		projector.apply({
			type: "agent_background_job_changed",
			agentId: "main",
			job: jobSnapshot("job-1"),
			transition: "backgrounded",
			liveCount: 1,
			changedAt: timestamp(1),
		});

		// Split the byte stream inside the multi-byte character.
		const full = Buffer.from("booting\nhalf 中\n", "utf-8");
		const splitAt = full.indexOf(Buffer.from("中", "utf-8")) + 1;
		projector.apply(
			progressEvent("main", "job-1", 0, full.subarray(0, splitAt), 0),
		);
		projector.apply(
			progressEvent("main", "job-1", 1, full.subarray(splitAt), splitAt),
		);

		const job = agent.backgroundJobs.get("job-1");
		expect(job?.lastLine).toBe("half 中");
		expect(job?.totalBytesSeen).toBe(full.length);
	});

	it("drops the partial line when progress offsets gap", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		projector.apply({
			type: "agent_background_job_changed",
			agentId: "main",
			job: jobSnapshot("job-1"),
			transition: "backgrounded",
			liveCount: 1,
			changedAt: timestamp(1),
		});

		projector.apply(progressEvent("main", "job-1", 0, Buffer.from("par"), 0));
		// A gap: the next increment starts at byte 20 instead of byte 3.
		projector.apply(
			progressEvent("main", "job-1", 1, Buffer.from("fresh line\n"), 20),
		);

		expect(agent.backgroundJobs.get("job-1")?.lastLine).toBe("fresh line");
	});

	it("seeds live jobs from a pull, retaining settled entries", () => {
		const state = createTuiApplicationState();
		const projector = new EventProjector(state);
		const agent = setActiveAgent(state, "main");
		for (const jobId of ["job-live", "job-stale", "job-old"]) {
			projector.apply({
				type: "agent_background_job_changed",
				agentId: "main",
				job: jobSnapshot(jobId),
				transition: "backgrounded",
				liveCount: 3,
				changedAt: timestamp(1),
			});
		}
		projector.apply({
			type: "agent_background_job_changed",
			agentId: "main",
			job: jobSnapshot("job-old", { status: "completed", endedAt: 2_000 }),
			transition: "settled",
			liveCount: 2,
			changedAt: timestamp(2),
		});

		projector.seedBackgroundJobs("main", [
			jobSnapshot("job-live", { totalBytesSeen: 10 }),
			jobSnapshot("job-new"),
		]);

		expect([...agent.backgroundJobs.keys()].sort()).toEqual([
			"job-live",
			"job-new",
			"job-old",
		]);
		expect(agent.backgroundJobs.get("job-live")).toMatchObject({
			status: "live",
			totalBytesSeen: 10,
		});
		expect(agent.backgroundJobs.get("job-old")?.status).toBe("completed");
		expect(agent.backgroundJobCount).toBe(2);
	});
});

function harness(
	agentId: string,
	event: Extract<OrchestratorEvent, { type: "agent_harness_event" }>["event"],
): Extract<OrchestratorEvent, { type: "agent_harness_event" }> {
	return { type: "agent_harness_event", agentId, event };
}

function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.parse(timestamp(1)) };
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "anthropic-messages",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.parse(timestamp(1)),
	};
}

function model(): RuntimeModel {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function snapshot(
	agentId: string,
	path: string,
	parentSessionPath?: string,
): AgentRecordSnapshot {
	return {
		agentId,
		status: "idle",
		profile: { reference: { id: "widi-dev", label: "WIDI Dev" } },
		sessionMetadata: {
			id: agentId,
			createdAt: new Date(0).toISOString(),
			cwd: "/workspace",
			path,
			parentSessionPath,
		},
		model: model(),
		hasHarness: true,
		extensionIds: [],
		extensions: [],
		extensionSnapshot: {
			extensionIds: [],
			extensions: [],
			hooks: [],
			toolContributions: [],
			providerContributions: [],
			stale: { stale: false },
		},
		resourceDiagnostics: [],
		extensionDiagnostics: [],
		diagnostics: [],
	};
}

function timestamp(offset: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}

function jobSnapshot(
	jobId: string,
	overrides: Partial<BackgroundJobSnapshot> = {},
): BackgroundJobSnapshot {
	return {
		jobId,
		toolCallId: `call-${jobId}`,
		toolName: "bash",
		description: `run ${jobId}`,
		phase: "backgrounded",
		startedAt: 1_000,
		totalBytesSeen: 0,
		droppedBytes: 0,
		...overrides,
	};
}

function progressEvent(
	agentId: string,
	jobId: string,
	sequence: number,
	bytes: Buffer,
	startByte: number,
): Extract<OrchestratorEvent, { type: "agent_background_job_progress" }> {
	return {
		type: "agent_background_job_progress",
		agentId,
		jobId,
		sequence,
		chunk: bytes.toString("base64"),
		startByte,
		endByte: startByte + bytes.length,
		totalBytesSeen: startByte + bytes.length,
		progressDroppedBytes: 0,
		observedAt: timestamp(1),
	};
}

function jobReport(
	revision: number,
	summary: string,
): BackgroundJobReportSnapshot {
	return {
		revision,
		updatedAt: revision * 1_000,
		value: {
			kind: "test.status",
			schemaVersion: 1,
			summary,
		},
	};
}
