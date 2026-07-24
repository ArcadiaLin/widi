import type {
	AgentHarnessEvent,
	JsonlSessionMetadata,
} from "@earendil-works/pi-agent-core";
import { ok } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	AgentOrchestrator,
	buildAgentSystemPrompt,
	formatToolGuidanceForSystemPrompt,
	type OrchestratorEvent,
} from "../../src/core/agent-orchestrator.ts";
import {
	type AgentProfile,
	AgentProfileRegistry,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
import {
	AuthStorage,
	type AuthStorageBackend,
	type LockResult,
} from "../../src/core/auth-storage.ts";
import type { ExtensionContext } from "../../src/core/extension/api.ts";
import {
	ModelRegistry,
	type OAuthProviderConfig,
} from "../../src/core/model-registry.ts";
import { ConfigValueResolver } from "../../src/core/resolve-config-value.ts";
import { ResourceLoader } from "../../src/core/resource-loader.ts";
import {
	EXTENSION_MESSAGE_CUSTOM_TYPE,
	SessionManager,
} from "../../src/core/session-manager.ts";
import {
	SettingManager,
	type SettingsLockResult,
	type SettingsScope,
	type SettingsStorage,
} from "../../src/core/setting-manager.ts";
import {
	type ToolAdapterContext,
	ToolRegistry,
} from "../../src/core/tool-registry.ts";
import { registerCoreInteractionTools } from "../../src/core/tools/interaction/builtin.ts";
import {
	createCoreCodingToolRegistry,
	createEmptyModelRegistry,
	createModelRegistry,
	createOrchestrator,
	createProfileRegistry,
	createToolDefinition,
	createToolRegistry,
	defaultModel,
	defaultProfile,
	MemoryExecutionEnv,
	reasoningModel,
	requireAgentHarness,
	requireAgentRecord,
	restoredModel,
	restoredProfile,
} from "../helpers/orchestrator.ts";

// Drives the private harness-event bridge directly (same private-access
// precedent as requireAgentRecord): a real settled fact requires a full model
// run, which unit tests never perform.
async function emitSettled(
	orchestrator: AgentOrchestrator,
	agentId: string,
	nextTurnCount: number,
): Promise<void> {
	await (
		orchestrator as unknown as {
			_handleAgentHarnessEvent(
				agentId: string,
				event: AgentHarnessEvent,
			): Promise<void>;
		}
	)._handleAgentHarnessEvent(agentId, { type: "settled", nextTurnCount });
}

async function resolveHarnessToolContext(
	harness: ReturnType<typeof requireAgentHarness>,
): Promise<ToolAdapterContext> {
	const source = (
		harness as unknown as {
			toolContext:
				| ToolAdapterContext
				| (() => ToolAdapterContext | Promise<ToolAdapterContext>);
		}
	).toolContext;
	return await (typeof source === "function" ? source() : source);
}

function requireExtensionToolActions(
	context: ToolAdapterContext,
	extensionId: string,
): ExtensionContext["actions"] {
	const extensionContext = context.createExtensionContext?.(
		{ kind: "extension", id: extensionId },
		"probe",
	);
	const host = extensionContext?.host as
		| { actions?: ExtensionContext["actions"] }
		| undefined;
	if (!host?.actions) throw new Error("Expected extension tool actions.");
	return host.actions;
}

function overflowAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "big turn" }],
		api: defaultModel.api,
		provider: defaultModel.provider,
		model: defaultModel.id,
		usage: {
			input: 900,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function expectExtendedMetadata(metadata: {
	id: string;
	createdAt: string;
}): JsonlSessionMetadata {
	if (!("path" in metadata) || typeof metadata.path !== "string") {
		throw new Error("Expected persistent JSONL session metadata.");
	}
	return metadata as JsonlSessionMetadata;
}

function writeSessionFile(
	env: MemoryExecutionEnv,
	path: string,
	options: {
		id: string;
		timestamp: string;
		cwd?: string;
		profileId?: string;
	},
): void {
	const header = {
		type: "session",
		version: 3,
		id: options.id,
		timestamp: options.timestamp,
		cwd: options.cwd ?? "/workspace/project",
		metadata: options.profileId
			? { profile: { id: options.profileId } }
			: undefined,
	};
	env.dirs.add("/sessions");
	env.dirs.add("/sessions/--workspace-project--");
	env.files.set(path, `${JSON.stringify(header)}\n`);
}

class FailingSettingsStorage implements SettingsStorage {
	async withLockAsync<T>(
		scope: SettingsScope,
		_fn: (current: string | undefined) => Promise<SettingsLockResult<T>>,
	): Promise<T> {
		throw new Error(`${scope} settings failed`);
	}
}

class FailingAuthStorageBackend implements AuthStorageBackend {
	async withLockAsync<T>(
		_fn: (current: string | undefined) => Promise<LockResult<T>>,
	): Promise<T> {
		throw new Error("auth storage failed");
	}
}

function createAssistantPartial(
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
			totalTokens: 0,
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

type AgentStatusChangedEvent = Extract<
	OrchestratorEvent,
	{ type: "agent_status_changed" }
>;

function agentStatusChangedEvents(
	events: readonly OrchestratorEvent[],
): AgentStatusChangedEvent[] {
	return events.filter(
		(event): event is AgentStatusChangedEvent =>
			event.type === "agent_status_changed",
	);
}

async function createExtensionActionsHarness(): Promise<{
	env: MemoryExecutionEnv;
	orchestrator: AgentOrchestrator;
	agentId: string;
	actions: ExtensionContext["actions"];
}> {
	const env = new MemoryExecutionEnv();
	const extensionProfile: AgentProfile = {
		...defaultProfile,
		id: "extension-profile",
		label: "Extension Profile",
		persist: false,
		extensions: ["sample"],
	};
	const orchestrator = await createOrchestrator(env, {
		defaultProfileId: extensionProfile.id,
		profileRegistry: new AgentProfileRegistry(
			InMemoryProfileStorageBackend.fromProfiles([
				{ profile: extensionProfile },
			]),
		),
	});
	orchestrator.registerExtension("sample", () => {});
	const agentId = await orchestrator.spawnAgent();
	const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
	if (!runner) throw new Error("Expected extension runner.");
	return {
		env,
		orchestrator,
		agentId,
		actions: runner.createContext("sample").actions,
	};
}

describe("AgentOrchestrator", () => {
	it("emits drained startup diagnostics through the diagnostic event", async () => {
		const env = new MemoryExecutionEnv();
		const configValueResolver = new ConfigValueResolver(env);
		const authStorage = AuthStorage.fromStorage(
			new FailingAuthStorageBackend(),
			{ configValueResolver },
		);
		env.files.set("/workspace/project/models.json", "{ invalid");
		const modelRegistry = await ModelRegistry.create({
			executionEnv: env,
			authStorage,
			configValueResolver,
			modelsJsonPath: "/workspace/project/models.json",
		});
		const settingManager = await SettingManager.fromStorage(
			new FailingSettingsStorage(),
		);
		const orchestrator = new AgentOrchestrator({
			executionEnv: env,
			resourceLoader: new ResourceLoader({
				executionEnv: env,
				cwd: "/workspace/project",
			}),
			sessionManager: new SessionManager({
				fs: env,
				cwd: "/workspace/project",
				sessionsRoot: "/sessions",
			}),
			settingManager,
			modelRegistry,
			profileRegistry: createProfileRegistry(),
			defaultProfileId: defaultProfile.id,
			defaultModel,
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await orchestrator.emitStartupDiagnostics();
		await orchestrator.emitStartupDiagnostics();

		const diagnosticCodes = events
			.filter((event) => event.type === "diagnostic")
			.map((event) => event.diagnostic.code);
		expect(diagnosticCodes).toContain("settings.load_failed");
		expect(diagnosticCodes).toContain("auth.load_failed");
		expect(diagnosticCodes).toContain("model.load_failed");
		expect(
			diagnosticCodes.filter((code) => code === "model.load_failed"),
		).toHaveLength(1);
	});

	it("emits profile registry diagnostics while spawning agents", async () => {
		const env = new MemoryExecutionEnv();
		const profileRegistry = new AgentProfileRegistry(
			new InMemoryProfileStorageBackend([
				{
					entryId: "memory:main",
					filenameId: "filename-main",
					content: "---\nid: main\nlabel: Main Agent\n---\ndefault prompt",
				},
			]),
		);
		const orchestrator = new AgentOrchestrator({
			executionEnv: env,
			resourceLoader: new ResourceLoader({
				executionEnv: env,
				cwd: "/workspace/project",
			}),
			sessionManager: new SessionManager({
				fs: env,
				cwd: "/workspace/project",
				sessionsRoot: "/sessions",
			}),
			settingManager: new SettingManager(),
			modelRegistry: await createModelRegistry(env),
			profileRegistry,
			defaultProfileId: defaultProfile.id,
			defaultModel,
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await orchestrator.spawnAgent();

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "profile.id_filename_mismatch",
					profileId: "main",
				}),
			}),
		);
	});

	it("resumes a persisted agent harness from session metadata", async () => {
		const env = new MemoryExecutionEnv();
		const sessionManager = new SessionManager({
			fs: env,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
		});
		const session = await sessionManager.createAgentSession({
			agentId: "worker-agent",
			agentProfile: restoredProfile,
		});
		await session.appendModelChange(restoredModel.provider, restoredModel.id);
		await session.appendThinkingLevelChange("medium");
		const metadata = expectExtendedMetadata(await session.getMetadata());
		const modelRegistry = await createModelRegistry(env);
		const events: OrchestratorEvent[] = [];

		const orchestrator = new AgentOrchestrator({
			executionEnv: env,
			resourceLoader: new ResourceLoader({
				executionEnv: env,
				cwd: "/workspace/project",
			}),
			sessionManager,
			settingManager: new SettingManager(),
			modelRegistry,
			profileRegistry: createProfileRegistry(),
			defaultProfileId: defaultProfile.id,
			defaultModel,
		});
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		const agentId = await orchestrator.spawnAgent({
			resume: true,
			metadata,
		});

		expect(agentId).toBe("worker-agent");
		expect(requireAgentHarness(orchestrator, agentId).getModel()).toMatchObject(
			{
				provider: restoredModel.provider,
				id: restoredModel.id,
			},
		);
		expect(orchestrator.getAgentThinkingLevel(agentId)).toBe("medium");
		expect(agentStatusChangedEvents(events)).toMatchObject([
			{
				agentId: "worker-agent",
				previousStatus: undefined,
				status: "creating",
			},
			{
				agentId: "worker-agent",
				previousStatus: "creating",
				status: "idle",
			},
		]);
		expect(
			events.findIndex((event) => event.type === "agent_resumed"),
		).toBeGreaterThan(
			events.findIndex(
				(event) =>
					event.type === "agent_status_changed" && event.status === "idle",
			),
		);
		expect(events).toContainEqual({
			type: "agent_resumed",
			agentId: "worker-agent",
			profile: restoredProfile,
			model: expect.objectContaining({ id: restoredModel.id }),
		});
	});

	it("keeps an unavailable record when resume profile resolution fails", async () => {
		const env = new MemoryExecutionEnv();
		const sessionManager = new SessionManager({
			fs: env,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
		});
		const session = await sessionManager.createAgentSession({
			agentId: "worker-agent",
			agentProfile: restoredProfile,
		});
		const metadata = expectExtendedMetadata(await session.getMetadata());
		const orchestrator = new AgentOrchestrator({
			executionEnv: env,
			resourceLoader: new ResourceLoader({
				executionEnv: env,
				cwd: "/workspace/project",
			}),
			sessionManager,
			settingManager: new SettingManager(),
			modelRegistry: await createModelRegistry(env),
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: defaultProfile },
				]),
			),
			defaultProfileId: defaultProfile.id,
			defaultModel,
		});

		await expect(
			orchestrator.spawnAgent({ resume: true, metadata }),
		).rejects.toMatchObject({
			code: "profile.resolution_failed",
		});

		expect(orchestrator.getAgentStatus("worker-agent")).toBe("unavailable");
		expect(orchestrator.inspectAgent("worker-agent").hasHarness).toBe(false);
		expect(orchestrator.inspectAgent("worker-agent")).toMatchObject({
			agentId: "worker-agent",
			status: "unavailable",
			profile: {
				reference: { id: restoredProfile.id, label: restoredProfile.label },
			},
			hasHarness: false,
			diagnostics: [
				expect.objectContaining({ code: "profile.resolution_failed" }),
			],
		});
	});

	it("keeps an unavailable record when resume model restoration fails", async () => {
		const env = new MemoryExecutionEnv();
		const sessionManager = new SessionManager({
			fs: env,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
		});
		const session = await sessionManager.createAgentSession({
			agentId: "worker-agent",
			agentProfile: restoredProfile,
		});
		await session.appendModelChange(restoredModel.provider, restoredModel.id);
		await session.appendThinkingLevelChange("medium");
		const metadata = expectExtendedMetadata(await session.getMetadata());
		const orchestrator = new AgentOrchestrator({
			executionEnv: env,
			resourceLoader: new ResourceLoader({
				executionEnv: env,
				cwd: "/workspace/project",
			}),
			sessionManager,
			settingManager: new SettingManager(),
			modelRegistry: await createEmptyModelRegistry(env),
			profileRegistry: createProfileRegistry(),
			defaultProfileId: defaultProfile.id,
			defaultModel,
		});

		await expect(
			orchestrator.spawnAgent({ resume: true, metadata }),
		).rejects.toThrow("model is not registered");

		expect(orchestrator.inspectAgent("worker-agent")).toMatchObject({
			agentId: "worker-agent",
			status: "unavailable",
			model: expect.objectContaining({ id: defaultModel.id }),
			hasHarness: false,
			diagnostics: [
				expect.objectContaining({ code: "orchestrator.agent_unavailable" }),
			],
		});
	});

	it("fans harness events out through registered clients", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const clientEvents: OrchestratorEvent[] = [];
		orchestrator.registerClient({
			id: "test-output",
			receive: (event) => {
				clientEvents.push(event);
			},
		});
		const agentId = await orchestrator.spawnAgent();

		await emitSettled(orchestrator, agentId, 1);
		expect(clientEvents).toContainEqual(
			expect.objectContaining({
				type: "agent_harness_event",
				agentId,
				event: expect.objectContaining({ type: "settled" }),
			}),
		);
	});

	it("rejects disabled profiles during create", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, {
			enabledProfileIds: ["worker"],
		});

		await expect(orchestrator.spawnAgent()).rejects.toMatchObject({
			code: "profile.disabled",
		});
	});

	it("rejects persistent profile overrides that change recoverable fields", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);

		await expect(
			orchestrator.spawnAgent({
				profileOverride: { systemPrompt: "temporary prompt" },
			}),
		).rejects.toMatchObject({
			code: "profile.override_not_persistable",
		});
	});

	it("dispatches agent query and mutation operations", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, {
			toolRegistry: createToolRegistry(createToolDefinition("echo", "echo")),
		});
		const agentId = await orchestrator.spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);

		expect(orchestrator.getAgentModel(agentId)).toMatchObject({
			id: defaultModel.id,
		});

		expect(orchestrator.getAgentTools(agentId)).toEqual({
			toolNames: ["echo"],
			activeToolNames: ["echo"],
		});

		await orchestrator.setAgentModel(agentId, restoredModel);
		expect(harness.getModel()).toMatchObject({ id: restoredModel.id });

		await orchestrator.setAgentModel(agentId, reasoningModel);
		await orchestrator.setAgentThinkingLevel(agentId, "high");
		expect(orchestrator.getAgentThinkingLevel(agentId)).toBe("high");

		await orchestrator.setAgentActiveTools(agentId, []);
		expect(orchestrator.getAgentActiveTools(agentId)).toEqual([]);
		await orchestrator.setAgentTools(
			agentId,
			["echo", "missing", "echo"],
			["echo", "ghost"],
		);
		expect(orchestrator.getAgentTools(agentId)).toEqual({
			toolNames: ["echo"],
			activeToolNames: ["echo"],
		});
		expect(harness.getTools()).toEqual([
			expect.objectContaining({ name: "echo" }),
		]);
	});

	it("updates active tools without rebuilding harness tool objects", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, {
			toolRegistry: createToolRegistry(
				createToolDefinition("alpha"),
				createToolDefinition("beta"),
			),
		});
		const agentId = await orchestrator.spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);
		const initialTools = harness.getTools();
		const originalSetActiveTools = harness.setActiveTools.bind(harness);
		const originalSetTools = harness.setTools.bind(harness);
		let setActiveToolsCalls = 0;
		let setToolsCalls = 0;
		harness.setActiveTools = async (toolNames) => {
			setActiveToolsCalls += 1;
			await originalSetActiveTools(toolNames);
		};
		harness.setTools = async (tools, activeToolNames) => {
			setToolsCalls += 1;
			await originalSetTools(tools, activeToolNames);
		};

		await orchestrator.setAgentActiveTools(agentId, ["alpha"]);

		expect(setActiveToolsCalls).toBe(1);
		expect(setToolsCalls).toBe(0);
		expect(harness.getTools()[0]).toBe(initialTools[0]);
		expect(harness.getTools()[1]).toBe(initialTools[1]);
		expect(harness.getActiveTools().map((tool) => tool.name)).toEqual([
			"alpha",
		]);

		await orchestrator.setAgentTools(agentId, ["alpha", "beta"], ["beta"]);

		expect(setActiveToolsCalls).toBe(1);
		expect(setToolsCalls).toBe(1);
		expect(harness.getTools()[0]).not.toBe(initialTools[0]);
		expect(harness.getActiveTools().map((tool) => tool.name)).toEqual(["beta"]);
	});

	it("rejects agent thinking level changes unsupported by the current model", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();

		await expect(
			orchestrator.setAgentThinkingLevel(agentId, "medium"),
		).rejects.toMatchObject({
			code: "model.thinking_not_supported",
			diagnostic: expect.objectContaining({
				provider: defaultModel.provider,
				modelId: defaultModel.id,
			}),
		});
		expect(orchestrator.getAgentThinkingLevel(agentId)).toBe("off");

		await orchestrator.setAgentModel(agentId, reasoningModel);
		await expect(
			orchestrator.setAgentThinkingLevel(agentId, "minimal"),
		).rejects.toMatchObject({
			code: "model.thinking_level_not_supported",
			diagnostic: expect.objectContaining({
				provider: reasoningModel.provider,
				modelId: reasoningModel.id,
				details: {
					level: "minimal",
					supportedLevels: ["off", "low", "medium", "high"],
				},
			}),
		});
		expect(orchestrator.getAgentThinkingLevel(agentId)).toBe("off");
	});

	it("sets model and thinking settings through atomic methods", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);

		await expect(
			orchestrator.setAgentThinkingLevelByName(agentId, "high"),
		).rejects.toMatchObject({
			diagnostic: expect.objectContaining({
				code: "model.thinking_not_supported",
				modelId: defaultModel.id,
			}),
		});

		await expect(orchestrator.listAvailableModelCandidates()).resolves.toEqual({
			models: expect.arrayContaining([
				{
					value: `${restoredModel.provider}/${restoredModel.id}`,
					label: restoredModel.name,
					description: `${restoredModel.provider}/${restoredModel.id}`,
				},
				{
					value: `${reasoningModel.provider}/${reasoningModel.id}`,
					label: reasoningModel.name,
					description: `${reasoningModel.provider}/${reasoningModel.id}`,
				},
			]),
		});

		await expect(
			orchestrator.setAgentModelByReference(
				agentId,
				`${reasoningModel.provider}/${reasoningModel.id}`,
			),
		).resolves.toMatchObject({
			id: reasoningModel.id,
			provider: reasoningModel.provider,
		});
		expect(harness.getModel()).toMatchObject({ id: reasoningModel.id });

		expect(orchestrator.listAgentThinkingLevelCandidates(agentId)).toEqual({
			levels: [
				{ value: "off", label: "off" },
				{ value: "low", label: "low" },
				{ value: "medium", label: "medium" },
				{ value: "high", label: "high" },
			],
		});

		await expect(
			orchestrator.setAgentThinkingLevelByName(agentId, "high"),
		).resolves.toEqual({
			level: "high",
		});
		expect(orchestrator.getAgentThinkingLevel(agentId)).toBe("high");
	});

	it("exposes lightweight agent record status and inspect snapshots", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, {
			toolRegistry: createToolRegistry(createToolDefinition("echo", "echo")),
		});
		const events: OrchestratorEvent[] = [];
		const statusesVisibleDuringPublish: string[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
			const [statusEvent] = agentStatusChangedEvents([event]);
			if (statusEvent) {
				statusesVisibleDuringPublish.push(
					orchestrator.getAgentStatus(statusEvent.agentId),
				);
			}
		});
		const agentId = await orchestrator.spawnAgent();
		const creationStatusEvents = agentStatusChangedEvents(events);

		expect(creationStatusEvents).toEqual([
			{
				type: "agent_status_changed",
				agentId,
				previousStatus: undefined,
				status: "creating",
				changedAt: expect.any(String),
			},
			{
				type: "agent_status_changed",
				agentId,
				previousStatus: "creating",
				status: "idle",
				changedAt: expect.any(String),
			},
		]);
		expect(statusesVisibleDuringPublish).toEqual(["creating", "idle"]);
		expect(
			events.findIndex((event) => event.type === "agent_spawned"),
		).toBeGreaterThan(
			events.findIndex(
				(event) =>
					event.type === "agent_status_changed" && event.status === "idle",
			),
		);

		expect(orchestrator.getAgentStatus(agentId)).toBe("idle");
		expect(orchestrator.inspectAgent(agentId).hasHarness).toBe(true);
		expect(orchestrator.inspectAgent(agentId)).toMatchObject({
			agentId,
			status: "idle",
			profile: {
				reference: { id: defaultProfile.id, label: defaultProfile.label },
				entryId: "memory:main",
			},
			hasHarness: true,
			toolSnapshot: {
				toolNames: ["echo"],
				activeToolNames: ["echo"],
			},
			resourceDiagnostics: [],
			extensionDiagnostics: [],
			diagnostics: [],
		});

		expect(orchestrator.getAgentStatus(agentId)).toBe("idle");

		expect(orchestrator.inspectAgent(agentId)).toMatchObject({
			agentId,
			status: "idle",
			hasHarness: true,
		});

		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);
		const runtimeEvents: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			runtimeEvents.push(event);
		});

		await handleHarnessEvent(agentId, { type: "turn_start" });
		await handleHarnessEvent(agentId, { type: "turn_start" });
		expect(orchestrator.getAgentStatus(agentId)).toBe("running");

		await handleHarnessEvent(agentId, {
			type: "turn_end",
			message: createAssistantPartial([{ type: "text", text: "done" }]),
			toolResults: [],
		});
		await handleHarnessEvent(agentId, {
			type: "turn_end",
			message: createAssistantPartial([{ type: "text", text: "done again" }]),
			toolResults: [],
		});
		expect(orchestrator.getAgentStatus(agentId)).toBe("idle");
		expect(agentStatusChangedEvents(runtimeEvents)).toMatchObject([
			{ agentId, previousStatus: "idle", status: "running" },
			{ agentId, previousStatus: "running", status: "idle" },
		]);
	});

	it("dispatches steer and follow-up through atomic methods", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		(harness as unknown as { phase: "turn" }).phase = "turn";
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);
		await handleHarnessEvent(agentId, { type: "turn_start" });

		await orchestrator.steerAgent(agentId, "keep going");
		await orchestrator.followUpAgent(agentId, "summarize next");
		expect(orchestrator.getAgentStatus(agentId)).toBe("running");

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "agent_harness_event",
				event: expect.objectContaining({
					type: "queue_update",
					steer: [
						expect.objectContaining({
							role: "user",
							content: [{ type: "text", text: "keep going" }],
						}),
					],
				}),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "agent_harness_event",
				event: expect.objectContaining({
					type: "queue_update",
					followUp: [
						expect.objectContaining({
							role: "user",
							content: [{ type: "text", text: "summarize next" }],
						}),
					],
				}),
			}),
		);
	});

	it("lists loaded skills in the harness system prompt when the resolved read tool is active", async () => {
		const env = new MemoryExecutionEnv();
		await env.writeFile(
			"/workspace/project/.widi/skills/code-review/SKILL.md",
			[
				"---",
				"name: code-review",
				"description: Review code for issues.",
				"---",
				"SECRET BODY INSTRUCTIONS",
			].join("\n"),
		);
		env.dirs.add("/workspace/project/.widi/skills");
		const orchestrator = await createOrchestrator(env, {
			toolRegistry: createCoreCodingToolRegistry(),
		});
		const agentId = await orchestrator.spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);

		const systemPrompt = (
			harness as unknown as {
				systemPrompt: (context: {
					resources: unknown;
					activeTools: { name: string }[];
				}) => string | Promise<string>;
			}
		).systemPrompt;
		expect(typeof systemPrompt).toBe("function");
		expect(orchestrator.getAgentTools(agentId).activeToolNames).toContain(
			"read",
		);

		const withRead = await systemPrompt({
			resources: harness.getResources(),
			activeTools: harness.getActiveTools(),
		});
		expect(withRead.startsWith("default prompt")).toBe(true);
		expect(withRead).toContain("<available_skills>");
		expect(withRead).toContain("<name>code-review</name>");
		expect(withRead).toContain(
			"<location>/workspace/project/.widi/skills/code-review/SKILL.md</location>",
		);
		// The skill body stays in the file; the listing is metadata-only.
		expect(withRead).not.toContain("SECRET BODY INSTRUCTIONS");

		await orchestrator.setAgentActiveTools(agentId, ["write"]);
		const withoutRead = await systemPrompt({
			resources: harness.getResources(),
			activeTools: harness.getActiveTools(),
		});
		expect(withoutRead).not.toContain("<available_skills>");
		expect(withoutRead).toContain(
			"Available tools:\n- write: Create or overwrite files",
		);
	});

	it("composes tool guidance from active tool snippets and guidelines", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, {
			toolRegistry: createCoreCodingToolRegistry(),
		});
		const agentId = await orchestrator.spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);
		const systemPrompt = (
			harness as unknown as {
				systemPrompt: (context: {
					resources: unknown;
					activeTools: { name: string }[];
				}) => string | Promise<string>;
			}
		).systemPrompt;

		const prompt = await systemPrompt({
			resources: harness.getResources(),
			activeTools: harness.getActiveTools(),
		});

		expect(prompt.startsWith("default prompt")).toBe(true);
		// Snippets keep the fixed registration order.
		const snippetOrder = ["read", "bash", "edit", "write", "grep", "find", "ls"]
			.map((name) => prompt.indexOf(`\n- ${name}: `))
			.filter((index) => index >= 0);
		expect(snippetOrder).toHaveLength(7);
		expect([...snippetOrder].sort((a, b) => a - b)).toEqual(snippetOrder);
		// The slice 4 guidance themes are present.
		expect(prompt).toContain(
			"Use read instead of bash cat or sed to inspect files.",
		);
		expect(prompt).toContain(
			"Use grep for content searches; use find for file path searches.",
		);
		expect(prompt).toContain(
			"Use ls to browse a single directory level; use find for recursive path searches.",
		);
		expect(prompt).toContain(
			"Use write only for new files or complete rewrites; use edit for partial changes.",
		);
		expect(prompt).toContain(
			"Use bash for building, testing, version control, and commands not covered by a dedicated tool.",
		);
	});

	it("deduplicates guidance and omits the section without contributions", () => {
		expect(
			formatToolGuidanceForSystemPrompt([
				{ name: "a", promptSnippet: "First", promptGuidelines: ["Shared."] },
				{ name: "b", promptGuidelines: ["Shared.", "  ", "Extra."] },
				{ name: "c" },
			]),
		).toBe(
			"Available tools:\n- a: First\n\nTool guidelines:\n- Shared.\n- Extra.",
		);
		expect(formatToolGuidanceForSystemPrompt([{ name: "plain" }])).toBe("");
		expect(buildAgentSystemPrompt("base prompt", {}, [{ name: "plain" }])).toBe(
			"base prompt",
		);
	});

	it("keeps the base system prompt when skills are absent or model-hidden", () => {
		const skill = {
			name: "code-review",
			description: "Review code for issues.",
			content: "BODY",
			filePath: "/skills/code-review/SKILL.md",
		};
		expect(buildAgentSystemPrompt("base prompt", {}, [{ name: "read" }])).toBe(
			"base prompt",
		);
		expect(
			buildAgentSystemPrompt(
				"base prompt",
				{ skills: [{ ...skill, disableModelInvocation: true }] },
				[{ name: "read" }],
			),
		).toBe("base prompt");
		expect(
			buildAgentSystemPrompt("base prompt", { skills: [skill] }, [
				{ name: "read" },
			]),
		).toContain("<available_skills>");
	});

	it("promptAgent persists an expansion entry alongside the prompt", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);
		const prompted: string[] = [];
		Object.assign(harness, {
			prompt: async (text: string) => {
				prompted.push(text);
				return { role: "assistant" } as AssistantMessage;
			},
		});

		const outcome = await orchestrator.promptAgent(agentId, "expanded text", {
			expansion: {
				originalText: "use <skill:review>",
				items: [
					{
						commandId: "command-1",
						name: "skill",
						trigger: "<",
						argument: "review",
						start: 4,
						end: 18,
					},
				],
			},
		});
		expect(outcome.kind).toBe("completed");
		expect(prompted).toEqual(["expanded text"]);
		const entries = (
			await orchestrator.getAgentSessionTree(agentId)
		).entries.filter(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "core:command_expansion",
		);
		expect(entries).toMatchObject([
			{
				data: {
					inputId: expect.any(String),
					originalText: "use <skill:review>",
					expansions: [
						expect.objectContaining({ commandId: "command-1", name: "skill" }),
					],
				},
			},
		]);
	});

	it("promptAgent blocks input when an extension interceptor blocks", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "prompt-policy-profile",
			persist: false,
			extensions: ["policy"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("policy", (api) => {
			api.intercept("input", (event) =>
				event.text.includes("secret")
					? { block: true, reason: "Sensitive input." }
					: undefined,
			);
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const agentId = await orchestrator.spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);
		const prompted: string[] = [];
		Object.assign(harness, {
			prompt: async (text: string) => {
				prompted.push(text);
				return { role: "assistant" } as AssistantMessage;
			},
		});

		await expect(
			orchestrator.promptAgent(agentId, "share the secret"),
		).resolves.toEqual({
			kind: "blocked",
			inputId: expect.any(String),
			reason: "Sensitive input.",
			blockedBy: "policy",
		});
		expect(prompted).toEqual([]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "input_blocked",
				agentId,
				originalText: "share the secret",
				reason: "Sensitive input.",
				blockedBy: "policy",
			}),
		);
	});

	it("promptAgent applies extension transforms and persists the transform entry", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "prompt-rewriter-profile",
			persist: false,
			extensions: ["rewriter"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("rewriter", (api) => {
			api.intercept("input", (event) => {
				if (event.text.includes("secret")) {
					return { block: true, reason: "Sensitive input." };
				}
				return { text: `${event.text}!` };
			});
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const agentId = await orchestrator.spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);
		const prompted: string[] = [];
		Object.assign(harness, {
			prompt: async (text: string) => {
				prompted.push(text);
				return { role: "assistant" } as AssistantMessage;
			},
		});

		await expect(
			orchestrator.promptAgent(agentId, "hello"),
		).resolves.toMatchObject({ kind: "completed" });
		expect(prompted).toEqual(["hello!"]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "input_transformed",
				agentId,
				inputId: expect.any(String),
				originalText: "hello",
				text: "hello!",
				transformedBy: ["rewriter"],
			}),
		);
		const findTransformEntries = async () =>
			(await orchestrator.getAgentSessionTree(agentId)).entries.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "core:input_transform",
			);
		await expect(findTransformEntries()).resolves.toMatchObject([
			{
				data: {
					inputId: expect.any(String),
					originalText: "hello",
					text: "hello!",
					transformedBy: ["rewriter"],
				},
			},
		]);

		// Blocked input never reaches the session: no entry is written.
		await expect(
			orchestrator.promptAgent(agentId, "share the secret"),
		).resolves.toMatchObject({ kind: "blocked" });
		await expect(findTransformEntries()).resolves.toHaveLength(1);
	});

	it("promptAgent retracts provisional entries when the prompt fails before its user message", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);
		Object.assign(harness, {
			prompt: async () => {
				throw new Error("before_agent_start hook exploded");
			},
		});
		const expansion = {
			originalText: "use <skill:review>",
			items: [
				{
					commandId: "command-1",
					name: "skill",
					trigger: "<",
					argument: "review",
					start: 4,
					end: 18,
				},
			],
		};

		await expect(
			orchestrator.promptAgent(agentId, "expanded text", { expansion }),
		).rejects.toThrow("before_agent_start hook exploded");

		// The failed prompt never persisted a user message; a leftover entry
		// on the active branch would pair with the next user message during
		// hydration and show the wrong original text.
		const branchCustomEntries = async () =>
			(await orchestrator.getAgentSession(agentId)).pathToRoot.filter(
				(entry) => entry.type === "custom",
			);
		await expect(branchCustomEntries()).resolves.toEqual([]);

		// The branch stays usable: a later successful prompt persists its own
		// expansion entry as the only one on the branch.
		Object.assign(harness, {
			prompt: async () => ({ role: "assistant" }) as AssistantMessage,
		});
		await expect(
			orchestrator.promptAgent(agentId, "expanded again", {
				expansion: { ...expansion, originalText: "use <skill:audit>" },
			}),
		).resolves.toMatchObject({ kind: "completed" });
		await expect(branchCustomEntries()).resolves.toMatchObject([
			{ data: { originalText: "use <skill:audit>" } },
		]);
	});

	it("promptAgent keeps provisional entries when the user message landed before the failure", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "prompt-run-failure-profile",
			persist: false,
			extensions: ["rewriter"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("rewriter", (api) => {
			api.intercept("input", (event) => ({ text: `${event.text}!` }));
		});
		const agentId = await orchestrator.spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);
		Object.assign(harness, {
			prompt: async (text: string) => {
				// A run that persisted its user message and then failed at the
				// provider: the transform entry has its pairing message and must
				// survive the failure.
				await harness.appendMessage({
					role: "user",
					content: [{ type: "text", text }],
					timestamp: Date.now(),
				});
				throw new Error("provider exploded");
			},
		});

		await expect(orchestrator.promptAgent(agentId, "hello")).rejects.toThrow(
			"provider exploded",
		);

		const branch = (await orchestrator.getAgentSession(agentId)).pathToRoot;
		const transformIndex = branch.findIndex(
			(entry) =>
				entry.type === "custom" && entry.customType === "core:input_transform",
		);
		const userMessageIndex = branch.findIndex(
			(entry) => entry.type === "message" && entry.message.role === "user",
		);
		expect(transformIndex).toBeGreaterThanOrEqual(0);
		expect(userMessageIndex).toBeGreaterThan(transformIndex);
	});

	it("promptAgent rejects a busy agent before interception and session writes", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "prompt-busy-profile",
			persist: false,
			extensions: ["rewriter"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		let interceptorCalls = 0;
		orchestrator.registerExtension("rewriter", (api) => {
			api.intercept("input", (event) => {
				interceptorCalls += 1;
				return { text: `${event.text}!` };
			});
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const agentId = await orchestrator.spawnAgent();
		requireAgentRecord(orchestrator, agentId).status = "running";

		await expect(
			orchestrator.promptAgent(agentId, "hello", {
				expansion: { originalText: "hello", items: [] },
			}),
		).rejects.toMatchObject({ code: "orchestrator.agent_busy" });

		expect(interceptorCalls).toBe(0);
		expect(
			events.filter((event) => event.type === "input_transformed"),
		).toEqual([]);
		const branch = (await orchestrator.getAgentSession(agentId)).pathToRoot;
		expect(branch.filter((entry) => entry.type === "custom")).toEqual([]);
	});

	it("rejects input fail-closed when an input interceptor throws", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "broken-input-profile",
			persist: false,
			extensions: ["broken", "healthy"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		let healthyCalled = false;
		orchestrator.registerExtension("broken", (api) => {
			api.intercept("input", () => {
				throw new Error("input policy exploded");
			});
		});
		orchestrator.registerExtension("healthy", (api) => {
			api.intercept("input", () => {
				healthyCalled = true;
				return undefined;
			});
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const agentId = await orchestrator.spawnAgent();

		await expect(
			orchestrator.promptAgent(agentId, "hello"),
		).resolves.toMatchObject({ kind: "blocked", blockedBy: "broken" });
		expect(healthyCalled).toBe(false);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.handler_failed",
					extensionId: "broken",
					details: { eventName: "input" },
				}),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "input_blocked",
				agentId,
				originalText: "hello",
				blockedBy: "broken",
			}),
		);
	});

	it("starts a new empty session from the current agent", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();

		const result = await orchestrator.newAgentSessionFromAgent(agentId);

		expect(result).toMatchObject({
			agentId: "main-agent-2",
			snapshot: {
				agentId: "main-agent-2",
				status: "idle",
				hasHarness: true,
				profile: {
					reference: {
						id: defaultProfile.id,
						label: defaultProfile.label,
					},
				},
				model: expect.objectContaining({ id: defaultModel.id }),
			},
		});
		expect(orchestrator.getAgentStatus(agentId)).toBe("idle");
	});

	it("lists and resumes sessions through atomic methods", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();
		const session = await orchestrator.sessionManager.createAgentSession({
			agentId: "worker-agent",
			agentProfile: restoredProfile,
		});
		await session.appendModelChange(restoredModel.provider, restoredModel.id);
		await session.appendThinkingLevelChange("medium");
		const metadata = expectExtendedMetadata(await session.getMetadata());

		await expect(orchestrator.listAgentSessions()).resolves.toMatchObject({
			sessions: expect.arrayContaining([
				expect.objectContaining({
					id: "worker-agent",
					path: metadata.path,
					profile: { id: restoredProfile.id, label: restoredProfile.label },
				}),
				expect.objectContaining({ id: agentId }),
			]),
		});
		const result = await orchestrator.resumeAgentSessionByReference(
			metadata.path,
		);

		expect(result).toMatchObject({
			agentId: "worker-agent",
			snapshot: {
				agentId: "worker-agent",
				status: "idle",
				model: expect.objectContaining({ id: restoredModel.id }),
			},
		});
	});

	it("does not implicitly resume ambiguous session ids", async () => {
		const env = new MemoryExecutionEnv();
		writeSessionFile(
			env,
			"/sessions/--workspace-project--/2026-01-02T00-00-00-000Z_same.jsonl",
			{
				id: "same",
				timestamp: "2026-01-02T00:00:00.000Z",
				profileId: defaultProfile.id,
			},
		);
		writeSessionFile(
			env,
			"/sessions/--workspace-project--/2026-01-01T00-00-00-000Z_same.jsonl",
			{
				id: "same",
				timestamp: "2026-01-01T00:00:00.000Z",
				profileId: defaultProfile.id,
			},
		);
		const orchestrator = await createOrchestrator(env);

		await expect(
			orchestrator.resumeAgentSessionByReference("same"),
		).rejects.toThrow("Ambiguous agent session reference: same");
	});

	it("lists runtime agents and persisted sessions through atomic methods", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();

		expect(orchestrator.listAgents()).toMatchObject({
			agents: [
				expect.objectContaining({
					agentId,
					status: "idle",
					hasHarness: true,
				}),
			],
		});
		await expect(orchestrator.listAgentSessions()).resolves.toMatchObject({
			sessions: [
				expect.objectContaining({
					id: agentId,
					profile: { id: defaultProfile.id, label: defaultProfile.label },
				}),
			],
		});
	});

	it("names and inspects the current session tree through atomic methods", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();
		const session = await orchestrator.sessionManager.createAgentSession({
			agentId,
			agentProfile: defaultProfile,
		});
		const userEntryId = await session.appendMessage({
			role: "user",
			content: "revise this",
			timestamp: 1,
		});

		await expect(
			orchestrator.setAgentSessionName(agentId, "Planning Session"),
		).resolves.toMatchObject({
			name: "Planning Session",
		});
		await expect(
			orchestrator.getAgentSessionTree(agentId),
		).resolves.toMatchObject({
			name: "Planning Session",
			entries: [
				expect.objectContaining({ id: userEntryId, type: "message" }),
				expect.objectContaining({
					type: "session_info",
					name: "Planning Session",
				}),
			],
			pathToRoot: [
				expect.objectContaining({ id: userEntryId }),
				expect.objectContaining({ type: "session_info" }),
			],
		});
	});

	it("navigates the session tree through the atomic method", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();
		const session = await orchestrator.sessionManager.createAgentSession({
			agentId,
			agentProfile: defaultProfile,
		});
		const userEntryId = await session.appendMessage({
			role: "user",
			content: "edit this",
			timestamp: 1,
		});
		await session.appendMessage({
			role: "user",
			content: "current leaf",
			timestamp: 2,
		});

		await expect(
			orchestrator.navigateAgentTree(agentId, userEntryId),
		).resolves.toMatchObject({
			cancelled: false,
			editorText: "edit this",
		});
		await expect(orchestrator.getAgentSession(agentId)).resolves.toMatchObject({
			leafId: null,
			pathToRoot: [],
		});
	});

	it("forks the current session into an idle runtime agent", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();
		const session = await orchestrator.sessionManager.createAgentSession({
			agentId,
			agentProfile: defaultProfile,
		});
		const keptEntryId = await session.appendMessage({
			role: "user",
			content: "keep me",
			timestamp: 1,
		});
		const targetEntryId = await session.appendMessage({
			role: "user",
			content: "fork before me",
			timestamp: 2,
		});

		const result = await orchestrator.forkAgentSessionFromAgent(agentId, {
			entryId: targetEntryId,
		});

		expect(result).toMatchObject({
			agentId: expect.not.stringMatching(`^${agentId}$`),
			snapshot: {
				status: "idle",
				hasHarness: true,
				model: expect.objectContaining({ id: defaultModel.id }),
			},
		});
		const forkedAgentId = result.agentId;
		const forkedTree = await orchestrator.getAgentSessionTree(forkedAgentId);
		expect(forkedTree).toMatchObject({
			metadata: {
				id: forkedAgentId,
				parentSessionPath: expect.any(String),
			},
			entries: [expect.objectContaining({ id: keptEntryId })],
			leafId: keptEntryId,
		});
		expect(forkedTree.entries.some((entry) => entry.id === targetEntryId)).toBe(
			false,
		);
		expect(orchestrator.getAgentStatus(agentId)).toBe("idle");
	});

	it("auto-compacts on settled when the context threshold is exceeded", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();
		const session = await orchestrator.sessionManager.createAgentSession({
			agentId,
			agentProfile: defaultProfile,
		});
		await session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		// defaultModel.contextWindow is 1000 and the default reserve is 16384,
		// so any positive usage is over threshold.
		await session.appendMessage(overflowAssistantMessage());
		const compacted: string[] = [];
		Object.assign(orchestrator, {
			compactAgent: async (targetAgentId: string) => {
				compacted.push(targetAgentId);
				return { summary: "s", firstKeptEntryId: "e", tokensBefore: 1000 };
			},
		});

		// A settled fact with queued next turns defers to the next settled.
		await emitSettled(orchestrator, agentId, 1);
		expect(compacted).toEqual([]);

		await emitSettled(orchestrator, agentId, 0);
		expect(compacted).toEqual([agentId]);
	});

	it("skips auto-compaction when disabled or without assistant usage", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();
		const session = await orchestrator.sessionManager.createAgentSession({
			agentId,
			agentProfile: defaultProfile,
		});
		const compacted: string[] = [];
		Object.assign(orchestrator, {
			compactAgent: async (targetAgentId: string) => {
				compacted.push(targetAgentId);
				return { summary: "s", firstKeptEntryId: "e", tokensBefore: 1000 };
			},
		});

		// No assistant usage on the branch yet: nothing to measure.
		await emitSettled(orchestrator, agentId, 0);
		expect(compacted).toEqual([]);

		await session.appendMessage(overflowAssistantMessage());
		orchestrator.settingManager.setCompactionEnabled(false);
		await emitSettled(orchestrator, agentId, 0);
		expect(compacted).toEqual([]);
	});

	it("reports failed auto-compaction as a warning diagnostic", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();
		const session = await orchestrator.sessionManager.createAgentSession({
			agentId,
			agentProfile: defaultProfile,
		});
		await session.appendMessage(overflowAssistantMessage());
		Object.assign(orchestrator, {
			compactAgent: async () => {
				throw new Error("summary model unavailable");
			},
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await emitSettled(orchestrator, agentId, 0);

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					severity: "warning",
					code: "compaction.auto_failed",
					agentId,
					message: expect.stringContaining("summary model unavailable"),
				}),
			}),
		);
	});

	it("disposes agents best-effort and leaves an inspectable stale record", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["stateful"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("stateful", () => {});
		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const context = runner.createContext("stateful");
		await context.actions.setStatus("sync", {
			text: "Synchronizing",
			progress: { completed: 1, total: 3 },
		});
		await context.actions.setStatus("watch", {
			text: "Watching workspace",
		});
		const events: OrchestratorEvent[] = [];
		const statusSnapshotsDuringClear: unknown[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
			if (event.type === "extension_status_changed" && !event.status) {
				statusSnapshotsDuringClear.push(
					orchestrator.listExtensionStatuses(agentId),
				);
			}
		});

		await orchestrator.disposeAgent(agentId, "test cleanup");
		await orchestrator.disposeAgent(agentId, "already disposed");
		expect(orchestrator.getAgentStatus(agentId)).toBe("disposed");
		expect(orchestrator.listExtensionStatuses(agentId)).toEqual([]);
		expect(statusSnapshotsDuringClear).toEqual([[], []]);
		expect(
			events
				.filter(
					(
						event,
					): event is Extract<
						OrchestratorEvent,
						{ type: "extension_status_changed" }
					> => event.type === "extension_status_changed" && !event.status,
				)
				.map((event) => event.key),
		).toEqual(["sync", "watch"]);
		expect(
			events
				.filter(
					(event) => event.type === "extension_status_changed" && !event.status,
				)
				.every((event) => !Object.hasOwn(event, "status")),
		).toBe(true);
		expect(agentStatusChangedEvents(events)).toMatchObject([
			{ agentId, previousStatus: "idle", status: "disposed" },
		]);
		expect(orchestrator.inspectAgent(agentId)).toMatchObject({
			agentId,
			status: "disposed",
			hasHarness: false,
			extensionIds: ["stateful"],
		});
		expect(() => context.actions.getTools()).toThrow(
			"Agent has been disposed.",
		);
	});

	it("keeps a persisted session listed after disposing its runtime agent", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();
		const sessionMetadata = orchestrator.inspectAgent(agentId).sessionMetadata;
		if (!sessionMetadata) throw new Error("Expected agent session metadata.");
		const persistedSession = expectExtendedMetadata(sessionMetadata);

		await orchestrator.disposeAgent(agentId, "runtime cleanup");

		expect(orchestrator.getAgentStatus(agentId)).toBe("disposed");
		await expect(orchestrator.listAgentSessions()).resolves.toMatchObject({
			sessions: expect.arrayContaining([
				expect.objectContaining({
					id: agentId,
					path: persistedSession.path,
				}),
			]),
		});
	});

	it("dispose cancels only human requests bound to that agent", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const events: OrchestratorEvent[] = [];
		const signals = new Map<string, AbortSignal | undefined>();
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerClient({
			id: "human",
			requestHuman: async (request, signal) => {
				signals.set(request.title, signal);
				return await new Promise<never>(() => {});
			},
		});
		const firstAgentId = await orchestrator.spawnAgent();
		const secondAgentId = await orchestrator.spawnAgent();

		const firstRequest = orchestrator.requestHuman({
			source: { kind: "agent", agentId: firstAgentId },
			kind: "confirm",
			title: "first",
			message: "First?",
		});
		const secondRequest = orchestrator.requestHuman({
			source: { kind: "agent", agentId: secondAgentId },
			kind: "confirm",
			title: "second",
			message: "Second?",
		});
		let secondSettled = false;
		secondRequest.catch(() => {
			secondSettled = true;
		});
		await Promise.resolve();

		await orchestrator.disposeAgent(firstAgentId, "agent disposed");

		await expect(firstRequest).rejects.toMatchObject({
			code: "orchestrator.human_request_cancelled",
		});
		expect(signals.get("first")?.aborted).toBe(true);
		expect(signals.get("second")?.aborted).toBe(false);
		await Promise.resolve();
		expect(secondSettled).toBe(false);
		const secondPending = events.find(
			(
				event,
			): event is Extract<
				OrchestratorEvent,
				{ type: "human_request_pending" }
			> =>
				event.type === "human_request_pending" &&
				event.request.title === "second",
		);
		if (!secondPending) throw new Error("Expected second pending request.");
		await orchestrator.cancelHumanRequest(secondPending.request.id, "done");
		await expect(secondRequest).rejects.toMatchObject({
			code: "orchestrator.human_request_cancelled",
		});
	});

	it("disposeAll disposes every agent and cancels remaining human requests", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		orchestrator.registerClient({
			id: "human",
			requestHuman: async () => await new Promise<never>(() => {}),
		});
		const firstAgentId = await orchestrator.spawnAgent();
		const secondAgentId = await orchestrator.spawnAgent();
		const request = orchestrator.requestHuman({
			source: { kind: "system" },
			kind: "confirm",
			title: "global",
			message: "Global?",
		});
		request.catch(() => {});
		await Promise.resolve();

		await orchestrator.disposeAll("shutdown");

		expect(orchestrator.getAgentStatus(firstAgentId)).toBe("disposed");
		expect(orchestrator.getAgentStatus(secondAgentId)).toBe("disposed");
		expect(env.cleanupCalls).toBe(1);
		await expect(request).rejects.toMatchObject({
			code: "orchestrator.human_request_cancelled",
		});
	});

	it("resolves profile requested tools through ToolRegistry diagnostics", async () => {
		const env = new MemoryExecutionEnv();
		const toolProfile: AgentProfile = {
			...defaultProfile,
			id: "tool-profile",
			label: "Tool Profile",
			persist: false,
			tools: ["echo", "missing", "echo"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: toolProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([{ profile: toolProfile }]),
			),
			toolRegistry: createToolRegistry(createToolDefinition("echo", "echo")),
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		const agentId = await orchestrator.spawnAgent();

		expect(orchestrator.getAgentTools(agentId)).toEqual({
			toolNames: ["echo"],
			activeToolNames: ["echo"],
		});
		expect(
			events
				.filter((event) => event.type === "diagnostic")
				.map((event) => event.diagnostic.code),
		).toEqual(["tool.requested_duplicate", "tool.requested_missing"]);
	});

	it("filters missing resume active tools through ToolRegistry diagnostics", async () => {
		const env = new MemoryExecutionEnv();
		const sessionManager = new SessionManager({
			fs: env,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
		});
		const session = await sessionManager.createAgentSession({
			agentId: "worker-agent",
			agentProfile: restoredProfile,
		});
		await session.appendActiveToolsChange(["echo", "ghost"]);
		const metadata = expectExtendedMetadata(await session.getMetadata());
		const resumeSessionManager = new SessionManager({
			fs: env,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
		});
		const orchestrator = new AgentOrchestrator({
			executionEnv: env,
			resourceLoader: new ResourceLoader({
				executionEnv: env,
				cwd: "/workspace/project",
			}),
			sessionManager: resumeSessionManager,
			settingManager: new SettingManager(),
			modelRegistry: await createModelRegistry(env),
			profileRegistry: createProfileRegistry(),
			toolRegistry: createToolRegistry(createToolDefinition("echo", "echo")),
			defaultProfileId: defaultProfile.id,
			defaultModel,
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		const agentId = await orchestrator.spawnAgent({
			resume: true,
			metadata,
		});

		expect(orchestrator.getAgentActiveTools(agentId)).toEqual(["echo"]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "tool.active_missing",
					toolName: "ghost",
					agentId,
					profileId: restoredProfile.id,
				}),
			}),
		);
	});

	it("persists and restores an explicitly empty active tool selection", async () => {
		const env = new MemoryExecutionEnv();
		const firstOrchestrator = await createOrchestrator(env, {
			toolRegistry: createToolRegistry(createToolDefinition("echo")),
		});
		const agentId = await firstOrchestrator.spawnAgent();
		await firstOrchestrator.setAgentActiveTools(agentId, []);
		const sessionMetadata =
			firstOrchestrator.inspectAgent(agentId).sessionMetadata;
		if (!sessionMetadata) throw new Error("Expected session metadata.");

		const resumedOrchestrator = await createOrchestrator(env, {
			toolRegistry: createToolRegistry(createToolDefinition("echo")),
		});
		const resumedAgentId = await resumedOrchestrator.spawnAgent({
			resume: true,
			metadata: expectExtendedMetadata(sessionMetadata),
		});

		expect(resumedAgentId).toBe(agentId);
		expect(resumedOrchestrator.getAgentTools(resumedAgentId)).toEqual({
			toolNames: ["echo"],
			activeToolNames: [],
		});
		expect(
			requireAgentHarness(resumedOrchestrator, resumedAgentId).getActiveTools(),
		).toEqual([]);
	});

	it("reports conflicts between registry tool registrations", async () => {
		const env = new MemoryExecutionEnv();
		const toolRegistry = new ToolRegistry();
		toolRegistry.defineTool(createToolDefinition("echo", "base"), {
			kind: "core",
			id: "base",
		});
		toolRegistry.defineTool(createToolDefinition("echo", "override"), {
			kind: "extension",
			id: "override",
		});
		const orchestrator = await createOrchestrator(env, { toolRegistry });
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		const agentId = await orchestrator.spawnAgent();

		expect(orchestrator.getAgentTools(agentId)).toEqual({
			toolNames: ["echo"],
			activeToolNames: ["echo"],
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "tool.define_conflict",
					toolName: "echo",
					agentId,
					profileId: defaultProfile.id,
				}),
			}),
		);
	});

	it("activates extension tools per profile without mutating the global registry", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const plainProfile: AgentProfile = {
			...defaultProfile,
			id: "plain-profile",
			label: "Plain Profile",
			persist: false,
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
					{ profile: plainProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", (api) => {
			api.registerTool(createToolDefinition("sampleTool", "sample"));
		});

		const extensionAgentId = await orchestrator.spawnAgent();
		const plainAgentId = await orchestrator.spawnAgent({
			profileId: plainProfile.id,
		});

		expect(orchestrator.getAgentTools(extensionAgentId)).toEqual({
			toolNames: ["sampleTool"],
			activeToolNames: ["sampleTool"],
		});
		expect(orchestrator.inspectAgent(extensionAgentId)).toMatchObject({
			extensionIds: ["sample"],
			extensions: [{ id: "sample", source: { kind: "factory" } }],
			extensionSnapshot: {
				extensionIds: ["sample"],
				extensions: [{ id: "sample", source: { kind: "factory" } }],
				hooks: [],
				toolContributions: [
					{
						kind: "define",
						extensionId: "sample",
						toolName: "sampleTool",
						source: { kind: "extension", id: "sample" },
					},
				],
				stale: { stale: false },
			},
		});
		expect(orchestrator.getAgentTools(plainAgentId)).toEqual({
			toolNames: [],
			activeToolNames: [],
		});
		expect(orchestrator.inspectAgent(plainAgentId)).toMatchObject({
			extensionIds: [],
			extensions: [],
			extensionSnapshot: {
				extensionIds: [],
				extensions: [],
				hooks: [],
				toolContributions: [],
				stale: { stale: false },
			},
		});
		expect(orchestrator.toolRegistry.resolve().toolNames).toEqual([]);
	});

	it("exposes extension hooks, tool contributions, and patch facts through inspect", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
			toolRegistry: createToolRegistry(createToolDefinition("base")),
		});
		orchestrator.registerExtension("sample", (api) => {
			api.observe("agent_harness_event", () => {});
			api.intercept("context", (event) => ({ messages: event.messages }));
			api.registerTool(createToolDefinition("sampleTool", "sample"));
			api.patchTool("base", {
				description: "patched base",
				aroundExecute: async (next, toolCallId, params, context) =>
					await next(toolCallId, params, context),
			});
		});

		const agentId = await orchestrator.spawnAgent();

		expect(orchestrator.inspectAgent(agentId).extensionSnapshot).toEqual({
			extensionIds: ["sample"],
			extensions: [{ id: "sample", source: { kind: "factory" } }],
			hooks: [
				{
					kind: "observe",
					extensionId: "sample",
					eventName: "agent_harness_event",
				},
				{
					kind: "intercept",
					extensionId: "sample",
					eventName: "context",
				},
			],
			toolContributions: [
				{
					kind: "define",
					extensionId: "sample",
					toolName: "sampleTool",
					source: { kind: "extension", id: "sample" },
				},
				{
					kind: "patch",
					extensionId: "sample",
					targetToolName: "base",
					patchedFields: ["description", "aroundExecute"],
					source: { kind: "extension", id: "sample" },
				},
			],
			providerContributions: [],
			stale: { stale: false },
		});
	});

	it("normalizes extension ids and records loaded source facts", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: [" sample ", "", "sample", "missing"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerExtension("sample", (api) => {
			api.registerTool(createToolDefinition("sampleTool", "sample"));
		});

		const agentId = await orchestrator.spawnAgent();

		expect(orchestrator.inspectAgent(agentId)).toMatchObject({
			extensionIds: ["sample", "missing"],
			extensions: [{ id: "sample", source: { kind: "factory" } }],
			extensionSnapshot: {
				extensionIds: ["sample", "missing"],
				extensions: [{ id: "sample", source: { kind: "factory" } }],
				stale: { stale: false },
			},
			extensionDiagnostics: [
				expect.objectContaining({
					code: "extension.factory_missing",
					extensionId: "missing",
				}),
			],
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.factory_missing",
					disposition: "degraded",
					phase: "resolve",
					extensionId: "missing",
					agentId,
					profileId: extensionProfile.id,
					source: { kind: "extension", id: "missing" },
				}),
			}),
		);
	});

	it("delivers extension output and notifications without observer feedback or persistence", async () => {
		const { env, orchestrator, agentId, actions } =
			await createExtensionActionsHarness();
		const events: OrchestratorEvent[] = [];
		const clientEvents: OrchestratorEvent[] = [];
		const extensionObservedEvents: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerClient({
			id: "presentation-client",
			receive: (event) => {
				clientEvents.push(event);
			},
		});
		Object.assign(orchestrator, {
			_isExtensionObservedEvent: () => true,
			_emitToExtensionObservers: async (event: OrchestratorEvent) => {
				extensionObservedEvents.push(event);
			},
		});

		await actions.emitOutput("step 1");
		await actions.emitOutput("step 2");
		await actions.notify("Report generated in 2.1s");

		const presentationEvents = events.filter(
			(event) =>
				event.type === "extension_output" ||
				event.type === "extension_notification",
		);
		expect(presentationEvents).toEqual([
			{
				type: "extension_output",
				presentationId: "orchestrator-presentation-1",
				agentId,
				extensionId: "sample",
				text: "step 1",
				createdAt: expect.any(String),
			},
			{
				type: "extension_output",
				presentationId: "orchestrator-presentation-2",
				agentId,
				extensionId: "sample",
				text: "step 2",
				createdAt: expect.any(String),
			},
			{
				type: "extension_notification",
				presentationId: "orchestrator-presentation-3",
				agentId,
				extensionId: "sample",
				text: "Report generated in 2.1s",
				createdAt: expect.any(String),
			},
		]);
		expect(clientEvents).toEqual(expect.arrayContaining(presentationEvents));
		expect(extensionObservedEvents).not.toContainEqual(
			expect.objectContaining({
				type: expect.stringMatching("^extension_(output|notification)$"),
			}),
		);
		const persisted = [...env.files.values()].join("\n");
		expect(persisted).not.toContain("step 1");
		expect(persisted).not.toContain("Report generated in 2.1s");
	});

	it("isolates listener and client failures from extension presentation delivery", async () => {
		const { orchestrator, actions } = await createExtensionActionsHarness();
		const delivered: OrchestratorEvent[] = [];
		const clientEvents: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			if (
				event.type === "extension_output" ||
				event.type === "extension_notification"
			) {
				throw new Error("listener exploded");
			}
		});
		orchestrator.subscribe((event) => {
			delivered.push(event);
		});
		orchestrator.registerClient({
			id: "broken-presentation-client",
			receive: (event) => {
				if (
					event.type === "extension_output" ||
					event.type === "extension_notification"
				) {
					throw new Error("client exploded");
				}
			},
		});
		orchestrator.registerClient({
			id: "presentation-observer-client",
			receive: (event) => {
				clientEvents.push(event);
			},
		});

		await expect(actions.emitOutput("working")).resolves.toBeUndefined();
		await expect(actions.notify("Ready")).resolves.toBeUndefined();

		expect(delivered).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "extension_output", text: "working" }),
				expect.objectContaining({
					type: "extension_notification",
					text: "Ready",
				}),
			]),
		);
		expect(clientEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "extension_output", text: "working" }),
				expect.objectContaining({
					type: "extension_notification",
					text: "Ready",
				}),
				expect.objectContaining({
					type: "diagnostic",
					diagnostic: expect.objectContaining({
						code: "orchestrator.listener_failed",
					}),
				}),
			]),
		);
		expect(delivered).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "orchestrator.client_failed",
				}),
			}),
		);
	});

	it("validates extension output and notification payloads through ordinary contexts", async () => {
		const { orchestrator, actions } = await createExtensionActionsHarness();
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await expect(actions.notify("é".repeat(2_048))).resolves.toBeUndefined();
		for (const invalidCall of [
			() => actions.emitOutput(""),
			() => actions.emitOutput("x".repeat(65_537)),
			() => actions.notify(" \n\t "),
			() => actions.notify("é".repeat(2_049)),
		]) {
			await expect(invalidCall()).rejects.toThrow();
		}

		expect(
			events.filter((event) => event.type === "extension_notification"),
		).toEqual([
			expect.objectContaining({
				text: "é".repeat(2_048),
			}),
		]);
		expect(
			events.filter(
				(event) =>
					event.type === "diagnostic" &&
					event.diagnostic.code === "extension.action_failed",
			),
		).toHaveLength(4);
	});

	it("stores extension status mutation-first and protects snapshots from callers", async () => {
		const { orchestrator, agentId, actions } =
			await createExtensionActionsHarness();
		const events: OrchestratorEvent[] = [];
		const snapshotsDuringEvents: unknown[] = [];
		const extensionObservedEvents: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
			if (event.type === "extension_status_changed") {
				snapshotsDuringEvents.push(
					orchestrator.listExtensionStatuses(event.agentId),
				);
			}
		});
		Object.assign(orchestrator, {
			_isExtensionObservedEvent: () => true,
			_emitToExtensionObservers: async (event: OrchestratorEvent) => {
				extensionObservedEvents.push(event);
			},
		});

		const first = { text: "Scanning" };
		await actions.setStatus("index", first);
		first.text = "mutated after set";
		await actions.setStatus("index", {
			text: "Building",
			progress: { completed: 2, total: 5 },
		});
		await actions.clearStatus("index");
		await actions.clearStatus("missing");
		await actions.setStatus("ready", { text: "Ready" });

		const statusEvents = events.filter(
			(event) => event.type === "extension_status_changed",
		);
		expect(statusEvents).toMatchObject([
			{ key: "index", status: { text: "Scanning" } },
			{
				key: "index",
				status: {
					text: "Building",
					progress: { completed: 2, total: 5 },
				},
			},
			{ key: "index" },
			{ key: "ready", status: { text: "Ready" } },
		]);
		expect(Object.hasOwn(statusEvents[2] ?? {}, "status")).toBe(false);
		expect(snapshotsDuringEvents).toMatchObject([
			[{ key: "index", status: { text: "Scanning" } }],
			[
				{
					key: "index",
					status: {
						text: "Building",
						progress: { completed: 2, total: 5 },
					},
				},
			],
			[],
			[{ key: "ready", status: { text: "Ready" } }],
		]);
		expect(extensionObservedEvents).not.toContainEqual(
			expect.objectContaining({ type: "extension_status_changed" }),
		);
		const snapshot = orchestrator.listExtensionStatuses(agentId);
		(snapshot[0]?.status as { text: string }).text = "consumer mutation";
		expect(orchestrator.listExtensionStatuses(agentId)[0]?.status.text).toBe(
			"Ready",
		);
	});

	it("persists extension messages with one entry id and records attributed diagnostics", async () => {
		const { orchestrator, agentId, actions } =
			await createExtensionActionsHarness();
		const events: OrchestratorEvent[] = [];
		const extensionObservedEvents: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		Object.assign(orchestrator, {
			_isExtensionObservedEvent: () => true,
			_emitToExtensionObservers: async (event: OrchestratorEvent) => {
				extensionObservedEvents.push(event);
			},
		});

		const draft: {
			kind: "markdown";
			title: string;
			content: string;
		} = {
			kind: "markdown",
			title: "Index Summary",
			content: "Indexed 672 files.",
		};
		const published = await actions.publishMessage(draft);
		draft.title = "mutated after publish";
		const details: Record<string, unknown> = {
			endpoint: "https://policy.internal",
			attempts: 2,
		};
		await actions.reportDiagnostic({
			severity: "warning",
			code: "remote_policy_unreachable",
			message: "Remote policy service is unavailable",
			details,
		});
		details.attempts = 99;
		await actions.reportDiagnostic({
			severity: "warning",
			code: "remote_policy_unreachable",
			message: "Remote policy service is unavailable",
		});

		const messageEvent = events.find(
			(event) => event.type === "extension_message_published",
		);
		expect(messageEvent).toMatchObject({
			type: "extension_message_published",
			entryId: published.entryId,
			agentId,
			extensionId: "sample",
			message: {
				kind: "markdown",
				title: "Index Summary",
				content: "Indexed 672 files.",
			},
		});
		const tree = await orchestrator.getAgentSessionTree(agentId);
		expect(tree.entries).toContainEqual(
			expect.objectContaining({
				id: published.entryId,
				type: "custom",
				customType: EXTENSION_MESSAGE_CUSTOM_TYPE,
				data: expect.objectContaining({
					extensionId: "sample",
					message: {
						kind: "markdown",
						title: "Index Summary",
						content: "Indexed 672 files.",
					},
				}),
			}),
		);

		const reported = events
			.filter(
				(event): event is Extract<OrchestratorEvent, { type: "diagnostic" }> =>
					event.type === "diagnostic" &&
					event.diagnostic.code.startsWith("extension.sample."),
			)
			.map((event) => event.diagnostic);
		expect(reported).toEqual([
			expect.objectContaining({
				id: "orchestrator-diagnostic-1",
				domain: "extension",
				code: "extension.sample.remote_policy_unreachable",
				severity: "warning",
				disposition: "reported",
				source: { kind: "extension", id: "sample" },
				agentId,
				profileId: "extension-profile",
				extensionId: "sample",
				details: { endpoint: "https://policy.internal", attempts: 2 },
			}),
			expect.objectContaining({
				id: "orchestrator-diagnostic-2",
				domain: "extension",
				code: "extension.sample.remote_policy_unreachable",
				severity: "warning",
				disposition: "reported",
				source: { kind: "extension", id: "sample" },
				agentId,
				profileId: "extension-profile",
				extensionId: "sample",
			}),
		]);
		expect(orchestrator.inspectAgent(agentId).extensionDiagnostics).toEqual(
			expect.arrayContaining(reported),
		);
		expect(extensionObservedEvents).not.toContainEqual(
			expect.objectContaining({
				type: expect.stringMatching(
					"^(extension_message_published|diagnostic)$",
				),
			}),
		);
	});

	it("rejects invalid extension status keys, text, and progress", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", () => {});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const actions = runner.createContext("sample").actions;

		const invalidCalls = [
			() => actions.setStatus("", { text: "Ready" }),
			() => actions.setStatus("é".repeat(65), { text: "Ready" }),
			() => actions.setStatus("ready", { text: "" }),
			() => actions.setStatus("ready", { text: "é".repeat(2_049) }),
			() =>
				actions.setStatus("ready", {
					text: "Ready",
					progress: { completed: -1 },
				}),
			() =>
				actions.setStatus("ready", {
					text: "Ready",
					progress: { completed: 1.5 },
				}),
			() =>
				actions.setStatus("ready", {
					text: "Ready",
					progress: { completed: 2, total: 1 },
				}),
			() =>
				actions.setStatus("ready", {
					text: "Ready",
					progress: { completed: 1, total: -1 },
				}),
		];
		for (const invalidCall of invalidCalls) {
			await expect(invalidCall()).rejects.toThrow();
		}

		expect(orchestrator.listExtensionStatuses(agentId)).toEqual([]);
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "extension_status_changed" }),
		);
		expect(
			events.filter(
				(event) =>
					event.type === "diagnostic" &&
					event.diagnostic.code === "extension.action_failed" &&
					event.diagnostic.details?.action === "setStatus",
			),
		).toHaveLength(invalidCalls.length);
	});

	it("rejects invalid extension messages without persisting entries or events", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", () => {});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const actions = runner.createContext("sample").actions;

		const invalidCalls = [
			() =>
				actions.publishMessage({
					kind: "html" as "text",
					content: "Report",
				}),
			() => actions.publishMessage({ kind: "text", content: "" }),
			() =>
				actions.publishMessage({
					kind: "text",
					content: "é".repeat(32_769),
				}),
			() =>
				actions.publishMessage({
					kind: "text",
					title: "   ",
					content: "Report",
				}),
			() =>
				actions.publishMessage({
					kind: "text",
					title: "é".repeat(2_049),
					content: "Report",
				}),
		];
		for (const invalidCall of invalidCalls) {
			await expect(invalidCall()).rejects.toThrow();
		}

		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "extension_message_published" }),
		);
		const tree = await orchestrator.getAgentSessionTree(agentId);
		expect(tree.entries).not.toContainEqual(
			expect.objectContaining({
				customType: EXTENSION_MESSAGE_CUSTOM_TYPE,
			}),
		);
		expect(
			events.filter(
				(event) =>
					event.type === "diagnostic" &&
					event.diagnostic.code === "extension.action_failed" &&
					event.diagnostic.details?.action === "publishMessage",
			),
		).toHaveLength(invalidCalls.length);
	});

	it("rejects invalid extension diagnostic drafts without publishing", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", () => {});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const actions = runner.createContext("sample").actions;
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		const invalidCalls = [
			() =>
				actions.reportDiagnostic({
					severity: "fatal" as "error",
					code: "bad",
					message: "Report",
				}),
			() =>
				actions.reportDiagnostic({
					severity: "warning",
					disposition: "blocked" as "reported",
					code: "bad",
					message: "Report",
				}),
			() =>
				actions.reportDiagnostic({
					severity: "warning",
					code: "has space",
					message: "Report",
				}),
			() =>
				actions.reportDiagnostic({
					severity: "warning",
					code: "",
					message: "Report",
				}),
			() =>
				actions.reportDiagnostic({
					severity: "warning",
					code: "c".repeat(129),
					message: "Report",
				}),
			() =>
				actions.reportDiagnostic({
					severity: "warning",
					code: "bad",
					message: "   ",
				}),
			() =>
				actions.reportDiagnostic({
					severity: "warning",
					code: "bad",
					message: "é".repeat(2_049),
				}),
			() =>
				actions.reportDiagnostic({
					severity: "warning",
					code: "bad",
					message: "Report",
					details: circular,
				}),
			() =>
				actions.reportDiagnostic({
					severity: "warning",
					code: "bad",
					message: "Report",
					details: { blob: "a".repeat(16_400) },
				}),
		];
		for (const invalidCall of invalidCalls) {
			await expect(invalidCall()).rejects.toThrow();
		}

		expect(
			events.filter(
				(event) =>
					event.type === "diagnostic" &&
					event.diagnostic.code.startsWith("extension.sample."),
			),
		).toEqual([]);
		expect(
			events.filter(
				(event) =>
					event.type === "diagnostic" &&
					event.diagnostic.code === "extension.action_failed" &&
					event.diagnostic.details?.action === "reportDiagnostic",
			),
		).toHaveLength(invalidCalls.length);
	});

	it("keeps an unavailable record when extension activation fails", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["broken"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerExtension("broken", () => {
			throw new Error("activation exploded");
		});

		await expect(orchestrator.spawnAgent()).rejects.toThrow(
			"activation exploded",
		);

		const agentId = "extension-profile";
		expect(agentStatusChangedEvents(events)).toMatchObject([
			{ agentId, previousStatus: undefined, status: "creating" },
			{ agentId, previousStatus: "creating", status: "unavailable" },
		]);
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "agent_spawned", agentId }),
		);
		expect(orchestrator.inspectAgent(agentId)).toMatchObject({
			agentId,
			status: "unavailable",
			hasHarness: false,
			extensionDiagnostics: [
				expect.objectContaining({
					code: "extension.activation_failed",
					disposition: "blocked",
					phase: "create",
					extensionId: "broken",
					agentId,
					profileId: extensionProfile.id,
				}),
			],
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.activation_failed",
					disposition: "blocked",
					phase: "create",
					source: { kind: "extension", id: "broken" },
				}),
			}),
		);
	});

	it("reloads idle agent extension runners and activates new tools in default-all mode", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", (api) => {
			api.registerTool(createToolDefinition("alpha", "alpha"));
		});
		const agentId = await orchestrator.spawnAgent();
		const oldRunner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!oldRunner) throw new Error("Expected extension runner.");
		const oldContext = oldRunner.createContext("sample");
		await oldContext.actions.setStatus("index", {
			text: "Indexing",
			progress: { completed: 2, total: 5 },
		});
		const events: OrchestratorEvent[] = [];
		const statusSnapshotsDuringClear: unknown[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
			if (event.type === "extension_status_changed" && !event.status) {
				statusSnapshotsDuringClear.push(
					orchestrator.listExtensionStatuses(agentId),
				);
			}
		});
		orchestrator.registerExtension("sample", (api) => {
			api.registerTool(createToolDefinition("alpha", "alpha"));
			api.registerTool(createToolDefinition("beta", "beta"));
		});

		const result = await orchestrator.reloadExtensions();

		expect(result).toMatchObject({
			agents: [
				{
					agentId,
					status: "reloaded",
					before: {
						extensionSnapshot: {
							stale: {
								stale: true,
								message: "Extension runtime has been reloaded.",
							},
						},
					},
					after: {
						extensionSnapshot: {
							stale: { stale: false },
							toolContributions: [
								expect.objectContaining({
									kind: "define",
									toolName: "alpha",
								}),
								expect.objectContaining({
									kind: "define",
									toolName: "beta",
								}),
							],
						},
					},
				},
			],
		});
		expect(orchestrator.getAgentTools(agentId)).toEqual({
			toolNames: ["alpha", "beta"],
			activeToolNames: ["alpha", "beta"],
		});
		expect(orchestrator.listExtensionStatuses(agentId)).toEqual([]);
		expect(statusSnapshotsDuringClear).toEqual([[]]);
		const clearEvent = events.find(
			(
				event,
			): event is Extract<
				OrchestratorEvent,
				{ type: "extension_status_changed" }
			> =>
				event.type === "extension_status_changed" &&
				event.extensionId === "sample" &&
				event.key === "index" &&
				event.status === undefined,
		);
		expect(clearEvent).toMatchObject({
			type: "extension_status_changed",
			agentId,
			extensionId: "sample",
			key: "index",
		});
		expect(Object.hasOwn(clearEvent ?? {}, "status")).toBe(false);
		expect(() => oldContext.actions.getTools()).toThrow(
			"Extension runtime has been reloaded.",
		);
	});

	it("switches new turn contexts to the reloaded runner without rebinding old snapshots", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", (api) => {
			api.registerTool(createToolDefinition("alpha"));
		});
		const agentId = await orchestrator.spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);
		const oldToolContext = await resolveHarnessToolContext(harness);
		const oldActions = requireExtensionToolActions(oldToolContext, "sample");
		expect(oldActions.getTools().toolNames).toEqual(["alpha"]);

		orchestrator.registerExtension("sample", (api) => {
			api.registerTool(createToolDefinition("alpha"));
			api.registerTool(createToolDefinition("beta"));
		});
		await orchestrator.reloadExtensions();

		expect(() => oldActions.getTools()).toThrow(
			"Extension runtime has been reloaded.",
		);
		const newToolContext = await resolveHarnessToolContext(harness);
		const newActions = requireExtensionToolActions(newToolContext, "sample");
		expect(newActions).not.toBe(oldActions);
		expect(newActions.getTools().toolNames).toEqual(["alpha", "beta"]);
	});

	it("preserves explicit active tool selections across extension reload", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", (api) => {
			api.registerTool(createToolDefinition("alpha", "alpha"));
		});
		const agentId = await orchestrator.spawnAgent();
		await orchestrator.setAgentActiveTools(agentId, ["alpha"]);
		orchestrator.registerExtension("sample", (api) => {
			api.registerTool(createToolDefinition("alpha", "alpha"));
			api.registerTool(createToolDefinition("beta", "beta"));
		});

		const result = await orchestrator.reloadExtensions();

		expect(result.agents).toMatchObject([{ agentId, status: "reloaded" }]);
		expect(orchestrator.getAgentTools(agentId)).toEqual({
			toolNames: ["alpha", "beta"],
			activeToolNames: ["alpha"],
		});
	});

	it("skips running agents during extension reload and keeps old tools", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", (api) => {
			api.registerTool(createToolDefinition("alpha", "alpha"));
		});
		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		await runner
			.createContext("sample")
			.actions.setStatus("index", { text: "Indexing" });
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);
		await handleHarnessEvent(agentId, { type: "turn_start" });
		orchestrator.registerExtension("sample", (api) => {
			api.registerTool(createToolDefinition("beta", "beta"));
		});

		const result = await orchestrator.reloadExtensions();

		expect(result.agents).toMatchObject([
			{ agentId, status: "skipped", reason: "running" },
		]);
		expect(result.agents[0]?.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "extension.reload_agent_skipped",
				agentId,
			}),
		);
		expect(orchestrator.getAgentTools(agentId)).toEqual({
			toolNames: ["alpha"],
			activeToolNames: ["alpha"],
		});
		expect(orchestrator.listExtensionStatuses(agentId)).toMatchObject([
			{
				extensionId: "sample",
				key: "index",
				status: { text: "Indexing" },
			},
		]);
	});

	it("preserves extension statuses when extension reload fails", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", () => {});
		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		await runner
			.createContext("sample")
			.actions.setStatus("index", { text: "Indexing" });
		const harness = requireAgentHarness(orchestrator, agentId);
		harness.setTools = async () => {
			throw new Error("reload tool binding failed");
		};

		const result = await orchestrator.reloadExtensions();

		expect(result.agents).toMatchObject([{ agentId, status: "failed" }]);
		expect(requireAgentRecord(orchestrator, agentId).extensionRunner).toBe(
			runner,
		);
		expect(runner.isStale()).toBe(false);
		expect(runner.createContext("sample").actions.getTools()).toEqual({
			toolNames: [],
			activeToolNames: [],
		});
		expect(orchestrator.listExtensionStatuses(agentId)).toMatchObject([
			{
				extensionId: "sample",
				key: "index",
				status: { text: "Indexing" },
			},
		]);
	});

	it("applies scoped extension tool patches in activation order", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["patcher"],
		};
		const plainProfile: AgentProfile = {
			...defaultProfile,
			id: "plain-profile",
			label: "Plain Profile",
			persist: false,
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
					{ profile: plainProfile },
				]),
			),
			toolRegistry: createToolRegistry(createToolDefinition("plain", "base")),
		});
		orchestrator.registerExtension("patcher", (api) => {
			api.patchTool("late", {
				description: "patched late tool",
			});
			api.registerTool(createToolDefinition("late", "late-base"));
			api.patchTool("plain", {
				description: "patched plain tool",
				execute: async () => ({
					content: [{ type: "text", text: "patched" }],
					details: { source: "patcher" },
				}),
			});
		});

		const extensionAgentId = await orchestrator.spawnAgent();
		const extensionHarness = requireAgentHarness(
			orchestrator,
			extensionAgentId,
		);
		const plainAgentId = await orchestrator.spawnAgent({
			profileId: plainProfile.id,
		});
		const plainHarness = requireAgentHarness(orchestrator, plainAgentId);
		const patchedPlain = extensionHarness
			.getTools()
			.find((tool) => tool.name === "plain");
		const lateTool = extensionHarness
			.getTools()
			.find((tool) => tool.name === "late");
		const unpatchedPlain = plainHarness
			.getTools()
			.find((tool) => tool.name === "plain");
		if (!patchedPlain || !lateTool || !unpatchedPlain) {
			throw new Error("Expected test tools to resolve.");
		}

		await expect(
			patchedPlain.execute(
				"call-1",
				{},
				undefined,
				undefined,
				await resolveHarnessToolContext(extensionHarness),
			),
		).resolves.toEqual({
			content: [{ type: "text", text: "patched" }],
			details: { source: "patcher" },
		});
		await expect(
			unpatchedPlain.execute(
				"call-2",
				{},
				undefined,
				undefined,
				await resolveHarnessToolContext(plainHarness),
			),
		).resolves.toEqual({
			content: [{ type: "text", text: "base" }],
			details: undefined,
		});
		expect(lateTool.description).toBe("patched late tool");
		expect(orchestrator.getAgentTools(extensionAgentId)).toEqual({
			toolNames: ["plain", "late"],
			activeToolNames: ["plain", "late"],
		});
		expect(orchestrator.getAgentTools(plainAgentId)).toEqual({
			toolNames: ["plain"],
			activeToolNames: ["plain"],
		});
		expect(
			orchestrator.toolRegistry.resolve().getToolDefinition("plain"),
		).toMatchObject({
			description: "plain tool",
		});
	});

	it("emits extension diagnostics for missing factories", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["missing"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		const agentId = await orchestrator.spawnAgent();

		expect(orchestrator.inspectAgent(agentId)).toMatchObject({
			extensionIds: ["missing"],
			extensions: [],
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					domain: "extension",
					code: "extension.factory_missing",
					disposition: "degraded",
					phase: "resolve",
					extensionId: "missing",
					agentId,
					profileId: extensionProfile.id,
					source: { kind: "extension", id: "missing" },
				}),
			}),
		);
	});

	it("routes raw harness events to scoped extension handlers", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["observer"],
		};
		const observed: string[] = [];
		let observedEvent: AgentHarnessEvent | undefined;
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
			toolRegistry: createToolRegistry(createToolDefinition("plain")),
		});
		orchestrator.registerExtension("observer", (api) => {
			api.observe("agent_harness_event", (event, context) => {
				observedEvent = event.event;
				const tools = context.actions.getTools();
				observed.push(
					`${context.extensionId}:${context.profileId}:${event.event.type}:${tools.toolNames.join(",")}`,
				);
			});
		});
		const agentId = await orchestrator.spawnAgent();
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);

		const harnessEvent = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "plain",
			args: {},
		} satisfies AgentHarnessEvent;
		await handleHarnessEvent(agentId, harnessEvent);

		expect(observedEvent).toBe(harnessEvent);
		expect(observed).toEqual([
			`observer:${extensionProfile.id}:tool_execution_start:plain`,
		]);
	});

	it("exposes the current run signal to extension contexts until settled", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["observer"],
		};
		const observedSignals: Array<AbortSignal | undefined> = [];
		let capturedContext: ExtensionContext | undefined;
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("observer", (api) => {
			api.observe("agent_harness_event", (_event, context) => {
				capturedContext = context;
				observedSignals.push(context.signal);
			});
		});
		const agentId = await orchestrator.spawnAgent();
		const handleSubscribedHarnessEvent = (
			orchestrator as unknown as {
				_handleSubscribedAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
					signal?: AbortSignal,
				): Promise<void>;
			}
		)._handleSubscribedAgentHarnessEvent.bind(orchestrator);
		const controller = new AbortController();

		await handleSubscribedHarnessEvent(
			agentId,
			{ type: "turn_start" },
			controller.signal,
		);
		expect(observedSignals).toEqual([controller.signal]);
		expect(capturedContext?.signal).toBe(controller.signal);

		await handleSubscribedHarnessEvent(
			agentId,
			{ type: "settled", nextTurnCount: 0 },
			controller.signal,
		);
		expect(observedSignals).toEqual([controller.signal, controller.signal]);
		expect(capturedContext?.signal).toBeUndefined();
	});

	it("publishes diagnostics for observer failures and continues observers", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["broken", "healthy"],
		};
		const observed: string[] = [];
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerExtension("broken", (api) => {
			api.observe("agent_harness_event", () => {
				throw new Error("observer exploded");
			});
		});
		orchestrator.registerExtension("healthy", (api) => {
			api.observe("agent_harness_event", () => {
				observed.push("healthy");
			});
		});

		const agentId = await orchestrator.spawnAgent();
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);

		await handleHarnessEvent(agentId, { type: "turn_start" });

		expect(observed).toEqual(["healthy"]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.handler_failed",
					disposition: "degraded",
					phase: "runtime",
					extensionId: "broken",
					agentId,
					profileId: extensionProfile.id,
					source: { kind: "extension", id: "broken" },
					details: { eventName: "agent_harness_event" },
				}),
			}),
		);
	});

	it("bridges scoped extension interceptors into AgentHarness hooks", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["first", "second"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("first", (api) => {
			api.intercept("before_agent_start", () => ({
				messages: [
					{
						role: "user",
						content: "first",
						timestamp: 1,
					},
				],
				systemPrompt: "first prompt",
			}));
			api.intercept("context", (event) => ({
				messages: [
					...event.messages,
					{ role: "user", content: "first context", timestamp: 2 },
				],
			}));
			api.intercept("tool_call", () => ({
				block: true,
				reason: "blocked by first",
			}));
			api.intercept("tool_result", () => ({
				content: [{ type: "text", text: "first result" }],
				details: { first: true },
				terminate: true,
			}));
		});
		orchestrator.registerExtension("second", (api) => {
			api.intercept("before_agent_start", () => ({
				messages: [
					{
						role: "user",
						content: "second",
						timestamp: 3,
					},
				],
				systemPrompt: "second prompt",
			}));
			api.intercept("context", (event) => ({
				messages: [
					...event.messages,
					{ role: "user", content: "second context", timestamp: 4 },
				],
			}));
			api.intercept("tool_call", () => {
				throw new Error("blocked tool_call should short-circuit");
			});
			api.intercept("tool_result", () => ({
				content: [{ type: "text", text: "second result" }],
				isError: true,
			}));
		});

		const agentId = await orchestrator.spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);
		const handlers = (
			harness as unknown as {
				handlers: Map<string, Set<(event: unknown) => Promise<unknown>>>;
			}
		).handlers;
		const runHook = async (name: string, event: unknown) => {
			const handler = Array.from(handlers.get(name) ?? [])[0];
			if (!handler) throw new Error(`Missing harness hook: ${name}`);
			return await handler(event);
		};

		await expect(
			runHook("before_agent_start", {
				type: "before_agent_start",
				prompt: "go",
				systemPrompt: "base prompt",
				resources: {},
			}),
		).resolves.toEqual({
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "user", content: "second", timestamp: 3 },
			],
			systemPrompt: "second prompt",
		});
		await expect(
			runHook("context", {
				type: "context",
				messages: [{ role: "user", content: "base", timestamp: 0 }],
			}),
		).resolves.toEqual({
			messages: [
				{ role: "user", content: "base", timestamp: 0 },
				{ role: "user", content: "first context", timestamp: 2 },
				{ role: "user", content: "second context", timestamp: 4 },
			],
		});
		await expect(
			runHook("tool_call", {
				type: "tool_call",
				toolCallId: "call-1",
				toolName: "write",
				input: {},
			}),
		).resolves.toEqual({
			block: true,
			reason: "blocked by first",
		});
		await expect(
			runHook("tool_result", {
				type: "tool_result",
				toolCallId: "call-1",
				toolName: "write",
				input: {},
				content: [{ type: "text", text: "base result" }],
				details: undefined,
				isError: false,
			}),
		).resolves.toEqual({
			content: [{ type: "text", text: "second result" }],
			details: { first: true },
			isError: true,
			terminate: true,
		});
	});

	it("publishes interceptor diagnostics and preserves runner failure semantics", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["broken", "healthy"],
		};
		let healthyCalled = false;
		let healthyToolCallCalled = false;
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerExtension("broken", (api) => {
			api.intercept("context", () => {
				throw new Error("interceptor exploded");
			});
			api.intercept("tool_call", () => {
				throw new Error("tool call interceptor exploded");
			});
		});
		orchestrator.registerExtension("healthy", (api) => {
			api.intercept("context", (event) => {
				healthyCalled = true;
				return { messages: event.messages };
			});
			api.intercept("tool_call", () => {
				healthyToolCallCalled = true;
				return undefined;
			});
		});

		const agentId = await orchestrator.spawnAgent();
		const harness = requireAgentHarness(orchestrator, agentId);
		const handlers = (
			harness as unknown as {
				handlers: Map<string, Set<(event: unknown) => Promise<unknown>>>;
			}
		).handlers;
		const runHook = async (name: string, event: unknown) => {
			const handler = Array.from(handlers.get(name) ?? [])[0];
			if (!handler) throw new Error(`Missing harness hook: ${name}`);
			return await handler(event);
		};

		await expect(
			runHook("context", {
				type: "context",
				messages: [{ role: "user", content: "base", timestamp: 0 }],
			}),
		).resolves.toEqual({
			messages: [{ role: "user", content: "base", timestamp: 0 }],
		});
		await expect(
			runHook("tool_call", {
				type: "tool_call",
				toolCallId: "call-1",
				toolName: "write",
				input: {},
			}),
		).resolves.toEqual({ block: true });

		expect(healthyCalled).toBe(true);
		expect(healthyToolCallCalled).toBe(false);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.handler_failed",
					disposition: "degraded",
					phase: "runtime",
					extensionId: "broken",
					agentId,
					profileId: extensionProfile.id,
					source: { kind: "extension", id: "broken" },
					details: { eventName: "context" },
				}),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.handler_failed",
					extensionId: "broken",
					details: { eventName: "tool_call" },
				}),
			}),
		);
	});

	it("binds the extension runner core context after harness creation", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["observer"],
		};
		const observed: string[] = [];
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("observer", (api) => {
			api.observe("agent_harness_event", (_event, context) => {
				observed.push(
					`${context.extensionId}:${context.profileId}:${context.isIdle()}:${context.actions.getTools().toolNames.length}`,
				);
			});
		});

		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const context = runner.createContext("observer");
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);

		await handleHarnessEvent(agentId, { type: "turn_start" });

		expect(context.extensionId).toBe("observer");
		expect(observed).toEqual([`observer:${extensionProfile.id}:false:0`]);
	});

	it("binds extension session context to scoped agent custom entries", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: true,
			extensions: ["stateful"],
		};
		const observed: string[] = [];
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("stateful", (api) => {
			api.observe("agent_harness_event", async (_event, context) => {
				const before = await context.session.findEntries<{ count: number }>(
					"state",
				);
				await context.session.appendEntry("state", {
					count: before.length + 1,
				});
				const after = await context.session.findEntries<{ count: number }>(
					"state",
				);
				observed.push(
					`${context.extensionId}:${after.map((entry) => entry.data?.count).join(",")}`,
				);
			});
		});

		const agentId = await orchestrator.spawnAgent();
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);

		await handleHarnessEvent(agentId, { type: "turn_start" });
		await handleHarnessEvent(agentId, { type: "turn_start" });

		expect(observed).toEqual(["stateful:1", "stateful:1,2"]);
		await expect(
			orchestrator.sessionManager.findExtensionCustomEntries(
				agentId,
				"stateful",
				"state",
			),
		).resolves.toMatchObject([
			{ type: "state", data: { count: 1 } },
			{ type: "state", data: { count: 2 } },
		]);
	});

	it("publishes diagnostics for extension custom-entry action failures", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: true,
			extensions: ["stateful"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerExtension("stateful", (api) => {
			api.observe("agent_harness_event", async (_event, context) => {
				await context.session.appendEntry("bad/type", {});
			});
		});

		const agentId = await orchestrator.spawnAgent();
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);

		await handleHarnessEvent(agentId, { type: "turn_start" });

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.custom_entry_append_failed",
					disposition: "degraded",
					phase: "runtime",
					extensionId: "stateful",
					agentId,
					profileId: extensionProfile.id,
					source: { kind: "extension", id: "stateful" },
					details: expect.objectContaining({ action: "appendEntry" }),
				}),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.handler_failed",
					extensionId: "stateful",
					details: { eventName: "agent_harness_event" },
				}),
			}),
		);
		expect(orchestrator.inspectAgent(agentId).extensionDiagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "extension.custom_entry_append_failed",
				}),
				expect.objectContaining({ code: "extension.handler_failed" }),
			]),
		);
	});

	it("exposes scoped prompt, steer, and follow-up extension actions", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", () => {});
		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const context = runner.createContext("sample");
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const prompted: string[] = [];
		Object.assign(orchestrator, {
			promptAgent: async (targetAgentId: string, text: string) => {
				prompted.push(`${targetAgentId}:${text}`);
				return { role: "assistant" } as AssistantMessage;
			},
		});
		const harness = requireAgentHarness(orchestrator, agentId);
		(harness as unknown as { phase: "turn" }).phase = "turn";

		await context.actions.prompt("start here");
		await context.actions.steer("keep going");
		await context.actions.followUp("summarize next");

		expect(prompted).toEqual([`${agentId}:start here`]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "agent_harness_event",
				agentId,
				event: expect.objectContaining({
					type: "queue_update",
					steer: [
						expect.objectContaining({
							role: "user",
							content: [{ type: "text", text: "keep going" }],
						}),
					],
				}),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "agent_harness_event",
				agentId,
				event: expect.objectContaining({
					type: "queue_update",
					followUp: [
						expect.objectContaining({
							role: "user",
							content: [{ type: "text", text: "summarize next" }],
						}),
					],
				}),
			}),
		);
	});

	it("exposes scoped session, model, and thinking extension actions", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: true,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", () => {});
		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const context = runner.createContext("sample");
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await context.actions.setSessionName("audited session");
		await expect(orchestrator.getAgentSession(agentId)).resolves.toMatchObject({
			name: "audited session",
		});
		await expect(context.actions.getSessionName()).resolves.toBe(
			"audited session",
		);

		const model = await context.actions.setModel(
			"test-provider/reasoning-model",
		);
		expect(model.id).toBe("reasoning-model");
		expect(orchestrator.getAgentModel(agentId).id).toBe("reasoning-model");
		await context.actions.setThinkingLevel("high");
		expect(context.actions.getThinkingLevel()).toBe("high");
		expect(orchestrator.getAgentThinkingLevel(agentId)).toBe("high");

		expect(context.actions.getModel().id).toBe("reasoning-model");
		await expect(context.actions.listModelCandidates()).resolves.toContainEqual(
			expect.objectContaining({ value: "test-provider/reasoning-model" }),
		);

		const aborted: string[] = [];
		const compacted: [string, string | undefined][] = [];
		Object.assign(orchestrator, {
			abortAgent: async (abortedAgentId: string) => {
				aborted.push(abortedAgentId);
			},
			compactAgent: async (
				compactedAgentId: string,
				customInstructions?: string,
			) => {
				compacted.push([compactedAgentId, customInstructions]);
			},
		});
		await context.actions.abort();
		await context.actions.compact("keep decisions");
		expect(aborted).toEqual([agentId]);
		expect(compacted).toEqual([[agentId, "keep decisions"]]);

		await expect(context.actions.setModel("bogus")).rejects.toMatchObject({
			diagnostic: expect.objectContaining({ code: "model.reference_invalid" }),
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.action_failed",
					extensionId: "sample",
					agentId,
					details: expect.objectContaining({ action: "setModel" }),
				}),
			}),
		);
	});

	it("returns the compaction result from the compact extension action", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", () => {});
		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const context = runner.createContext("sample");
		const compacted: string[] = [];
		Object.assign(orchestrator, {
			compactAgent: async (
				targetAgentId: string,
				customInstructions?: string,
			) => {
				compacted.push(`${targetAgentId}:${customInstructions ?? ""}`);
				return {
					summary: "compacted summary",
					firstKeptEntryId: "entry-1",
					tokensBefore: 1234,
				};
			},
		});

		await expect(
			context.actions.compact("keep architecture decisions"),
		).resolves.toEqual({
			summary: "compacted summary",
			firstKeptEntryId: "entry-1",
			tokensBefore: 1234,
		});
		expect(compacted).toEqual([`${agentId}:keep architecture decisions`]);
	});

	it("reports compact extension action failures as diagnostics and rethrows", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", () => {});
		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const context = runner.createContext("sample");
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		// A fresh agent has nothing to compact, so the real harness rejects.
		await expect(context.actions.compact()).rejects.toThrow();
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.action_failed",
					extensionId: "sample",
					agentId,
					details: expect.objectContaining({ action: "compact" }),
				}),
			}),
		);
	});

	it("injects the extension source into human requests", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", () => {});
		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const context = runner.createContext("sample");
		let captured: unknown;
		orchestrator.registerClient({
			id: "human",
			requestHuman: async (request) => {
				captured = request;
				return { kind: "confirm", confirmed: true };
			},
		});

		await expect(
			context.actions.requestHuman({ kind: "confirm", title: "Approve?" }),
		).resolves.toEqual({ kind: "confirm", confirmed: true });
		expect(captured).toMatchObject({
			kind: "confirm",
			title: "Approve?",
			source: { kind: "extension", extensionId: "sample" },
		});
	});

	it("denies extension human requests when the profile capability disallows them", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
			capabilities: { canRequestUser: false },
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", () => {});
		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const context = runner.createContext("sample");
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerClient({
			id: "human",
			requestHuman: async () => ({ kind: "confirm", confirmed: true }),
		});

		await expect(
			context.actions.requestHuman({ kind: "confirm", title: "Approve?" }),
		).rejects.toMatchObject({
			diagnostic: expect.objectContaining({
				code: "extension.human_request_denied",
				extensionId: "sample",
				agentId,
			}),
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.action_failed",
					extensionId: "sample",
					details: expect.objectContaining({ action: "requestHuman" }),
				}),
			}),
		);
	});

	it("routes the ask_human tool through the human request broker with agent source", async () => {
		const env = new MemoryExecutionEnv();
		const toolRegistry = new ToolRegistry();
		registerCoreInteractionTools(toolRegistry);
		const orchestrator = await createOrchestrator(env, { toolRegistry });
		let captured: unknown;
		orchestrator.registerClient({
			id: "human",
			requestHuman: async (request) => {
				captured = request;
				return { kind: "select", value: "green" };
			},
		});
		const agentId = await orchestrator.spawnAgent();
		const askHuman = requireAgentHarness(orchestrator, agentId)
			.getTools()
			.find((candidate) => candidate.name === "ask_human");
		if (!askHuman) throw new Error("Expected the ask_human tool.");

		const result = await askHuman.execute(
			"call-1",
			{ kind: "select", title: "Pick a color", options: ["red", "green"] },
			undefined,
			undefined,
			await resolveHarnessToolContext(
				requireAgentHarness(orchestrator, agentId),
			),
		);
		expect(captured).toMatchObject({
			kind: "select",
			title: "Pick a color",
			options: ["red", "green"],
			source: { kind: "agent", agentId },
		});
		expect(result.content).toEqual([
			{ type: "text", text: "The human selected: green" },
		]);
	});

	it("denies agent tool human requests when the profile capability disallows them", async () => {
		const env = new MemoryExecutionEnv();
		const toolRegistry = new ToolRegistry();
		registerCoreInteractionTools(toolRegistry);
		const restrictedProfile: AgentProfile = {
			...defaultProfile,
			id: "restricted-profile",
			persist: false,
			capabilities: { canRequestUser: false },
		};
		const orchestrator = await createOrchestrator(env, {
			toolRegistry,
			defaultProfileId: restrictedProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: restrictedProfile },
				]),
			),
		});
		let handlerCalls = 0;
		orchestrator.registerClient({
			id: "human",
			requestHuman: async () => {
				handlerCalls += 1;
				return { kind: "confirm", confirmed: true };
			},
		});
		const agentId = await orchestrator.spawnAgent();
		const askHuman = requireAgentHarness(orchestrator, agentId)
			.getTools()
			.find((candidate) => candidate.name === "ask_human");
		if (!askHuman) throw new Error("Expected the ask_human tool.");

		await expect(
			askHuman.execute(
				"call-1",
				{ kind: "confirm", title: "Approve?" },
				undefined,
				undefined,
				await resolveHarnessToolContext(
					requireAgentHarness(orchestrator, agentId),
				),
			),
		).rejects.toMatchObject({
			diagnostic: expect.objectContaining({
				code: "orchestrator.human_request_denied",
				agentId,
			}),
		});
		expect(handlerCalls).toBe(0);
	});

	/**
	 * Register an OAuth-capable test provider into the orchestrator's model
	 * registry. Login flows discover providers through the Models runtime, so a
	 * minimal model is required for the provider to exist.
	 */
	function registerOAuthTestProvider(
		orchestrator: AgentOrchestrator,
		providerId: string,
		oauth: OAuthProviderConfig,
	): void {
		orchestrator.modelRegistry.registerProvider(providerId, {
			name: oauth.name,
			baseUrl: "https://example.test",
			api: "openai-completions",
			oauth,
			models: [
				{
					id: "fake-oauth-model",
					name: "Fake OAuth Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	}

	it("loginAuthProvider drives the OAuth flow through events and human requests", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerClient({
			id: "human",
			requestHuman: async (request) => {
				if (request.kind === "select") {
					const option = request.options?.[1];
					const value =
						typeof option === "string"
							? option
							: (option?.value ?? option?.label);
					return { kind: "select", value };
				}
				return { kind: "input", value: "auth-code-123" };
			},
		});
		let selectedMethod: string | undefined;
		registerOAuthTestProvider(orchestrator, "fake-oauth", {
			name: "Fake OAuth",
			login: async (callbacks) => {
				selectedMethod = await callbacks.onSelect({
					message: "Choose a login method",
					options: [
						{ id: "browser", label: "Browser" },
						{ id: "device", label: "Device code" },
					],
				});
				callbacks.onAuth({
					url: "https://example.test/authorize",
					instructions: "Complete login in your browser.",
				});
				callbacks.onDeviceCode({
					userCode: "ABCD-1234",
					verificationUri: "https://example.test/device",
				});
				callbacks.onProgress?.("Exchanging code...");
				const code = await callbacks.onPrompt({ message: "Paste the code:" });
				return {
					refresh: "refresh-token",
					access: `access:${code}`,
					expires: Date.now() + 60_000,
				};
			},
			refreshToken: async (credentials) => credentials,
			getApiKey: (credentials) => credentials.access,
		});

		const agentId = await orchestrator.spawnAgent();
		await expect(
			orchestrator.loginAuthProvider("fake-oauth", { agentId }),
		).resolves.toEqual({
			providerId: "fake-oauth",
			providerName: "Fake OAuth",
		});
		expect(selectedMethod).toBe("device");
		expect(orchestrator.modelRegistry.authStorage.get("fake-oauth")).toEqual({
			type: "oauth",
			refresh: "refresh-token",
			access: "access:auth-code-123",
			expires: expect.any(Number),
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "auth_login_url",
				providerId: "fake-oauth",
				agentId,
				url: "https://example.test/authorize",
				instructions: "Complete login in your browser.",
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "auth_login_code",
				providerId: "fake-oauth",
				userCode: "ABCD-1234",
				verificationUri: "https://example.test/device",
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "auth_login_progress",
				providerId: "fake-oauth",
				message: "Exchanging code...",
			}),
		);
	});

	it("withdraws the provisional manual code input without publishing a fault", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		// The human never answers: the manual input stays pending until the
		// flow settles, exactly like a local callback server winning the race.
		orchestrator.registerClient({
			id: "human",
			requestHuman: async () => await new Promise<never>(() => {}),
		});
		let manualOutcome: string | undefined;
		registerOAuthTestProvider(orchestrator, "fake-callback-oauth", {
			name: "Fake Callback OAuth",
			usesCallbackServer: true,
			login: async (callbacks) => {
				callbacks.onAuth({ url: "https://example.test/authorize" });
				void callbacks
					.onManualCodeInput?.()
					.then(() => {
						manualOutcome = "resolved";
					})
					.catch(() => {
						manualOutcome = "rejected";
					});
				return {
					refresh: "refresh-token",
					access: "access-token",
					expires: Date.now() + 60_000,
				};
			},
			refreshToken: async (credentials) => credentials,
			getApiKey: (credentials) => credentials.access,
		});

		await expect(
			orchestrator.loginAuthProvider("fake-callback-oauth"),
		).resolves.toMatchObject({ providerId: "fake-callback-oauth" });
		await new Promise((resolve) => setImmediate(resolve));
		expect(manualOutcome).toBe("rejected");
		expect(
			events.filter(
				(event) =>
					event.type === "diagnostic" &&
					event.diagnostic.code === "orchestrator.human_request_aborted",
			),
		).toEqual([]);
	});

	it("fails the login when the human dismisses a required prompt", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		orchestrator.registerClient({
			id: "human",
			requestHuman: async () => ({ kind: "input", value: undefined }),
		});
		registerOAuthTestProvider(orchestrator, "fake-prompt-oauth", {
			name: "Fake Prompt OAuth",
			login: async (callbacks) => {
				const code = await callbacks.onPrompt({ message: "Paste the code:" });
				return {
					refresh: "refresh-token",
					access: `access:${code}`,
					expires: Date.now() + 60_000,
				};
			},
			refreshToken: async (credentials) => credentials,
			getApiKey: (credentials) => credentials.access,
		});

		await expect(
			orchestrator.loginAuthProvider("fake-prompt-oauth"),
		).rejects.toMatchObject({ code: "auth.login_failed" });
		expect(
			orchestrator.modelRegistry.authStorage.has("fake-prompt-oauth"),
		).toBe(false);
	});

	it("rejects unknown auth providers and lists login/logout candidates", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);

		await expect(
			orchestrator.loginAuthProvider("no-such-provider"),
		).rejects.toMatchObject({ code: "auth.provider_unknown" });

		const candidates = orchestrator.listAuthProviderCandidates().providers;
		expect(candidates).toContainEqual(
			expect.objectContaining({ value: "anthropic" }),
		);

		const authStorage = orchestrator.modelRegistry.authStorage;
		await authStorage.set("custom-provider", { type: "api_key", key: "key" });
		expect(
			(await orchestrator.listAuthCredentialCandidates()).providers,
		).toEqual([{ value: "custom-provider", label: "custom-provider" }]);

		await expect(
			orchestrator.logoutAuthProvider("custom-provider"),
		).resolves.toEqual({ providerId: "custom-provider", removed: true });
		expect(authStorage.has("custom-provider")).toBe(false);
		await expect(
			orchestrator.logoutAuthProvider("custom-provider"),
		).resolves.toEqual({ providerId: "custom-provider", removed: false });
		await expect(orchestrator.logoutAuthProvider("  ")).rejects.toMatchObject({
			code: "auth.provider_unknown",
		});
	});

	it("gates extension exec on project trust", async () => {
		const env = new MemoryExecutionEnv();
		const execCalls: string[] = [];
		env.exec = async (command) => {
			execCalls.push(command);
			return ok({ stdout: "exec-ok", stderr: "", exitCode: 0 });
		};
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["sample"],
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: extensionProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: extensionProfile },
				]),
			),
		});
		orchestrator.registerExtension("sample", () => {});
		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const context = runner.createContext("sample");
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await expect(context.actions.exec("echo hi")).resolves.toEqual({
			ok: true,
			value: { stdout: "exec-ok", stderr: "", exitCode: 0 },
		});
		expect(execCalls).toEqual(["echo hi"]);

		await orchestrator.settingManager.setProjectTrusted(false);
		await expect(context.actions.exec("echo hi")).rejects.toMatchObject({
			diagnostic: expect.objectContaining({
				code: "extension.exec_denied",
				extensionId: "sample",
				agentId,
			}),
		});
		expect(execCalls).toEqual(["echo hi"]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.action_failed",
					extensionId: "sample",
					details: expect.objectContaining({ action: "exec" }),
				}),
			}),
		);
	});

	it("forwards raw tool harness events without transformation", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, {
			toolRegistry: createToolRegistry(createToolDefinition("plain")),
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const agentId = await orchestrator.spawnAgent();
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);
		const partial = createAssistantPartial([
			{
				type: "toolCall",
				id: "call-1",
				name: "plain",
				arguments: {},
			},
		]);

		await handleHarnessEvent(agentId, {
			type: "message_update",
			message: partial,
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial,
			},
		});
		await handleHarnessEvent(agentId, {
			type: "message_update",
			message: partial,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"value"',
				partial,
			},
		});
		await handleHarnessEvent(agentId, {
			type: "message_update",
			message: partial,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					type: "toolCall",
					id: "call-1",
					name: "plain",
					arguments: { value: "input" },
				},
				partial,
			},
		});
		await handleHarnessEvent(agentId, {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "plain",
			args: { value: "input" },
		});
		const updateEvent = {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "plain",
			args: { value: "input" },
			partialResult: {
				content: [{ type: "text", text: "partial" }],
				details: { progress: 1 },
			},
		} satisfies AgentHarnessEvent;
		await handleHarnessEvent(agentId, updateEvent);
		await handleHarnessEvent(agentId, {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "plain",
			result: {
				content: [{ type: "text", text: "done" }],
				details: { value: "input" },
			},
			isError: false,
		});

		const rawToolEvents = events.filter(
			(
				event,
			): event is Extract<OrchestratorEvent, { type: "agent_harness_event" }> =>
				event.type === "agent_harness_event",
		);
		expect(rawToolEvents).toHaveLength(6);
		expect(rawToolEvents[4]?.event).toBe(updateEvent);
		expect(rawToolEvents[4]).toEqual({
			type: "agent_harness_event",
			agentId,
			event: updateEvent,
		});
	});

	it("forwards non-tool raw harness events", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const agentId = await orchestrator.spawnAgent();
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);

		await handleHarnessEvent(agentId, { type: "turn_start" });

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "agent_harness_event",
				agentId,
				event: { type: "turn_start" },
			}),
		);
	});

	it("forwards streaming tool-call events without derived refs", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, {
			toolRegistry: createToolRegistry(createToolDefinition("plain")),
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const agentId = await orchestrator.spawnAgent();
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);
		const partial = createAssistantPartial([
			{
				type: "toolCall",
				id: "call-1",
				name: "plain",
				arguments: {},
			},
		]);

		await handleHarnessEvent(agentId, {
			type: "message_update",
			message: partial,
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial,
			},
		});
		await handleHarnessEvent(agentId, {
			type: "message_end",
			message: {
				...partial,
				stopReason: "error",
				errorMessage: "stream failed",
			},
		});
		await handleHarnessEvent(agentId, {
			type: "message_update",
			message: createAssistantPartial([]),
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "{}",
				partial: createAssistantPartial([]),
			},
		});

		const rawEvents = events.filter(
			(
				event,
			): event is Extract<OrchestratorEvent, { type: "agent_harness_event" }> =>
				event.type === "agent_harness_event",
		);
		expect(rawEvents.at(-1)).toMatchObject({
			event: {
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: "{}",
					partial: createAssistantPartial([]),
				},
			},
		});
	});

	it("resolves human requests through the first capable client", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();
		const events: OrchestratorEvent[] = [];
		let handledAgentId: string | undefined;
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerClient({
			id: "human",
			requestHuman: async (request) => {
				handledAgentId = request.agentId;
				return {
					kind: "confirm",
					confirmed: request.title === "Confirm",
				};
			},
		});

		await expect(
			orchestrator.requestHuman({
				source: { kind: "agent", agentId },
				kind: "confirm",
				title: "Confirm",
				message: "Continue?",
			}),
		).resolves.toEqual({ kind: "confirm", confirmed: true });
		expect(handledAgentId).toBe(agentId);
		const requestEvents = events.filter(
			(event) =>
				event.type === "human_request_pending" ||
				event.type === "human_request_resolved",
		);
		expect(requestEvents).toMatchObject([
			{
				type: "human_request_pending",
				agentId,
				request: { agentId },
			},
			{ type: "human_request_resolved", agentId },
		]);
	});

	it("rejects human requests with no capable endpoint", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);

		await expect(
			orchestrator.requestHuman({
				source: { kind: "system" },
				kind: "confirm",
				title: "Confirm",
				message: "Continue?",
			}),
		).rejects.toMatchObject({
			code: "orchestrator.human_request_unhandled",
		});
	});

	it("times out pending human requests", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerClient({
			id: "human",
			requestHuman: async () => new Promise<never>(() => {}),
		});
		const agentId = await orchestrator.spawnAgent();

		await expect(
			orchestrator.requestHuman({
				source: { kind: "agent", agentId },
				kind: "confirm",
				title: "Confirm",
				message: "Continue?",
				timeoutMs: 1,
			}),
		).rejects.toMatchObject({
			code: "orchestrator.human_request_timeout",
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "human_request_timeout",
				agentId,
			}),
		);
	});

	it("aborts pending human requests from the caller signal", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const controller = new AbortController();
		const events: OrchestratorEvent[] = [];
		let clientSignal: AbortSignal | undefined;
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerClient({
			id: "human",
			requestHuman: async (_request, signal) => {
				clientSignal = signal;
				return await new Promise<never>(() => {});
			},
		});
		const agentId = await orchestrator.spawnAgent();

		const requestPromise = orchestrator.requestHuman({
			source: { kind: "agent", agentId },
			kind: "confirm",
			title: "Confirm",
			message: "Continue?",
			signal: controller.signal,
		});
		await Promise.resolve();
		controller.abort();

		await expect(requestPromise).rejects.toMatchObject({
			code: "orchestrator.human_request_aborted",
		});
		expect(clientSignal?.aborted).toBe(true);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "orchestrator.human_request_aborted",
				}),
			}),
		);
	});

	it("rejects pre-aborted human requests before notifying clients", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const controller = new AbortController();
		const events: OrchestratorEvent[] = [];
		let requestHandled = false;
		controller.abort();
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerClient({
			id: "human",
			requestHuman: async () => {
				requestHandled = true;
				return await new Promise<never>(() => {});
			},
		});

		await expect(
			orchestrator.requestHuman({
				source: { kind: "system" },
				kind: "confirm",
				title: "Confirm",
				message: "Continue?",
				signal: controller.signal,
			}),
		).rejects.toMatchObject({
			code: "orchestrator.human_request_aborted",
		});
		expect(requestHandled).toBe(false);
		expect(events.some((event) => event.type === "human_request_pending")).toBe(
			false,
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "orchestrator.human_request_aborted",
				}),
			}),
		);
	});

	it("cancels pending human requests", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const events: OrchestratorEvent[] = [];
		let clientSignal: AbortSignal | undefined;
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerClient({
			id: "human",
			requestHuman: async (_request, signal) => {
				clientSignal = signal;
				return await new Promise<never>(() => {});
			},
		});
		const agentId = await orchestrator.spawnAgent();

		const requestPromise = orchestrator.requestHuman({
			source: { kind: "agent", agentId },
			kind: "confirm",
			title: "Confirm",
			message: "Continue?",
		});
		await Promise.resolve();
		const pending = events.find(
			(
				event,
			): event is Extract<
				OrchestratorEvent,
				{ type: "human_request_pending" }
			> => event.type === "human_request_pending",
		);
		if (!pending) throw new Error("Expected pending human request event.");
		expect(pending.agentId).toBe(agentId);
		expect(pending.request.agentId).toBe(agentId);

		await expect(
			orchestrator.cancelHumanRequest(pending.request.id, "dismissed"),
		).resolves.toBe(true);
		await expect(requestPromise).rejects.toMatchObject({
			code: "orchestrator.human_request_cancelled",
		});
		expect(clientSignal?.aborted).toBe(true);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "human_request_cancelled",
				agentId,
				requestId: pending.request.id,
				reason: "dismissed",
			}),
		);
		await expect(
			orchestrator.cancelHumanRequest(pending.request.id),
		).resolves.toBe(false);
	});
});
