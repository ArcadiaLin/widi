import type {
	AgentHarnessEvent,
	ExecutionEnv,
	ExecutionError,
	FileError,
	FileInfo,
	Result,
	ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import {
	err,
	ok,
	ExecutionError as PiExecutionError,
	FileError as PiFileError,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	AgentOrchestrator,
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
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ConfigValueResolver } from "../../src/core/resolve-config-value.ts";
import { ResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	SettingManager,
	type SettingsLockResult,
	type SettingsScope,
	type SettingsStorage,
} from "../../src/core/setting-manager.ts";
import { ToolRegistry } from "../../src/core/tool-registry.ts";
import type { ToolDefinition } from "../../src/core/tools/types.ts";
import type { ExtendedJsonlSessionMetadata } from "../../src/storage/jsonl-repo.ts";

function expectExtendedMetadata(metadata: {
	id: string;
	createdAt: string;
}): ExtendedJsonlSessionMetadata {
	if (!("path" in metadata) || typeof metadata.path !== "string") {
		throw new Error("Expected persistent JSONL session metadata.");
	}
	return metadata as ExtendedJsonlSessionMetadata;
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

class MemoryExecutionEnv implements ExecutionEnv {
	cwd = "/workspace";
	readonly files = new Map<string, string>();
	readonly dirs = new Set<string>(["/"]);
	cleanupCalls = 0;

	private normalize(path: string): string {
		const absolute = path.startsWith("/") ? path : `${this.cwd}/${path}`;
		return absolute.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
	}

	private dirname(path: string): string {
		const normalized = this.normalize(path);
		const index = normalized.lastIndexOf("/");
		return index <= 0 ? "/" : normalized.slice(0, index);
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(this.normalize(path));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(this.normalize(parts.join("/")));
	}

	async readTextFile(path: string): Promise<Result<string, FileError>> {
		const normalized = this.normalize(path);
		const content = this.files.get(normalized);
		if (content === undefined) {
			return err(
				new PiFileError(
					"not_found",
					`File not found: ${normalized}`,
					normalized,
				),
			);
		}
		return ok(content);
	}

	async readTextLines(
		path: string,
		options?: { maxLines?: number },
	): Promise<Result<string[], FileError>> {
		const result = await this.readTextFile(path);
		if (!result.ok) return result;
		const lines = result.value.split("\n");
		return ok(
			options?.maxLines === undefined
				? lines
				: lines.slice(0, options.maxLines),
		);
	}

	async readBinaryFile(): Promise<Result<Uint8Array, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
	): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		this.dirs.add(this.dirname(normalized));
		this.files.set(
			normalized,
			typeof content === "string" ? content : new TextDecoder().decode(content),
		);
		return ok(undefined);
	}

	async appendFile(
		path: string,
		content: string | Uint8Array,
	): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		const current = this.files.get(normalized) ?? "";
		const next =
			typeof content === "string" ? content : new TextDecoder().decode(content);
		this.files.set(normalized, current + next);
		return ok(undefined);
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const normalized = this.normalize(path);
		if (this.files.has(normalized)) {
			const content = this.files.get(normalized);
			if (content === undefined) {
				return err(
					new PiFileError(
						"not_found",
						`Path not found: ${normalized}`,
						normalized,
					),
				);
			}
			return ok({
				name: normalized.slice(normalized.lastIndexOf("/") + 1),
				path: normalized,
				kind: "file",
				size: content.length,
				mtimeMs: 0,
			});
		}
		if (this.dirs.has(normalized)) {
			return ok({
				name: normalized.slice(normalized.lastIndexOf("/") + 1),
				path: normalized,
				kind: "directory",
				size: 0,
				mtimeMs: 0,
			});
		}
		return err(
			new PiFileError("not_found", `Path not found: ${normalized}`, normalized),
		);
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		const dir = this.normalize(path);
		if (!this.dirs.has(dir)) {
			return err(
				new PiFileError("not_found", `Directory not found: ${dir}`, dir),
			);
		}

		const entries: FileInfo[] = [];
		for (const directory of this.dirs) {
			if (directory === dir || this.dirname(directory) !== dir) continue;
			entries.push({
				name: directory.slice(directory.lastIndexOf("/") + 1),
				path: directory,
				kind: "directory",
				size: 0,
				mtimeMs: 0,
			});
		}
		for (const [filePath, content] of this.files) {
			if (this.dirname(filePath) !== dir) continue;
			entries.push({
				name: filePath.slice(filePath.lastIndexOf("/") + 1),
				path: filePath,
				kind: "file",
				size: content.length,
				mtimeMs: 0,
			});
		}
		return ok(entries);
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		return ok(this.normalize(path));
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		const normalized = this.normalize(path);
		return ok(this.files.has(normalized) || this.dirs.has(normalized));
	}

	async createDir(
		path: string,
		options?: { recursive?: boolean },
	): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		if (
			options?.recursive === false &&
			!this.dirs.has(this.dirname(normalized))
		) {
			return err(
				new PiFileError(
					"not_found",
					`Parent not found: ${this.dirname(normalized)}`,
					normalized,
				),
			);
		}

		let current = "";
		for (const segment of normalized.split("/").filter(Boolean)) {
			current = `${current}/${segment}`;
			this.dirs.add(current);
		}
		return ok(undefined);
	}

	async remove(path: string): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		this.files.delete(normalized);
		this.dirs.delete(normalized);
		return ok(undefined);
	}

	async createTempDir(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async createTempFile(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async exec(
		_command: string,
		_options?: ShellExecOptions,
	): Promise<
		Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
	> {
		return err(new PiExecutionError("shell_unavailable", "not supported"));
	}

	async cleanup(): Promise<void> {
		this.cleanupCalls += 1;
	}
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

const defaultProfile: AgentProfile = {
	id: "main",
	label: "Main Agent",
	systemPrompt: "default prompt",
	persist: true,
};

const restoredProfile: AgentProfile = {
	id: "worker",
	label: "Worker Agent",
	systemPrompt: "worker prompt",
	persist: true,
};

const defaultModel: Model<"openai-completions"> = {
	id: "default-model",
	name: "Default Model",
	provider: "test-provider",
	api: "openai-completions",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const restoredModel: Model<"openai-completions"> = {
	...defaultModel,
	id: "restored-model",
	name: "Restored Model",
};

async function createModelRegistry(
	env: MemoryExecutionEnv,
): Promise<ModelRegistry> {
	const configValueResolver = new ConfigValueResolver(env);
	const authStorage = AuthStorage.inMemory({ configValueResolver });
	const registry = await ModelRegistry.inMemory({
		executionEnv: env,
		authStorage,
		configValueResolver,
	});
	registry.registerProvider("test-provider", {
		baseUrl: "https://example.test/v1",
		apiKey: "test-key",
		api: "openai-completions",
		models: [
			{
				id: restoredModel.id,
				name: restoredModel.name,
				reasoning: false,
				input: ["text"],
				cost: restoredModel.cost,
				contextWindow: restoredModel.contextWindow,
				maxTokens: restoredModel.maxTokens,
			},
		],
	});
	return registry;
}

async function createEmptyModelRegistry(
	env: MemoryExecutionEnv,
): Promise<ModelRegistry> {
	const configValueResolver = new ConfigValueResolver(env);
	const authStorage = AuthStorage.inMemory({ configValueResolver });
	return await ModelRegistry.inMemory({
		executionEnv: env,
		authStorage,
		configValueResolver,
	});
}

async function createOrchestrator(
	env: MemoryExecutionEnv,
	options: {
		enabledProfileIds?: readonly string[];
		profileRegistry?: AgentProfileRegistry;
		defaultProfileId?: string;
		modelRegistry?: ModelRegistry;
		toolRegistry?: ToolRegistry;
	} = {},
): Promise<AgentOrchestrator> {
	return new AgentOrchestrator({
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
		modelRegistry: options.modelRegistry ?? (await createModelRegistry(env)),
		profileRegistry: options.profileRegistry ?? createProfileRegistry(),
		toolRegistry: options.toolRegistry,
		defaultProfileId: options.defaultProfileId ?? defaultProfile.id,
		enabledProfileIds: options.enabledProfileIds,
		defaultModel,
	});
}

function createProfileRegistry(): AgentProfileRegistry {
	return new AgentProfileRegistry(
		InMemoryProfileStorageBackend.fromProfiles([
			{ profile: defaultProfile },
			{ profile: restoredProfile },
		]),
	);
}

function createToolDefinition(
	name: string,
	text: string = name,
): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text }],
			details: undefined,
		}),
	};
}

