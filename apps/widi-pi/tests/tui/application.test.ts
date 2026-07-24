import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { AgentRecordSnapshot } from "../../src/core/agent-record.ts";
import type {
	WidiRuntime,
	WidiRuntimeServices,
} from "../../src/core/runtime-service.ts";
import type { RuntimeModel } from "../../src/core/types.ts";
import { WidiTuiApplication } from "../../src/tui/application.ts";
import { ensureAgentProjection, setActiveAgent } from "../../src/tui/state.ts";

describe("WidiTuiApplication lazy agent spawn", () => {
	it("does not spawn an agent when the TUI starts", async () => {
		const harness = await createApplicationHarness();
		const runPromise = harness.application.run();
		try {
			await vi.waitFor(() => {
				expect(harness.tuiStart).toHaveBeenCalledTimes(1);
			});
			expect(harness.spawnAgent).not.toHaveBeenCalled();
		} finally {
			await harness.application.shutdown("test cleanup");
			await runPromise;
		}
	});

	it("spawns and prompts on the first plain message", async () => {
		const harness = await createApplicationHarness();

		await submit(harness.application, "hello");

		expect(harness.spawnAgent).toHaveBeenCalledTimes(1);
		expect(harness.promptAgent).toHaveBeenCalledWith("main", "hello", {
			expansion: undefined,
		});
	});

	it("spawns and persists a setting command before the first prompt", async () => {
		const harness = await createApplicationHarness();

		await submit(harness.application, "/model:test/next-model");

		expect(harness.spawnAgent).toHaveBeenCalledTimes(1);
		expect(harness.setAgentModelByReference).toHaveBeenCalledWith(
			"main",
			"test/next-model",
		);
		expect(harness.promptAgent).not.toHaveBeenCalled();
	});

	it("spawns and persists /thinking before the first prompt", async () => {
		const harness = await createApplicationHarness();

		await submit(harness.application, "/thinking:high");

		expect(harness.spawnAgent).toHaveBeenCalledTimes(1);
		expect(harness.setAgentThinkingLevelByName).toHaveBeenCalledWith(
			"main",
			"high",
		);
		expect(harness.promptAgent).not.toHaveBeenCalled();
	});

	it("spawns and persists /rename before the first prompt", async () => {
		const harness = await createApplicationHarness();

		await submit(harness.application, "/rename:planned session");

		expect(harness.spawnAgent).toHaveBeenCalledTimes(1);
		expect(harness.setAgentSessionName).toHaveBeenCalledWith(
			"main",
			"planned session",
		);
		expect(harness.promptAgent).not.toHaveBeenCalled();
	});

	it("keeps /new pending until the next materializing input", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		harness.promptAgent.mockClear();

		await submit(harness.application, "/new");

		expect(harness.newAgentSessionFromAgent).not.toHaveBeenCalled();
		expect(harness.application.state.activeAgentId).toBeUndefined();
		expect(harness.application.state.pendingAgent?.start).toEqual({
			kind: "new-session",
			sourceAgentId: "main",
		});
	});

	it("creates the /new session when its first message is submitted", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		harness.promptAgent.mockClear();

		await submit(harness.application, "/new");
		await submit(harness.application, "second");

		expect(harness.newAgentSessionFromAgent).toHaveBeenCalledOnce();
		expect(harness.newAgentSessionFromAgent).toHaveBeenCalledWith("main");
		expect(harness.promptAgent).toHaveBeenCalledWith("main-2", "second", {
			expansion: undefined,
		});
	});

	it("disposes a fork and returns to its source agent", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		const source = harness.application.state.agents.get("main");
		if (!source) throw new Error("Expected source agent.");
		const fork = ensureAgentProjection(
			harness.application.state,
			"main-fork",
			"idle",
		);
		fork.snapshot = snapshot("main-fork", model());
		fork.display.forkedFromAgentId = "main";
		setActiveAgent(harness.application.state, "main-fork");

		await submit(harness.application, "/dispose");

		expect(harness.disposeAgent).toHaveBeenCalledWith(
			"main-fork",
			expect.any(String),
		);
		expect(harness.application.state.activeAgentId).toBe("main");
	});

	it("skips an unavailable fork source and switches to another usable agent", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		const source = harness.application.state.agents.get("main");
		if (!source?.snapshot) throw new Error("Expected source agent.");
		source.status = "unavailable";
		source.snapshot = {
			...source.snapshot,
			status: "unavailable",
			hasHarness: false,
		};
		const worker = ensureAgentProjection(
			harness.application.state,
			"worker",
			"idle",
		);
		worker.snapshot = snapshot("worker", model());
		const fork = ensureAgentProjection(
			harness.application.state,
			"main-fork",
			"idle",
		);
		fork.snapshot = snapshot("main-fork", model());
		fork.display.forkedFromAgentId = "main";
		setActiveAgent(harness.application.state, "main-fork");

		await submit(harness.application, "/dispose");

		expect(harness.application.state.activeAgentId).toBe("worker");
	});

	it("returns to pending when disposed-agent inspection fails", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		harness.spawnAgent.mockClear();
		harness.inspectAgent.mockImplementationOnce(() => {
			throw new Error("inspect failed");
		});

		await submit(harness.application, "/dispose");

		expect(harness.application.state.agents.get("main")?.status).toBe(
			"disposed",
		);
		expect(harness.application.state.activeAgentId).toBeUndefined();
		expect(harness.application.state.pendingAgent?.start).toEqual({
			kind: "default",
		});
		expect(harness.spawnAgent).not.toHaveBeenCalled();
	});

	it("returns to a fork source matched only by parent session path", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		const source = harness.application.state.agents.get("main");
		if (!source?.snapshot) throw new Error("Expected source agent.");
		source.snapshot = {
			...source.snapshot,
			sessionMetadata: {
				id: "main",
				createdAt: new Date(0).toISOString(),
				cwd: "/workspace",
				path: "/sessions/main.jsonl",
			},
		};
		const fork = ensureAgentProjection(
			harness.application.state,
			"main-fork",
			"idle",
		);
		fork.snapshot = {
			...snapshot("main-fork", model()),
			sessionMetadata: {
				id: "main-fork",
				createdAt: new Date(0).toISOString(),
				cwd: "/workspace",
				path: "/sessions/main-fork.jsonl",
				parentSessionPath: "/sessions/main.jsonl",
			},
		};
		setActiveAgent(harness.application.state, "main-fork");

		await submit(harness.application, "/dispose");

		expect(fork.display.forkedFromAgentId).toBeUndefined();
		expect(harness.application.state.activeAgentId).toBe("main");
	});

	it("returns to pending without spawning after disposing the final agent", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		harness.spawnAgent.mockClear();

		await submit(harness.application, "/dispose");

		expect(harness.application.state.activeAgentId).toBeUndefined();
		expect(harness.application.state.pendingAgent?.start).toEqual({
			kind: "default",
		});
		expect(harness.spawnAgent).not.toHaveBeenCalled();
	});

	it("switches to another live agent after disposing a non-fork agent", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		const worker = ensureAgentProjection(
			harness.application.state,
			"worker",
			"idle",
		);
		worker.snapshot = snapshot("worker", model());
		setActiveAgent(harness.application.state, "main");

		await submit(harness.application, "/dispose");

		expect(harness.application.state.activeAgentId).toBe("worker");
	});

	it("keeps the current agent selected when disposal fails", async () => {
		const harness = await createApplicationHarness();
		await submit(harness.application, "first");
		harness.disposeAgent.mockRejectedValueOnce(new Error("dispose failed"));

		await submit(harness.application, "/dispose");

		expect(harness.application.state.activeAgentId).toBe("main");
		expect(harness.application.state.pendingAgent).toBeUndefined();
		expect(
			harness.application.state.agents
				.get("main")
				?.timeline.find(
					(item) => item.type === "command-result" && item.name === "dispose",
				),
		).toMatchObject({
			type: "command-result",
			status: "failed",
			error: { message: expect.stringContaining("dispose failed") },
		});
	});
});

