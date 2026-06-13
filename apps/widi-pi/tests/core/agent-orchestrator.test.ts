import type { Model } from "@earendil-works/pi-ai";
import type {
	ExecutionEnv,
	ExecutionEnvExecOptions,
	ExecutionError,
	FileError,
	FileInfo,
	Result,
} from "@earendil-works/pi-agent-core";
import { ExecutionError as PiExecutionError, FileError as PiFileError, err, ok } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../../src/core/agent-profile.ts";
import { AgentOrchestrator, type OrchestratorEvent } from "../../src/core/agent-orchestrator.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ConfigValueResolver } from "../../src/core/resolve-config-value.ts";
import { ResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingManager } from "../../src/core/setting-manager.ts";
import type { ExtendedJsonlSessionMetadata } from "../../src/storage/jsonl-repo.ts";

function expectExtendedMetadata(metadata: { id: string; createdAt: string }): ExtendedJsonlSessionMetadata {
	if (!("path" in metadata) || typeof metadata.path !== "string") {
		throw new Error("Expected persistent JSONL session metadata.");
	}
	return metadata as ExtendedJsonlSessionMetadata;
}

class MemoryExecutionEnv implements ExecutionEnv {
	cwd = "/workspace";
	readonly files = new Map<string, string>();
	readonly dirs = new Set<string>(["/"]);

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
			return err(new PiFileError("not_found", `File not found: ${normalized}`, normalized));
		}
		return ok(content);
	}

	async readTextLines(path: string, options?: { maxLines?: number }): Promise<Result<string[], FileError>> {
		const result = await this.readTextFile(path);
		if (!result.ok) return result;
		const lines = result.value.split("\n");
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async readBinaryFile(): Promise<Result<Uint8Array, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		this.dirs.add(this.dirname(normalized));
		this.files.set(normalized, typeof content === "string" ? content : new TextDecoder().decode(content));
		return ok(undefined);
	}

	async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		const current = this.files.get(normalized) ?? "";
		const next = typeof content === "string" ? content : new TextDecoder().decode(content);
		this.files.set(normalized, current + next);
		return ok(undefined);
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const normalized = this.normalize(path);
		if (this.files.has(normalized)) {
			const content = this.files.get(normalized)!;
			return ok({ name: normalized.slice(normalized.lastIndexOf("/") + 1), path: normalized, kind: "file", size: content.length, mtimeMs: 0 });
		}
		if (this.dirs.has(normalized)) {
			return ok({ name: normalized.slice(normalized.lastIndexOf("/") + 1), path: normalized, kind: "directory", size: 0, mtimeMs: 0 });
		}
		return err(new PiFileError("not_found", `Path not found: ${normalized}`, normalized));
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		const dir = this.normalize(path);
		if (!this.dirs.has(dir)) {
			return err(new PiFileError("not_found", `Directory not found: ${dir}`, dir));
		}

		const entries: FileInfo[] = [];
		for (const directory of this.dirs) {
			if (directory === dir || this.dirname(directory) !== dir) continue;
			entries.push({ name: directory.slice(directory.lastIndexOf("/") + 1), path: directory, kind: "directory", size: 0, mtimeMs: 0 });
		}
		for (const [filePath, content] of this.files) {
			if (this.dirname(filePath) !== dir) continue;
			entries.push({ name: filePath.slice(filePath.lastIndexOf("/") + 1), path: filePath, kind: "file", size: content.length, mtimeMs: 0 });
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

	async createDir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		if (options?.recursive === false && !this.dirs.has(this.dirname(normalized))) {
			return err(new PiFileError("not_found", `Parent not found: ${this.dirname(normalized)}`, normalized));
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
		_options?: ExecutionEnvExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		return err(new PiExecutionError("shell_unavailable", "not supported"));
	}

	async cleanup(): Promise<void> {}
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

async function createModelRegistry(env: MemoryExecutionEnv): Promise<ModelRegistry> {
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

describe("AgentOrchestrator", () => {
	it("resumes a persisted agent harness from session metadata", async () => {
		const env = new MemoryExecutionEnv();
		const sessionManager = new SessionManager({ fs: env, cwd: "/workspace/project", sessionsRoot: "/sessions" });
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
			resourceLoader: new ResourceLoader({ executionEnv: env, cwd: "/workspace/project" }),
			sessionManager,
			settingManager: new SettingManager(),
			modelRegistry,
			defaultProfile,
			defaultModel,
			resolveProfile: (profileId) => profileId === restoredProfile.id ? restoredProfile : undefined,
		});
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		const result = await orchestrator.spawnAgentHarness({ resume: true, metadata });

		expect(result.agentId).toBe("worker-agent");
		expect(result.harness.getModel()).toMatchObject({ provider: restoredModel.provider, id: restoredModel.id });
		expect(result.harness.getThinkingLevel()).toBe("medium");
		expect(events).toContainEqual({
			type: "agent_resumed",
			agentId: "worker-agent",
			profile: restoredProfile,
			model: expect.objectContaining({ id: restoredModel.id }),
		});
	});
});