function createToolRegistry(...tools: ToolDefinition[]): ToolRegistry {
	const registry = new ToolRegistry();
	for (const tool of tools) {
		registry.defineTool(tool, { kind: "core", id: "test" });
	}
	return registry;
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

		await orchestrator.spawnAgentHarness();

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

		const result = await orchestrator.spawnAgentHarness({
			resume: true,
			metadata,
		});

		expect(result.agentId).toBe("worker-agent");
		expect(result.harness.getModel()).toMatchObject({
			provider: restoredModel.provider,
			id: restoredModel.id,
		});
		expect(result.harness.getThinkingLevel()).toBe("medium");
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
			orchestrator.spawnAgentHarness({ resume: true, metadata }),
		).rejects.toMatchObject({
			code: "profile.resolution_failed",
		});

		expect(orchestrator.getAgentStatus("worker-agent")).toBe("unavailable");
		expect(orchestrator.getAgentHarness("worker-agent")).toBeUndefined();
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
			orchestrator.spawnAgentHarness({ resume: true, metadata }),
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
		const { agentId } = await orchestrator.spawnAgentHarness();

		const result = await orchestrator.dispatch({
			kind: "agent.nextTurn",
			source: { kind: "system" },
			agentId,
			text: "next",
		});

		expect(result.ok).toBe(true);
		expect(clientEvents).toContainEqual(
			expect.objectContaining({
				type: "agent_harness_event",
				agentId,
				event: expect.objectContaining({ type: "queue_update" }),
			}),
		);
	});

	it("rejects disabled profiles during create", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, {
			enabledProfileIds: ["worker"],
		});

		await expect(orchestrator.spawnAgentHarness()).rejects.toMatchObject({
			code: "profile.disabled",
		});
	});

	it("rejects persistent profile overrides that change recoverable fields", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);

		await expect(
			orchestrator.spawnAgentHarness({
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
		const commandEvents: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			commandEvents.push(event);
		});
		const { agentId, harness } = await orchestrator.spawnAgentHarness();

		const modelResult = await orchestrator.dispatch({
			kind: "agent.getModel",
			source: { kind: "system" },
			agentId,
		});
		expect(modelResult).toMatchObject({ ok: true });
		if (!modelResult.ok) throw new Error("Expected getModel to succeed.");
		expect(modelResult.value).toMatchObject({ id: defaultModel.id });

		const toolsResult = await orchestrator.dispatch({
			kind: "agent.getTools",
			source: { kind: "system" },
			agentId,
		});
		expect(toolsResult).toMatchObject({ ok: true });
		if (!toolsResult.ok) throw new Error("Expected getTools to succeed.");
		expect(toolsResult.value).toEqual({
			toolNames: ["echo"],
			activeToolNames: ["echo"],
		});

		const setModelResult = await orchestrator.dispatch({
			kind: "agent.setModel",
			source: { kind: "system" },
			agentId,
			model: restoredModel,
		});
		expect(setModelResult.ok).toBe(true);
		expect(harness.getModel()).toMatchObject({ id: restoredModel.id });

		const setActiveToolsResult = await orchestrator.dispatch({
			kind: "agent.setActiveTools",
			source: { kind: "system" },
			agentId,
			toolNames: [],
		});
		expect(setActiveToolsResult.ok).toBe(true);
		expect(orchestrator.getAgentActiveTools(agentId)).toEqual([]);
		const setToolsResult = await orchestrator.dispatch({
			kind: "agent.setTools",
			source: { kind: "system" },
			agentId,
			toolNames: ["echo", "missing", "echo"],
			activeToolNames: ["echo", "ghost"],
		});
		expect(setToolsResult.ok).toBe(true);
		expect(orchestrator.getAgentTools(agentId)).toEqual({
			toolNames: ["echo"],
			activeToolNames: ["echo"],
		});
		expect(harness.getTools()).toEqual([
			expect.objectContaining({ name: "echo" }),
		]);
		expect(commandEvents).toContainEqual(
			expect.objectContaining({
				type: "command_completed",
				command: expect.objectContaining({ kind: "agent.setActiveTools" }),
			}),
		);
	});

	it("exposes lightweight agent record status and inspect snapshots", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, {
			toolRegistry: createToolRegistry(createToolDefinition("echo", "echo")),
		});
		const { agentId } = await orchestrator.spawnAgentHarness();

		expect(orchestrator.getAgentStatus(agentId)).toBe("ready");
		expect(orchestrator.getAgentHarness(agentId)).toBeDefined();
		expect(orchestrator.inspectAgent(agentId)).toMatchObject({
			agentId,
			status: "ready",
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

		const statusResult = await orchestrator.dispatch({
			kind: "agent.getStatus",
			source: { kind: "system" },
			agentId,
		});
		expect(statusResult).toMatchObject({
			ok: true,
			value: "ready",
		});

		const inspectResult = await orchestrator.dispatch({
			kind: "agent.inspect",
			source: { kind: "system" },
			agentId,
		});
		expect(inspectResult).toMatchObject({
			ok: true,
			value: {
				agentId,
				status: "ready",
				hasHarness: true,
			},
		});

		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);

		await handleHarnessEvent(agentId, { type: "turn_start" });
		expect(orchestrator.getAgentStatus(agentId)).toBe("running");

		await handleHarnessEvent(agentId, {
			type: "turn_end",
			message: createAssistantPartial([{ type: "text", text: "done" }]),
			toolResults: [],
		});
		expect(orchestrator.getAgentStatus(agentId)).toBe("idle");
	});

	it("executes runtime input aliases for steer, follow-up, and status", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId, harness } = await orchestrator.spawnAgentHarness();
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		(harness as unknown as { phase: "turn" }).phase = "turn";

		await expect(
			orchestrator.dispatch({
				kind: "agent.input",
				source: { kind: "human" },
				agentId,
				text: "/steer keep going",
			}),
		).resolves.toMatchObject({ ok: true });
		await expect(
			orchestrator.dispatch({
				kind: "agent.input",
				source: { kind: "human" },
				agentId,
				text: "/follow-up summarize next",
			}),
		).resolves.toMatchObject({ ok: true });
		await expect(
			orchestrator.dispatch({
				kind: "agent.input",
				source: { kind: "human" },
				agentId,
				text: "/status",
			}),
		).resolves.toMatchObject({ ok: true, value: "ready" });

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

	it("rejects empty steer and follow-up input aliases", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();

		await expect(
			orchestrator.dispatch({
				kind: "agent.input",
				source: { kind: "human" },
				agentId,
				text: "/steer",
			}),
		).resolves.toMatchObject({
			ok: false,
			diagnostic: {
				message: "Input command /steer requires text.",
			},
		});
		await expect(
			orchestrator.dispatch({
				kind: "agent.input",
				source: { kind: "human" },
				agentId,
				text: "/follow-up",
			}),
		).resolves.toMatchObject({
			ok: false,
			diagnostic: {
				message: "Input command /follow-up requires text.",
			},
		});
	});

	it("starts a new empty session from the current agent", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();

		const result = await orchestrator.dispatch({
			kind: "agent.input",
			source: { kind: "human" },
			agentId,
			text: "/new",
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				agentId: "main-agent-2",
				snapshot: {
					agentId: "main-agent-2",
					status: "ready",
					hasHarness: true,
					profile: {
						reference: {
							id: defaultProfile.id,
							label: defaultProfile.label,
						},
					},
					model: expect.objectContaining({ id: defaultModel.id }),
				},
			},
		});
		expect(orchestrator.getAgentStatus(agentId)).toBe("ready");
	});

	it("lists and resumes sessions through runtime commands", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();
		const session = await orchestrator.sessionManager.createAgentSession({
			agentId: "worker-agent",
			agentProfile: restoredProfile,
		});
		await session.appendModelChange(restoredModel.provider, restoredModel.id);
		await session.appendThinkingLevelChange("medium");
		const metadata = expectExtendedMetadata(await session.getMetadata());

		await expect(
			orchestrator.dispatch({
				kind: "agent.listSessions",
				source: { kind: "system" },
			}),
		).resolves.toMatchObject({
			ok: true,
			value: {
				sessions: expect.arrayContaining([
					expect.objectContaining({
						id: "worker-agent",
						path: metadata.path,
						profile: { id: restoredProfile.id, label: restoredProfile.label },
					}),
					expect.objectContaining({ id: agentId }),
				]),
			},
		});
		await expect(
			orchestrator.dispatch({
				kind: "agent.input",
				source: { kind: "human" },
				agentId,
				text: "/resume",
			}),
		).resolves.toMatchObject({
			ok: true,
			value: {
				sessions: expect.arrayContaining([
					expect.objectContaining({ id: "worker-agent" }),
					expect.objectContaining({ id: agentId }),
				]),
			},
		});

		const result = await orchestrator.dispatch({
			kind: "agent.input",
			source: { kind: "human" },
			agentId,
			text: `/resume ${metadata.path}`,
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				agentId: "worker-agent",
				snapshot: {
					agentId: "worker-agent",
					status: "ready",
					model: expect.objectContaining({ id: restoredModel.id }),
				},
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
		const { agentId } = await orchestrator.spawnAgentHarness();

		await expect(
			orchestrator.dispatch({
				kind: "agent.input",
				source: { kind: "human" },
				agentId,
				text: "/resume same",
			}),
		).resolves.toMatchObject({
			ok: false,
			diagnostic: {
				message: "Ambiguous agent session reference: same",
			},
		});
	});

	it("lists runtime agents and persisted sessions through input aliases", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();

		await expect(
			orchestrator.dispatch({
				kind: "agent.input",
				source: { kind: "human" },
				agentId,
				text: "/agent",
			}),
		).resolves.toMatchObject({
			ok: true,
			value: {
				agents: [
					expect.objectContaining({
						agentId,
						status: "ready",
						hasHarness: true,
					}),
				],
			},
		});
		await expect(
			orchestrator.dispatch({
				kind: "agent.input",
				source: { kind: "human" },
				agentId,
				text: "/session",
			}),
		).resolves.toMatchObject({
			ok: true,
			value: {
				sessions: [
					expect.objectContaining({
						id: agentId,
						profile: { id: defaultProfile.id, label: defaultProfile.label },
					}),
				],
			},
		});
	});

	it("names and inspects the current session tree through input aliases", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();
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
			orchestrator.dispatch({
				kind: "agent.input",
				source: { kind: "human" },
				agentId,
				text: "/name Planning Session",
			}),
		).resolves.toMatchObject({
			ok: true,
			value: {
				name: "Planning Session",
			},
		});
		await expect(
			orchestrator.dispatch({
				kind: "agent.input",
				source: { kind: "human" },
				agentId,
				text: "/tree",
			}),
		).resolves.toMatchObject({
			ok: true,
			value: {
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
			},
		});
	});

	it("navigates the session tree when /tree receives an entry id", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();
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
			orchestrator.dispatch({
				kind: "agent.input",
				source: { kind: "human" },
				agentId,
				text: `/tree ${userEntryId}`,
			}),
		).resolves.toMatchObject({
			ok: true,
			value: {
				cancelled: false,
				editorText: "edit this",
			},
		});
		await expect(orchestrator.getAgentSession(agentId)).resolves.toMatchObject({
			leafId: null,
			pathToRoot: [],
		});
	});

	it("forks the current session into an idle runtime agent", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();
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

		const result = await orchestrator.dispatch({
			kind: "agent.input",
			source: { kind: "human" },
			agentId,
			text: `/fork ${targetEntryId}`,
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				agentId: expect.not.stringMatching(`^${agentId}$`),
				snapshot: {
					status: "ready",
					hasHarness: true,
					model: expect.objectContaining({ id: defaultModel.id }),
				},
			},
		});
		if (
			!result.ok ||
			!result.value ||
			typeof result.value !== "object" ||
			!("agentId" in result.value)
		) {
			throw new Error("Expected fork command result.");
		}
		const forkedAgentId = result.value.agentId;
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
		expect(orchestrator.getAgentStatus(agentId)).toBe("ready");
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
		orchestrator.registerExtensionFactory("stateful", () => {});
		const { agentId } = await orchestrator.spawnAgentHarness();
		const runner = orchestrator.agents.get(agentId)?.extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const commandContext = runner.createCommandContext("stateful");

		const disposeResult = await orchestrator.dispatch({
			kind: "agent.dispose",
			source: { kind: "system" },
			agentId,
			reason: "test cleanup",
		});

		expect(disposeResult).toMatchObject({ ok: true });
		expect(orchestrator.getAgentStatus(agentId)).toBe("disposed");
		expect(orchestrator.getAgentHarness(agentId)).toBeUndefined();
		expect(orchestrator.inspectAgent(agentId)).toMatchObject({
			agentId,
			status: "disposed",
			hasHarness: false,
			extensionIds: ["stateful"],
		});
		await expect(commandContext.waitForIdle()).rejects.toThrow(
			"Agent has been disposed.",
		);
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
		const { agentId: firstAgentId } = await orchestrator.spawnAgentHarness();
		const { agentId: secondAgentId } = await orchestrator.spawnAgentHarness();

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
		const { agentId: firstAgentId } = await orchestrator.spawnAgentHarness();
		const { agentId: secondAgentId } = await orchestrator.spawnAgentHarness();
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

		const { agentId } = await orchestrator.spawnAgentHarness();

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

		const { agentId } = await orchestrator.spawnAgentHarness({
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

		const { agentId } = await orchestrator.spawnAgentHarness();

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
		orchestrator.registerExtensionFactory("sample", (api) => {
			api.registerTool(createToolDefinition("sampleTool", "sample"));
		});

		const { agentId: extensionAgentId } =
			await orchestrator.spawnAgentHarness();
		const { agentId: plainAgentId } = await orchestrator.spawnAgentHarness({
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
				commands: [],
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
				commands: [],
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
		orchestrator.registerExtensionFactory("sample", (api) => {
			api.observe("tool_lifecycle_event", () => {});
			api.intercept("context", (event) => ({ messages: event.messages }));
			api.registerCommand({
				inputInvoke: { name: "sample", description: "Sample command" },
				handler: () => {},
			});
			api.registerTool(createToolDefinition("sampleTool", "sample"));
			api.patchTool("base", {
				description: "patched base",
				aroundExecute: async (next, toolCallId, params, context) =>
					await next(toolCallId, params, context),
			});
		});

		const { agentId } = await orchestrator.spawnAgentHarness();

		expect(orchestrator.inspectAgent(agentId).extensionSnapshot).toEqual({
			extensionIds: ["sample"],
			extensions: [{ id: "sample", source: { kind: "factory" } }],
			hooks: [
				{
					kind: "observe",
					extensionId: "sample",
					eventName: "tool_lifecycle_event",
				},
				{
					kind: "intercept",
					extensionId: "sample",
					eventName: "context",
				},
			],
			commands: [
				{
					extensionId: "sample",
					inputInvoke: {
						name: "sample",
						description: "Sample command",
					},
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
		orchestrator.registerExtensionFactory("sample", (api) => {
			api.registerTool(createToolDefinition("sampleTool", "sample"));
		});

		const { agentId } = await orchestrator.spawnAgentHarness();

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

	it("executes extension input commands through agent.input", async () => {
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
		orchestrator.registerExtensionFactory("sample", (api) => {
			api.registerCommand({
				inputInvoke: {
					name: "mark",
					description: "Append a marker entry",
					argumentHint: "<text>",
				},
				handler: async (args, context) => {
					await context.session.appendEntry("marker", { args });
				},
			});
		});
		const { agentId } = await orchestrator.spawnAgentHarness();

		const result = await orchestrator.dispatch({
			kind: "agent.input",
			source: { kind: "human" },
			agentId,
			text: "/mark hello world",
		});

		expect(result).toMatchObject({
			ok: true,
			value: undefined,
		});
		expect(
			await orchestrator.sessionManager.findExtensionCustomEntries(
				agentId,
				"sample",
				"marker",
			),
		).toMatchObject([
			{
				type: "marker",
				data: { args: "hello world" },
			},
		]);
		expect(orchestrator.getAgentInputCommands(agentId)).toEqual([
			expect.objectContaining({
				inputInvoke: expect.objectContaining({ name: "abort" }),
				source: { kind: "builtin", commandKind: "agent.abort" },
			}),
			expect.objectContaining({
				inputInvoke: expect.objectContaining({ name: "compact" }),
				source: { kind: "builtin", commandKind: "agent.compact" },
			}),
			expect.objectContaining({
				inputInvoke: expect.objectContaining({ name: "follow-up" }),
				source: { kind: "builtin", commandKind: "agent.followUp" },
			}),
			expect.objectContaining({
				inputInvoke: expect.objectContaining({ name: "fork" }),
				source: { kind: "builtin", commandKind: "agent.fork" },
			}),
			expect.objectContaining({
				inputInvoke: expect.objectContaining({ name: "inspect" }),
				source: { kind: "builtin", commandKind: "agent.inspect" },
			}),
			expect.objectContaining({
				inputInvoke: expect.objectContaining({ name: "agent" }),
				source: { kind: "builtin", commandKind: "agent.listAgents" },
			}),
			expect.objectContaining({
				inputInvoke: expect.objectContaining({ name: "name" }),
				source: { kind: "builtin", commandKind: "agent.setSessionName" },
			}),
			expect.objectContaining({
				inputInvoke: expect.objectContaining({ name: "new" }),
				source: { kind: "builtin", commandKind: "agent.new" },
			}),
			expect.objectContaining({
				inputInvoke: expect.objectContaining({ name: "reload" }),
				source: { kind: "builtin", commandKind: "extension.reload" },
			}),
			expect.objectContaining({
				inputInvoke: expect.objectContaining({ name: "resume" }),
				source: { kind: "builtin", commandKind: "agent.resume" },
			}),
			expect.objectContaining({
				inputInvoke: expect.objectContaining({ name: "session" }),
				source: { kind: "builtin", commandKind: "agent.listSessions" },
			}),
			expect.objectContaining({
				inputInvoke: expect.objectContaining({ name: "status" }),
				source: { kind: "builtin", commandKind: "agent.getStatus" },
			}),
			expect.objectContaining({
				inputInvoke: expect.objectContaining({ name: "steer" }),
				source: { kind: "builtin", commandKind: "agent.steer" },
			}),
			expect.objectContaining({
				inputInvoke: expect.objectContaining({ name: "tree" }),
				source: { kind: "builtin", commandKind: "agent.getSessionTree" },
			}),
			{
				inputInvoke: {
					name: "mark",
					description: "Append a marker entry",
					argumentHint: "<text>",
				},
				source: { kind: "extension", extensionId: "sample" },
			},
		]);
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
		orchestrator.registerExtensionFactory("broken", () => {
			throw new Error("activation exploded");
		});

		await expect(orchestrator.spawnAgentHarness()).rejects.toThrow(
			"activation exploded",
		);

		const agentId = "extension-profile";
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
		orchestrator.registerExtensionFactory("sample", (api) => {
			api.registerTool(createToolDefinition("alpha", "alpha"));
		});
		const { agentId } = await orchestrator.spawnAgentHarness();
		const oldRunner = orchestrator.agents.get(agentId)?.extensionRunner;
		if (!oldRunner) throw new Error("Expected extension runner.");
		const oldContext = oldRunner.createCommandContext("sample");
		orchestrator.registerExtensionFactory("sample", (api) => {
			api.registerTool(createToolDefinition("alpha", "alpha"));
			api.registerTool(createToolDefinition("beta", "beta"));
		});

		const result = await orchestrator.dispatch({
			kind: "extension.reload",
			source: { kind: "system" },
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("Expected reload to succeed.");
		expect(result.value).toMatchObject({
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
		await expect(oldContext.waitForIdle()).rejects.toThrow(
			"Extension runtime has been reloaded.",
		);
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
		orchestrator.registerExtensionFactory("sample", (api) => {
			api.registerTool(createToolDefinition("alpha", "alpha"));
		});
		const { agentId } = await orchestrator.spawnAgentHarness();
		await orchestrator.setAgentActiveTools(agentId, ["alpha"]);
		orchestrator.registerExtensionFactory("sample", (api) => {
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
		orchestrator.registerExtensionFactory("sample", (api) => {
			api.registerTool(createToolDefinition("alpha", "alpha"));
		});
		const { agentId } = await orchestrator.spawnAgentHarness();
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);
		await handleHarnessEvent(agentId, { type: "turn_start" });
		orchestrator.registerExtensionFactory("sample", (api) => {
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
		orchestrator.registerExtensionFactory("patcher", (api) => {
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

		const { agentId: extensionAgentId, harness: extensionHarness } =
			await orchestrator.spawnAgentHarness();
		const { agentId: plainAgentId, harness: plainHarness } =
			await orchestrator.spawnAgentHarness({ profileId: plainProfile.id });
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

		await expect(patchedPlain.execute("call-1", {})).resolves.toEqual({
			content: [{ type: "text", text: "patched" }],
			details: { source: "patcher" },
		});
		await expect(unpatchedPlain.execute("call-2", {})).resolves.toEqual({
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

		const { agentId } = await orchestrator.spawnAgentHarness();

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

	it("routes tool lifecycle events to scoped extension handlers", async () => {
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
			toolRegistry: createToolRegistry(createToolDefinition("plain")),
		});
		orchestrator.registerExtensionFactory("observer", (api) => {
			api.observe("tool_lifecycle_event", (event, context) => {
				const tools = context.actions.getAgentTools(context.agentId);
				observed.push(
					`${context.extensionId}:${context.profileId}:${event.event.type}:${tools.toolNames.join(",")}`,
				);
			});
		});
		const { agentId } = await orchestrator.spawnAgentHarness();
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);

		await handleHarnessEvent(agentId, {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "plain",
			args: {},
		});

		expect(observed).toEqual([
			`observer:${extensionProfile.id}:execution_started:plain`,
		]);
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
		orchestrator.registerExtensionFactory("broken", (api) => {
			api.observe("agent_harness_event", () => {
				throw new Error("observer exploded");
			});
		});
		orchestrator.registerExtensionFactory("healthy", (api) => {
			api.observe("agent_harness_event", () => {
				observed.push("healthy");
			});
		});

		const { agentId } = await orchestrator.spawnAgentHarness();
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
		orchestrator.registerExtensionFactory("first", (api) => {
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
		orchestrator.registerExtensionFactory("second", (api) => {
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

		const { harness } = await orchestrator.spawnAgentHarness();
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

	it("publishes diagnostics for interceptor failures and stops the hook chain", async () => {
		const env = new MemoryExecutionEnv();
		const extensionProfile: AgentProfile = {
			...defaultProfile,
			id: "extension-profile",
			label: "Extension Profile",
			persist: false,
			extensions: ["broken", "healthy"],
		};
		let healthyCalled = false;
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
		orchestrator.registerExtensionFactory("broken", (api) => {
			api.intercept("context", () => {
				throw new Error("interceptor exploded");
			});
		});
		orchestrator.registerExtensionFactory("healthy", (api) => {
			api.intercept("context", (event) => {
				healthyCalled = true;
				return { messages: event.messages };
			});
		});

		const { agentId, harness } = await orchestrator.spawnAgentHarness();
		const handlers = (
			harness as unknown as {
				handlers: Map<string, Set<(event: unknown) => Promise<unknown>>>;
			}
		).handlers;
		const handler = Array.from(handlers.get("context") ?? [])[0];
		if (!handler) throw new Error("Missing context hook.");

		await expect(
			handler({
				type: "context",
				messages: [{ role: "user", content: "base", timestamp: 0 }],
			}),
		).resolves.toBeUndefined();

		expect(healthyCalled).toBe(false);
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
	});

	it("binds extension runner core and command contexts after harness creation", async () => {
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
		orchestrator.registerExtensionFactory("observer", (api) => {
			api.observe("agent_harness_event", (_event, context) => {
				observed.push(
					`${context.extensionId}:${context.profileId}:${context.isIdle()}:${context.actions.getAgentTools(context.agentId).toolNames.length}`,
				);
			});
		});

		const { agentId } = await orchestrator.spawnAgentHarness();
		const runner = orchestrator.agents.get(agentId)?.extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const commandContext = runner.createCommandContext("observer");
		await commandContext.waitForIdle();
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);

		await handleHarnessEvent(agentId, { type: "turn_start" });

		expect(commandContext.extensionId).toBe("observer");
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
		orchestrator.registerExtensionFactory("stateful", (api) => {
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

		const { agentId } = await orchestrator.spawnAgentHarness();
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
		orchestrator.registerExtensionFactory("stateful", (api) => {
			api.observe("agent_harness_event", async (_event, context) => {
				await context.session.appendEntry("bad/type", {});
			});
		});

		const { agentId } = await orchestrator.spawnAgentHarness();
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

	it("emits normalized tool lifecycle events from harness events", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, {
			toolRegistry: createToolRegistry(createToolDefinition("plain")),
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const { agentId } = await orchestrator.spawnAgentHarness();
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
		await handleHarnessEvent(agentId, {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "plain",
			args: { value: "input" },
			partialResult: {
				content: [{ type: "text", text: "partial" }],
				details: { progress: 1 },
			},
		});
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

		const lifecycleEvents = events.filter(
			(event) => event.type === "tool_lifecycle_event",
		);
		expect(events[events.length - 2]).toMatchObject({
			type: "agent_harness_event",
			agentId,
			event: { type: "tool_execution_end" },
		});
		expect(lifecycleEvents).toEqual([
			expect.objectContaining({
				event: {
					type: "tool_call_created",
					contentIndex: 0,
					toolCallId: "call-1",
					toolName: "plain",
				},
			}),
			expect.objectContaining({
				event: {
					type: "arguments_delta",
					contentIndex: 0,
					delta: '{"value"',
					toolCallId: "call-1",
					toolName: "plain",
				},
			}),
			expect.objectContaining({
				event: {
					type: "arguments_ready",
					contentIndex: 0,
					toolCallId: "call-1",
					toolName: "plain",
					args: { value: "input" },
				},
			}),
			expect.objectContaining({
				event: {
					type: "execution_started",
					toolCallId: "call-1",
					toolName: "plain",
					args: { value: "input" },
				},
			}),
			expect.objectContaining({
				event: {
					type: "execution_update",
					toolCallId: "call-1",
					toolName: "plain",
					partialResult: {
						content: [{ type: "text", text: "partial" }],
						details: { progress: 1 },
					},
				},
			}),
			expect.objectContaining({
				event: {
					type: "execution_result",
					toolCallId: "call-1",
					toolName: "plain",
					result: {
						content: [{ type: "text", text: "done" }],
						details: { value: "input" },
					},
					isError: false,
				},
			}),
		]);
	});

	it("forwards raw events without lifecycle facts when not tool-related", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const { agentId } = await orchestrator.spawnAgentHarness();
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
		expect(events.some((event) => event.type === "tool_lifecycle_event")).toBe(
			false,
		);
	});

	it("clears streaming tool-call refs when a message ends", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env, {
			toolRegistry: createToolRegistry(createToolDefinition("plain")),
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const { agentId } = await orchestrator.spawnAgentHarness();
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

		const lifecycleEvents = events.filter(
			(event) => event.type === "tool_lifecycle_event",
		);
		expect(lifecycleEvents.at(-1)).toEqual(
			expect.objectContaining({
				event: {
					type: "arguments_delta",
					contentIndex: 0,
					delta: "{}",
					toolCallId: undefined,
					toolName: undefined,
				},
			}),
		);
	});

	it("rejects invalid commands without throwing", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();

		const idleSteer = await orchestrator.dispatch({
			kind: "agent.steer",
			source: { kind: "system" },
			agentId,
			text: "steer",
		});
		expect(idleSteer).toMatchObject({
			ok: false,
			diagnostic: {
				code: "orchestrator.command_failed",
				agentId,
			},
		});

		const missingAgent = await orchestrator.dispatch({
			kind: "agent.getModel",
			source: { kind: "system" },
			agentId: "missing",
		});
		expect(missingAgent).toMatchObject({
			ok: false,
			diagnostic: {
				code: "orchestrator.command_failed",
				agentId: "missing",
			},
		});
	});

	it("resolves human requests through the first capable client", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		orchestrator.registerClient({
			id: "human",
			requestHuman: async (request) => ({
				kind: "confirm",
				confirmed: request.title === "Confirm",
			}),
		});

		await expect(
			orchestrator.requestHuman({
				source: { kind: "system" },
				kind: "confirm",
				title: "Confirm",
				message: "Continue?",
			}),
		).resolves.toEqual({ kind: "confirm", confirmed: true });
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

		await expect(
			orchestrator.requestHuman({
				source: { kind: "system" },
				kind: "confirm",
				title: "Confirm",
				message: "Continue?",
				timeoutMs: 1,
			}),
		).rejects.toMatchObject({
			code: "orchestrator.human_request_timeout",
		});
		expect(events).toContainEqual(
			expect.objectContaining({ type: "human_request_timeout" }),
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

		const requestPromise = orchestrator.requestHuman({
			source: { kind: "system" },
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
				requestId: pending.request.id,
				reason: "dismissed",
			}),
		);
		await expect(
			orchestrator.cancelHumanRequest(pending.request.id),
		).resolves.toBe(false);
	});
});
