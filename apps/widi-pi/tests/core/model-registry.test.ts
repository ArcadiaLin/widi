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
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ConfigValueResolver } from "../../src/core/resolve-config-value.ts";

class MemoryExecutionEnv implements ExecutionEnv {
	cwd = "/workspace";
	readonly files = new Map<string, string>();

	async exists(path: string): Promise<Result<boolean, FileError>> {
		return ok(this.files.has(path));
	}

	async readTextFile(path: string): Promise<Result<string, FileError>> {
		const content = this.files.get(path);
		if (content === undefined) {
			return err(new PiFileError("not_found", `File not found: ${path}`, path));
		}
		return ok(content);
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
	): Promise<Result<void, FileError>> {
		this.files.set(
			path,
			typeof content === "string" ? content : new TextDecoder().decode(content),
		);
		return ok(undefined);
	}

	async exec(
		command: string,
		_options?: ShellExecOptions,
	): Promise<
		Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
	> {
		if (command === "token-command") {
			return ok({ stdout: "command-token\n", stderr: "", exitCode: 0 });
		}
		return err(new PiExecutionError("shell_unavailable", "not supported"));
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(path.startsWith("/") ? path : `${this.cwd}/${path}`);
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(parts.join("/").replace(/\/+/g, "/"));
	}

	async readTextLines(): Promise<Result<string[], FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async readBinaryFile(): Promise<Result<Uint8Array, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async appendFile(): Promise<Result<void, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async fileInfo(): Promise<Result<FileInfo, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async listDir(): Promise<Result<FileInfo[], FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		return ok(path);
	}

	async createDir(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async remove(path: string): Promise<Result<void, FileError>> {
		this.files.delete(path);
		return ok(undefined);
	}

	async createTempDir(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async createTempFile(): Promise<Result<string, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async cleanup(): Promise<void> {}
}

function createResolver(env: MemoryExecutionEnv): ConfigValueResolver {
	return new ConfigValueResolver(env, {
		getEnv: (name) => {
			if (name === "CUSTOM_API_KEY") return "env-token";
			if (name === "CUSTOM_HEADER") return "env-header";
			return undefined;
		},
	});
}

async function createRegistry(
	env: MemoryExecutionEnv,
	modelsJsonPath?: string,
): Promise<ModelRegistry> {
	const configValueResolver = createResolver(env);
	const authStorage = AuthStorage.inMemory({ configValueResolver });
	return await ModelRegistry.create({
		executionEnv: env,
		authStorage,
		configValueResolver,
		modelsJsonPath,
	});
}

describe("ModelRegistry", () => {
	it("loads built-in models without models.json", async () => {
		const env = new MemoryExecutionEnv();
		const registry = await createRegistry(env);

		expect(registry.getAll().length).toBeGreaterThan(0);
		expect(registry.getError()).toBeUndefined();
	});

	it("loads custom models and resolves provider request auth through shared ExecutionEnv resolver", async () => {
		const env = new MemoryExecutionEnv();
		env.files.set(
			".widi/models.json",
			JSON.stringify({
				providers: {
					custom: {
						name: "Custom",
						baseUrl: "https://example.test/v1",
						apiKey: "$CUSTOM_API_KEY",
						api: "openai-completions",
						headers: {
							"X-Custom": "$CUSTOM_HEADER",
						},
						authHeader: true,
						models: [
							{
								id: "custom-model",
								name: "Custom Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					},
				},
			}),
		);

		const registry = await createRegistry(env, ".widi/models.json");
		const model = registry.find("custom", "custom-model");

		expect(model).toMatchObject({
			id: "custom-model",
			provider: "custom",
			baseUrl: "https://example.test/v1",
		});
		if (!model) throw new Error("Expected custom model to resolve.");
		await expect(registry.getAvailable()).resolves.toContain(model);
		await expect(registry.getApiKeyAndHeaders(model)).resolves.toEqual({
			ok: true,
			apiKey: "env-token",
			headers: {
				"X-Custom": "env-header",
				Authorization: "Bearer env-token",
			},
		});
	});

	it("supports command-backed provider api keys", async () => {
		const env = new MemoryExecutionEnv();
		env.files.set(
			".widi/models.json",
			JSON.stringify({
				providers: {
					commanded: {
						baseUrl: "https://example.test/v1",
						apiKey: "!token-command",
						api: "openai-completions",
						models: [
							{
								id: "model",
								name: "Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 1000,
								maxTokens: 100,
							},
						],
					},
				},
			}),
		);

		const registry = await createRegistry(env, ".widi/models.json");
		const model = registry.find("commanded", "model");
		if (!model) throw new Error("Expected commanded model to resolve.");

		await expect(registry.getApiKeyAndHeaders(model)).resolves.toEqual({
			ok: true,
			apiKey: "command-token",
			headers: undefined,
		});
	});

	it("keeps built-in models and records load errors for invalid models.json", async () => {
		const env = new MemoryExecutionEnv();
		env.files.set(".widi/models.json", "{ invalid");

		const registry = await createRegistry(env, ".widi/models.json");

		expect(registry.getAll().length).toBeGreaterThan(0);
		expect(registry.getError()).toContain("Failed to parse models.json");
		expect(registry.getLoadDiagnostic()).toEqual(
			expect.objectContaining({
				domain: "model",
				code: "model.load_failed",
				disposition: "degraded",
				source: {
					kind: "path",
					path: ".widi/models.json",
					label: "models.json",
				},
				phase: "load",
			}),
		);
		expect(registry.drainDiagnostics()).toContainEqual(
			expect.objectContaining({ code: "model.load_failed" }),
		);
	});

	it("records diagnostics for authHeader models without API keys", async () => {
		const env = new MemoryExecutionEnv();
		const registry = await createRegistry(env);
		const model = createTestModel("missing-auth");
		registry.registerProvider("missing-auth", { authHeader: true });

		await expect(registry.getApiKeyAndHeaders(model)).resolves.toEqual({
			ok: false,
			error: 'No API key found for "missing-auth"',
		});
		expect(registry.drainDiagnostics()).toContainEqual(
			expect.objectContaining({
				domain: "model",
				code: "model.auth_missing",
				disposition: "blocked",
				provider: "missing-auth",
				modelId: "test-model",
			}),
		);
	});

	it("records diagnostics for request auth resolution failures", async () => {
		const env = new MemoryExecutionEnv();
		const registry = await createRegistry(env);
		const model = createTestModel("missing-env");
		registry.registerProvider("missing-env", {
			apiKey: "$MISSING_MODEL_API_KEY",
		});

		const result = await registry.getApiKeyAndHeaders(model);

		expect(result).toEqual({
			ok: false,
			error:
				'Failed to resolve API key for provider "missing-env" from environment variable: MISSING_MODEL_API_KEY',
		});
		expect(registry.drainDiagnostics()).toContainEqual(
			expect.objectContaining({
				domain: "model",
				code: "model.auth_resolution_failed",
				disposition: "blocked",
				provider: "missing-env",
				modelId: "test-model",
			}),
		);
	});
});

function createTestModel(provider: string): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions" as Api,
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;
}
