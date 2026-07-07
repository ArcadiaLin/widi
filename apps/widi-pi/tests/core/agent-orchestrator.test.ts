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
import type { Command, CommandInvocation } from "../../src/core/command.ts";
import type { OrchestratorDiagnostic } from "../../src/core/diagnostics.ts";
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

const reasoningModel: Model<"openai-completions"> = {
	...defaultModel,
	id: "reasoning-model",
	name: "Reasoning Model",
	reasoning: true,
	thinkingLevelMap: { minimal: null, high: "high" },
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
			{
				id: reasoningModel.id,
				name: reasoningModel.name,
				reasoning: true,
				thinkingLevelMap: reasoningModel.thinkingLevelMap,
				input: ["text"],
				cost: reasoningModel.cost,
				contextWindow: reasoningModel.contextWindow,
				maxTokens: reasoningModel.maxTokens,
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

type CompleteCommandArguments = (options: {
	agentId: string;
	commandId: string;
	binding: { command: Command; execute(args: string): Promise<unknown> };
	invocation: CommandInvocation;
	argumentPrefix: string;
}) => Promise<
	| { ok: true; argument: string }
	| { ok: false; diagnostic: OrchestratorDiagnostic }
>;

// Unit fixture for _completeCommandArguments: no built-in declares both
// required and complete() yet, so the candidate branches are exercised
// against a synthetic binding until a real consumer lands.
function createArgumentsCompletionFixture(
	orchestrator: AgentOrchestrator,
	complete?: NonNullable<Command["arguments"]>["complete"],
): {
	completeCommandArguments: CompleteCommandArguments;
	binding: { command: Command; execute(args: string): Promise<unknown> };
	invocation: CommandInvocation;
} {
	const command: Command = {
		name: "demo",
		placement: "line",
		trigger: "/",
		argumentHint: "<value>",
		source: { kind: "built-in" },
		arguments: { required: true, complete },
	};
	return {
		completeCommandArguments: (
			orchestrator as unknown as {
				_completeCommandArguments: CompleteCommandArguments;
			}
		)._completeCommandArguments.bind(orchestrator),
		binding: { command, execute: async () => undefined },
		invocation: {
			name: command.name,
			trigger: command.trigger,
			argument: "",
			source: command.source,
			placement: command.placement,
		},
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

		await orchestrator.nextTurnAgent(agentId, "next");
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
		expect(harness.getThinkingLevel()).toBe("high");

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
		expect(commandEvents).not.toContainEqual(
			expect.objectContaining({ type: "command_completed" }),
		);
	});

	it("rejects agent thinking level changes unsupported by the current model", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId, harness } = await orchestrator.spawnAgentHarness();

		await expect(
			orchestrator.setAgentThinkingLevel(agentId, "medium"),
		).rejects.toMatchObject({
			code: "model.thinking_not_supported",
			diagnostic: expect.objectContaining({
				provider: defaultModel.provider,
				modelId: defaultModel.id,
			}),
		});
		expect(harness.getThinkingLevel()).toBe("off");

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
		expect(harness.getThinkingLevel()).toBe("off");
	});

	it("executes model and thinking settings commands through agent input", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId, harness } = await orchestrator.spawnAgentHarness();

		await expect(orchestrator.inputAgent(agentId, "/model")).resolves.toEqual(
			expect.objectContaining({
				kind: "command",
				name: "model",
				value: {
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
				},
			}),
		);

		await expect(
			orchestrator.inputAgent(agentId, "/thinking"),
		).resolves.toEqual(
			expect.objectContaining({
				kind: "failed",
				diagnostic: expect.objectContaining({
					code: "model.thinking_not_supported",
					modelId: defaultModel.id,
				}),
			}),
		);

		await expect(
			orchestrator.inputAgent(
				agentId,
				`/model:${reasoningModel.provider}/${reasoningModel.id}`,
			),
		).resolves.toEqual(
			expect.objectContaining({
				kind: "command",
				name: "model",
				value: expect.objectContaining({
					id: reasoningModel.id,
					provider: reasoningModel.provider,
				}),
			}),
		);
		expect(harness.getModel()).toMatchObject({ id: reasoningModel.id });

		await expect(
			orchestrator.inputAgent(agentId, "/thinking"),
		).resolves.toEqual(
			expect.objectContaining({
				kind: "command",
				name: "thinking",
				value: {
					levels: [
						{ value: "off", label: "off" },
						{ value: "low", label: "low" },
						{ value: "medium", label: "medium" },
						{ value: "high", label: "high" },
					],
				},
			}),
		);

		await expect(
			orchestrator.inputAgent(agentId, "/thinking:high"),
		).resolves.toEqual(
			expect.objectContaining({
				kind: "command",
				name: "thinking",
				value: { level: "high" },
			}),
		);
		expect(harness.getThinkingLevel()).toBe("high");
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

		expect(orchestrator.getAgentStatus(agentId)).toBe("ready");

		expect(orchestrator.inspectAgent(agentId)).toMatchObject({
			agentId,
			status: "ready",
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
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);
		await handleHarnessEvent(agentId, { type: "turn_start" });

		await expect(
			orchestrator.inputAgent(agentId, "/steer:keep going"),
		).resolves.toMatchObject({ kind: "command" });
		await expect(
			orchestrator.inputAgent(agentId, "/follow-up:summarize next"),
		).resolves.toMatchObject({ kind: "command" });
		await expect(
			orchestrator.inputAgent(agentId, "/status"),
		).resolves.toMatchObject({ kind: "command", value: "running" });

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

	it("completes missing required command arguments before execution", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId, harness } = await orchestrator.spawnAgentHarness();
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerClient({
			id: "human",
			requestHuman: async (request) => {
				expect(request).toMatchObject({
					kind: "argumentsCompletion",
					title: "Complete /steer arguments",
					message: "Command /steer requires an argument.",
					placeholder: "<text>",
					allowFreeInput: true,
					payload: {
						commandId: "orchestrator-command-1",
						command: {
							name: "steer",
							trigger: "/",
							argument: "",
							source: { kind: "built-in" },
							placement: "line",
						},
						argumentHint: "<text>",
						argumentPrefix: "",
						candidates: [],
					},
				});
				return { kind: "input", value: "keep going" };
			},
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

		await expect(
			orchestrator.inputAgent(agentId, "/steer"),
		).resolves.toMatchObject({ kind: "command", name: "steer" });
		expect(
			events
				.filter(
					(event) =>
						event.type === "command_detected" ||
						event.type === "human_request_pending" ||
						event.type === "human_request_resolved" ||
						event.type === "command_accepted" ||
						event.type === "command_completed",
				)
				.map((event) => event.type),
		).toEqual([
			"command_detected",
			"human_request_pending",
			"human_request_resolved",
			"command_accepted",
			"command_completed",
		]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "command_detected",
				command: expect.objectContaining({ argument: "" }),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "command_accepted",
				command: expect.objectContaining({ argument: "keep going" }),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "command_completed",
				command: expect.objectContaining({ argument: "keep going" }),
			}),
		);
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
	});

	it("rejects missing required command arguments when no client can complete them", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await expect(
			orchestrator.inputAgent(agentId, "/follow-up"),
		).resolves.toMatchObject({
			kind: "rejected",
			diagnostic: {
				code: "command.arguments_required",
				message: "Command /follow-up requires an argument.",
			},
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "command_rejected",
				diagnostic: expect.objectContaining({
					code: "command.arguments_required",
					details: expect.objectContaining({
						completionFailureCode: "orchestrator.human_request_unhandled",
						requestId: "human-request-1",
					}),
				}),
			}),
		);
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "command_accepted" }),
		);
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "command_failed" }),
		);
	});

	it("rejects blank completed command arguments before execution", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		orchestrator.registerClient({
			id: "human",
			requestHuman: async () => ({ kind: "input", value: "  " }),
		});

		await expect(
			orchestrator.inputAgent(agentId, "/name"),
		).resolves.toMatchObject({
			kind: "rejected",
			diagnostic: {
				code: "command.arguments_required",
				message: "Command /name requires an argument.",
				details: {
					completionFailureCode: "command.arguments_completion_empty",
					responseKind: "input",
				},
			},
		});
		expect(events).toContainEqual(
			expect.objectContaining({ type: "command_rejected" }),
		);
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "command_accepted" }),
		);
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "command_failed" }),
		);
	});

	it("rejects cancelled argument completion before execution", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const pendingRequest = new Promise<
			Extract<OrchestratorEvent, { type: "human_request_pending" }>
		>((resolve) => {
			orchestrator.subscribe((event) => {
				if (event.type === "human_request_pending") resolve(event);
			});
		});
		orchestrator.registerClient({
			id: "human",
			requestHuman: async () => await new Promise<never>(() => {}),
		});

		const result = orchestrator.inputAgent(agentId, "/follow-up");
		const pending = await pendingRequest;

		await expect(
			orchestrator.cancelHumanRequest(pending.request.id, "dismissed"),
		).resolves.toBe(true);
		await expect(result).resolves.toMatchObject({
			kind: "rejected",
			diagnostic: {
				code: "command.arguments_required",
				details: expect.objectContaining({
					completionFailureCode: "orchestrator.human_request_cancelled",
					requestId: pending.request.id,
				}),
			},
		});
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "command_accepted" }),
		);
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "command_failed" }),
		);
	});

	it("rejects completed command arguments when the gateway went stale", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId, harness } = await orchestrator.spawnAgentHarness();
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const handleHarnessEvent = (
			orchestrator as unknown as {
				_handleAgentHarnessEvent(
					agentId: string,
					event: AgentHarnessEvent,
				): Promise<void>;
			}
		)._handleAgentHarnessEvent.bind(orchestrator);
		(harness as unknown as { phase: "turn" }).phase = "turn";
		await handleHarnessEvent(agentId, { type: "turn_start" });
		orchestrator.registerClient({
			id: "human",
			requestHuman: async () => {
				// The turn ends while the human is completing the argument.
				await handleHarnessEvent(agentId, {
					type: "turn_end",
					message: createAssistantPartial([{ type: "text", text: "done" }]),
					toolResults: [],
				});
				return { kind: "input", value: "keep going" };
			},
		});

		await expect(
			orchestrator.inputAgent(agentId, "/steer"),
		).resolves.toMatchObject({
			kind: "rejected",
			diagnostic: {
				code: "command.not_available",
				message: "Command /steer requires a running agent (status: idle).",
			},
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "command_rejected",
				command: expect.objectContaining({ argument: "keep going" }),
			}),
		);
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "command_accepted" }),
		);
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "command_failed" }),
		);
	});

	it("offers completion candidates and accepts a select response", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();
		const { completeCommandArguments, binding, invocation } =
			createArgumentsCompletionFixture(orchestrator, async (context) => {
				expect(context.agentId).toBe(agentId);
				expect(context.argumentPrefix).toBe("");
				expect(context.orchestrator).toBe(orchestrator);
				return [
					{ value: "alpha", label: "Alpha", description: "First candidate" },
					{ value: "beta" },
				];
			});
		orchestrator.registerClient({
			id: "human",
			requestHuman: async (request) => {
				expect(request).toMatchObject({
					kind: "argumentsCompletion",
					options: ["alpha", "beta"],
					placeholder: "<value>",
					allowFreeInput: true,
					payload: {
						command: invocation,
						argumentHint: "<value>",
						argumentPrefix: "",
						candidates: [
							{
								value: "alpha",
								label: "Alpha",
								description: "First candidate",
							},
							{ value: "beta" },
						],
					},
				});
				return { kind: "select", value: "beta" };
			},
		});

		await expect(
			completeCommandArguments({
				agentId,
				commandId: "orchestrator-command-test",
				binding,
				invocation,
				argumentPrefix: "",
			}),
		).resolves.toEqual({ ok: true, argument: "beta" });
	});

	it("treats select responses without a value as missing completion", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();
		const { completeCommandArguments, binding, invocation } =
			createArgumentsCompletionFixture(orchestrator, async () => [
				{ value: "alpha" },
			]);
		orchestrator.registerClient({
			id: "human",
			requestHuman: async () => ({ kind: "select", value: undefined }),
		});

		await expect(
			completeCommandArguments({
				agentId,
				commandId: "orchestrator-command-test",
				binding,
				invocation,
				argumentPrefix: "",
			}),
		).resolves.toMatchObject({
			ok: false,
			diagnostic: {
				code: "command.arguments_required",
				details: {
					completionFailureCode: "command.arguments_completion_empty",
					responseKind: "select",
				},
			},
		});
	});

	it("rejects argument completion responses of unexpected kinds", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();
		const { completeCommandArguments, binding, invocation } =
			createArgumentsCompletionFixture(orchestrator);
		orchestrator.registerClient({
			id: "human",
			requestHuman: async () => ({ kind: "confirm", confirmed: true }),
		});

		await expect(
			completeCommandArguments({
				agentId,
				commandId: "orchestrator-command-test",
				binding,
				invocation,
				argumentPrefix: "",
			}),
		).resolves.toMatchObject({
			ok: false,
			diagnostic: {
				code: "command.arguments_required",
				details: {
					completionFailureCode:
						"command.arguments_completion_invalid_response",
					responseKind: "confirm",
				},
			},
		});
	});

	it("short-circuits argument completion when the candidate source fails", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();
		const { completeCommandArguments, binding, invocation } =
			createArgumentsCompletionFixture(orchestrator, async () => {
				throw new Error("candidate source unavailable");
			});
		let humanRequested = false;
		orchestrator.registerClient({
			id: "human",
			requestHuman: async () => {
				humanRequested = true;
				return { kind: "input", value: "never" };
			},
		});

		await expect(
			completeCommandArguments({
				agentId,
				commandId: "orchestrator-command-test",
				binding,
				invocation,
				argumentPrefix: "",
			}),
		).resolves.toMatchObject({
			ok: false,
			diagnostic: {
				code: "command.arguments_required",
				details: expect.objectContaining({
					completionFailureCode: "command.arguments_completion_failed",
				}),
			},
		});
		expect(humanRequested).toBe(false);
	});

	it("prunes and rejects commands denied by profile policy", async () => {
		const env = new MemoryExecutionEnv();
		const policyProfile: AgentProfile = {
			...defaultProfile,
			id: "policy",
			commands: { deny: ["abort"] },
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: policyProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: policyProfile },
				]),
			),
		});
		const { agentId } = await orchestrator.spawnAgentHarness();

		const names = orchestrator.listCommands(agentId).map((c) => c.name);
		expect(names).not.toContain("abort");
		expect(names).toContain("status");
		await expect(
			orchestrator.inputAgent(agentId, "/abort"),
		).resolves.toMatchObject({
			kind: "rejected",
			diagnostic: { code: "command.not_permitted", agentId },
		});
	});

	it("hides user-facing commands from agents that do not accept user input", async () => {
		const env = new MemoryExecutionEnv();
		const workerProfile: AgentProfile = {
			...defaultProfile,
			id: "background-worker",
			capabilities: { acceptsUserInput: false },
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: workerProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: workerProfile },
				]),
			),
		});
		const { agentId } = await orchestrator.spawnAgentHarness();

		const names = orchestrator.listCommands(agentId).map((c) => c.name);
		expect(names).not.toContain("new");
		expect(names).not.toContain("fork");
		expect(names).not.toContain("resume");
		expect(names).toContain("status");
		await expect(
			orchestrator.inputAgent(agentId, "/new"),
		).resolves.toMatchObject({
			kind: "rejected",
			diagnostic: { code: "command.not_permitted", agentId },
		});
	});

	it("treats input as plain prompt when command parsing is disabled", async () => {
		const env = new MemoryExecutionEnv();
		const chatProfile: AgentProfile = {
			...defaultProfile,
			id: "chat-only",
			commands: { enabled: false },
		};
		const orchestrator = await createOrchestrator(env, {
			defaultProfileId: chatProfile.id,
			profileRegistry: new AgentProfileRegistry(
				InMemoryProfileStorageBackend.fromProfiles([
					{ profile: chatProfile },
					{ profile: defaultProfile },
				]),
			),
		});
		const { agentId } = await orchestrator.spawnAgentHarness();
		const prompted: string[] = [];
		const promptStub = async (_agentId: string, text: string) => {
			prompted.push(text);
			return { role: "assistant" } as AssistantMessage;
		};
		Object.assign(orchestrator, { promptAgent: promptStub });

		expect(orchestrator.listCommands(agentId)).toEqual([]);
		await expect(
			orchestrator.inputAgent(agentId, "/status"),
		).resolves.toMatchObject({ kind: "prompt" });

		// The per-call switch has the same semantics on a command-enabled agent.
		const { agentId: commandAgentId } = await orchestrator.spawnAgentHarness({
			profileId: defaultProfile.id,
		});
		await expect(
			orchestrator.inputAgent(commandAgentId, "/status", { commands: false }),
		).resolves.toMatchObject({ kind: "prompt" });
		expect(prompted).toEqual(["/status", "/status"]);
	});

	it("starts a new empty session from the current agent", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();

		const result = await orchestrator.inputAgent(agentId, "/new");

		expect(result).toMatchObject({
			kind: "command",
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
		await expect(
			orchestrator.inputAgent(agentId, "/resume"),
		).resolves.toMatchObject({
			kind: "command",
			value: {
				sessions: expect.arrayContaining([
					expect.objectContaining({ id: "worker-agent" }),
					expect.objectContaining({ id: agentId }),
				]),
			},
		});

		const result = await orchestrator.inputAgent(
			agentId,
			`/resume:${metadata.path}`,
		);

		expect(result).toMatchObject({
			kind: "command",
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
			orchestrator.inputAgent(agentId, "/resume:same"),
		).resolves.toMatchObject({
			kind: "failed",
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
			orchestrator.inputAgent(agentId, "/agent"),
		).resolves.toMatchObject({
			kind: "command",
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
			orchestrator.inputAgent(agentId, "/session"),
		).resolves.toMatchObject({
			kind: "command",
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
			orchestrator.inputAgent(agentId, "/name:Planning Session"),
		).resolves.toMatchObject({
			kind: "command",
			value: {
				name: "Planning Session",
			},
		});
		await expect(
			orchestrator.inputAgent(agentId, "/tree"),
		).resolves.toMatchObject({
			kind: "command",
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
			orchestrator.inputAgent(agentId, `/tree:${userEntryId}`),
		).resolves.toMatchObject({
			kind: "command",
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

		const result = await orchestrator.inputAgent(
			agentId,
			`/fork:${targetEntryId}`,
		);

		expect(result).toMatchObject({
			kind: "command",
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
			result.kind !== "command" ||
			!result.value ||
			typeof result.value !== "object" ||
			!("agentId" in result.value) ||
			typeof result.value.agentId !== "string"
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

		await orchestrator.disposeAgent(agentId, "test cleanup");
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
				name: "sample",
				description: "Sample command",
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
					command: {
						name: "sample",
						description: "Sample command",
						source: { kind: "extension", extensionId: "sample" },
						placement: "line",
						trigger: "/",
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
				name: "mark",
				description: "Append a marker entry",
				argumentHint: "<text>",
				handler: async (args, context) => {
					await context.session.appendEntry("marker", { args });
				},
			});
		});
		const { agentId } = await orchestrator.spawnAgentHarness();

		const result = await orchestrator.inputAgent(agentId, "/mark:hello world");

		expect(result).toMatchObject({
			kind: "command",
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
		expect(orchestrator.listCommands(agentId)).toEqual([
			expect.objectContaining({
				name: "abort",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "compact",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "follow-up",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "fork",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "inspect",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "agent",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "model",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "thinking",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "name",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "new",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "reload",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "resume",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "session",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "status",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "steer",
				source: { kind: "built-in" },
			}),
			expect.objectContaining({
				name: "tree",
				source: { kind: "built-in" },
			}),
			{
				name: "mark",
				description: "Append a marker entry",
				argumentHint: "<text>",
				source: { kind: "extension", extensionId: "sample" },
				placement: "line",
				trigger: "/",
				available: true,
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

	it("reports invalid commands without wrapping programmatic calls", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const { agentId } = await orchestrator.spawnAgentHarness();

		const idleSteer = await orchestrator.inputAgent(agentId, "/steer:steer");
		expect(idleSteer).toMatchObject({
			kind: "rejected",
			diagnostic: {
				code: "command.not_available",
				agentId,
			},
		});
		// The same status fact surfaces as availability in listCommands.
		expect(
			orchestrator.listCommands(agentId).find((c) => c.name === "steer"),
		).toMatchObject({
			available: false,
			unavailableReason: expect.stringContaining("running"),
		});

		expect(() => orchestrator.getAgentModel("missing")).toThrow(
			"Unknown agent: missing",
		);
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