async function submit(
	application: WidiTuiApplication,
	text: string,
): Promise<void> {
	await (
		application as unknown as {
			submit(text: string): Promise<void>;
		}
	).submit(text);
	await new Promise<void>((resolve) => queueMicrotask(resolve));
}

async function createApplicationHarness() {
	const runtimeModel = model();
	const spawnAgent = vi.fn(async () => "main");
	const newAgentSessionFromAgent = vi.fn(async () => ({
		agentId: "main-2",
		snapshot: snapshot("main-2", runtimeModel),
	}));
	const promptAgent = vi.fn(async () => ({
		kind: "completed" as const,
		message: {
			role: "assistant" as const,
			content: [],
			api: "anthropic-messages" as const,
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
			stopReason: "stop" as const,
			timestamp: Date.now(),
		},
	}));
	const setAgentModelByReference = vi.fn(async () => runtimeModel);
	const setAgentThinkingLevelByName = vi.fn(async () => "high");
	const setAgentSessionName = vi.fn(async () => {});
	const disposedAgentIds = new Set<string>();
	const disposeAgent = vi.fn(async (agentId: string) => {
		disposedAgentIds.add(agentId);
	});
	const inspectAgent = vi.fn((agentId: string) => {
		const inspected = snapshot(agentId, runtimeModel);
		return disposedAgentIds.has(agentId)
			? { ...inspected, status: "disposed" as const, hasHarness: false }
			: inspected;
	});
	const orchestrator = {
		subscribe: () => () => {},
		registerClient: () => () => {},
		disposeAll: async () => {},
		disposeAgent,
		spawnAgent,
		newAgentSessionFromAgent,
		promptAgent,
		setAgentModelByReference,
		setAgentThinkingLevelByName,
		setAgentSessionName,
		getDefaultModel: () => runtimeModel,
		getDefaultThinkingLevel: () => "medium",
		getAgentStatus: () => "idle",
		inspectAgent,
		getAgentSession: async () => ({
			metadata: { id: "main", createdAt: new Date(0).toISOString() },
			leafId: null,
			pathToRoot: [],
		}),
		listExtensionStatuses: () => [],
		listAgents: () => ({ agents: [] }),
	} as unknown as AgentOrchestrator;
	const runtime = {
		orchestrator,
		diagnostics: [],
		services: {
			cwd: "/workspace",
			defaultProfile: {
				id: "main",
				source: "builtin_fallback",
				profileSource: { kind: "builtin" },
			},
			defaultModel: {
				provider: runtimeModel.provider,
				modelId: runtimeModel.id,
				source: "runtime_override",
			},
			defaultThinkingLevel: {
				level: "medium",
				requestedLevel: "medium",
				source: "runtime_override",
				clamped: false,
			},
		} as unknown as WidiRuntimeServices,
	} satisfies WidiRuntime;
	const applicationPromise = WidiTuiApplication.create({
		cwd: "/workspace",
		runtime,
	});
	const application = await applicationPromise;
	const tuiStart = vi
		.spyOn(application.tui, "start")
		.mockImplementation(() => {});
	vi.spyOn(application.tui, "stop").mockImplementation(() => {});
	vi.spyOn(application.tui.terminal, "setTitle").mockImplementation(() => {});
	return {
		application,
		tuiStart,
		spawnAgent,
		newAgentSessionFromAgent,
		promptAgent,
		disposeAgent,
		inspectAgent,
		setAgentModelByReference,
		setAgentThinkingLevelByName,
		setAgentSessionName,
	};
}

function snapshot(agentId: string, runtimeModel: RuntimeModel) {
	return {
		agentId,
		status: "idle",
		profile: { reference: { id: "main", label: "Main Agent" } },
		model: runtimeModel,
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
	} satisfies AgentRecordSnapshot;
}

function model(): RuntimeModel {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: true,
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
