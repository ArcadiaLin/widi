import type {
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
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import {
	type AgentProfile,
	AgentProfileRegistry,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
import type { AgentRecord } from "../../src/core/agent-record.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ConfigValueResolver } from "../../src/core/resolve-config-value.ts";
import { ResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingManager } from "../../src/core/setting-manager.ts";
import { ToolRegistry } from "../../src/core/tool-registry.ts";
import { registerCoreCodingTools } from "../../src/core/tools/coding/builtin.ts";
import type { ToolDefinition } from "../../src/core/tools/types.ts";

export class MemoryExecutionEnv implements ExecutionEnv {
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

export const defaultProfile: AgentProfile = {
	id: "main",
	label: "Main Agent",
	systemPrompt: "default prompt",
	persist: true,
};

export const restoredProfile: AgentProfile = {
	id: "worker",
	label: "Worker Agent",
	systemPrompt: "worker prompt",
	persist: true,
};

export const defaultModel: Model<"openai-completions"> = {
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

export const restoredModel: Model<"openai-completions"> = {
	...defaultModel,
	id: "restored-model",
	name: "Restored Model",
};

export const reasoningModel: Model<"openai-completions"> = {
	...defaultModel,
	id: "reasoning-model",
	name: "Reasoning Model",
	reasoning: true,
	thinkingLevelMap: { minimal: null, high: "high" },
};

export async function createModelRegistry(
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

export async function createEmptyModelRegistry(
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

export async function createOrchestrator(
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

export function createProfileRegistry(): AgentProfileRegistry {
	return new AgentProfileRegistry(
		InMemoryProfileStorageBackend.fromProfiles([
			{ profile: defaultProfile },
			{ profile: restoredProfile },
		]),
	);
}

export function createToolDefinition(
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

export function createToolRegistry(...tools: ToolDefinition[]): ToolRegistry {
	const registry = new ToolRegistry();
	for (const tool of tools) {
		registry.defineTool(tool, { kind: "core", id: "test" });
	}
	return registry;
}

export function createCoreCodingToolRegistry(): ToolRegistry {
	const registry = new ToolRegistry();
	registerCoreCodingTools(registry, "/workspace/project");
	return registry;
}

// White-box test helper for driving harness hooks and inspecting live runners.
export function requireAgentRecord(
	orchestrator: AgentOrchestrator,
	agentId: string,
): AgentRecord {
	const record = (
		orchestrator as unknown as { _agents: Map<string, AgentRecord> }
	)._agents.get(agentId);
	if (!record) throw new Error(`Unknown agent record: ${agentId}`);
	return record;
}

export function requireAgentHarness(
	orchestrator: AgentOrchestrator,
	agentId: string,
): NonNullable<AgentRecord["harness"]> {
	const harness = requireAgentRecord(orchestrator, agentId).harness;
	if (!harness) throw new Error(`Missing agent harness: ${agentId}`);
	return harness;
}
