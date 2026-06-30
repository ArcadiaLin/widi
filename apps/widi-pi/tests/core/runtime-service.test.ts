import type {
	ExecutionEnv,
	ExecutionEnvExecOptions,
	ExecutionError,
	FileError,
	FileInfo,
	Result,
} from "@earendil-works/pi-agent-core";
import {
	err,
	ok,
	ExecutionError as PiExecutionError,
	FileError as PiFileError,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createWidiRuntime } from "../../src/core/runtime-service.ts";

class MemoryExecutionEnv implements ExecutionEnv {
	cwd = "/workspace/project";
	readonly files = new Map<string, string>();
	readonly dirs = new Set<string>(["/"]);

	private normalize(path: string): string {
		const absolute = path.startsWith("/") ? path : `${this.cwd}/${path}`;
		return absolute.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
	}

	private dirname(path: string): string {
		const normalized = this.normalize(path);
		if (normalized === "/") return "/";
		const index = normalized.lastIndexOf("/");
		if (index <= 0) return "/";
		return normalized.slice(0, index);
	}

	private basename(path: string): string {
		const normalized = this.normalize(path);
		if (normalized === "/") return "/";
		const index = normalized.lastIndexOf("/");
		return index === -1 ? normalized : normalized.slice(index + 1);
	}

	addDir(path: string): void {
		const normalized = this.normalize(path);
		if (normalized === "/") {
			this.dirs.add("/");
			return;
		}
		this.addDir(this.dirname(normalized));
		this.dirs.add(normalized);
	}

	addFile(path: string, content: string): void {
		const normalized = this.normalize(path);
		this.addDir(this.dirname(normalized));
		this.files.set(normalized, content);
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

	async readTextLines(path: string): Promise<Result<string[], FileError>> {
		const result = await this.readTextFile(path);
		if (!result.ok) return result;
		return ok(result.value.split("\n"));
	}

	async readBinaryFile(): Promise<Result<Uint8Array, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
	): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		this.addDir(this.dirname(normalized));
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
		this.addFile(
			normalized,
			`${current}${typeof content === "string" ? content : new TextDecoder().decode(content)}`,
		);
		return ok(undefined);
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const normalized = this.normalize(path);
		if (this.files.has(normalized)) {
			return ok({
				name: this.basename(normalized),
				path: normalized,
				kind: "file",
				size: this.files.get(normalized)?.length ?? 0,
				mtimeMs: 0,
			});
		}
		if (this.dirs.has(normalized)) {
			return ok({
				name: this.basename(normalized),
				path: normalized,
				kind: "directory",
				size: 0,
				mtimeMs: 0,
			});
		}
		return err(
			new PiFileError("not_found", `File not found: ${normalized}`, normalized),
		);
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		const dir = this.normalize(path);
		if (!this.dirs.has(dir)) {
			return err(
				new PiFileError("not_found", `Directory not found: ${dir}`, dir),
			);
		}

		const result: FileInfo[] = [];
		for (const filePath of this.files.keys()) {
			if (this.dirname(filePath) !== dir) continue;
			result.push({
				name: this.basename(filePath),
				path: filePath,
				kind: "file",
				size: this.files.get(filePath)?.length ?? 0,
				mtimeMs: 0,
			});
		}
		for (const directory of this.dirs) {
			if (directory === dir || this.dirname(directory) !== dir) continue;
			result.push({
				name: this.basename(directory),
				path: directory,
				kind: "directory",
				size: 0,
				mtimeMs: 0,
			});
		}
		return ok(
			result.sort((left, right) => left.path.localeCompare(right.path)),
		);
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		return ok(this.normalize(path));
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		const normalized = this.normalize(path);
		return ok(this.files.has(normalized) || this.dirs.has(normalized));
	}

	async createDir(path: string): Promise<Result<void, FileError>> {
		this.addDir(path);
		return ok(undefined);
	}

	async remove(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async createTempDir(): Promise<Result<string, FileError>> {
		return ok("/tmp/widi-runtime-test");
	}

	async createTempFile(): Promise<Result<string, FileError>> {
		return ok("/tmp/widi-runtime-test/file");
	}

	async cleanup(): Promise<void> {}

	async exec(
		_command: string,
		_options?: ExecutionEnvExecOptions,
	): Promise<
		Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
	> {
		return err(new PiExecutionError("shell_unavailable", "not supported"));
	}
}

const defaultModel: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	provider: "test-provider",
	api: "openai-completions",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

function profileMarkdown(id: string): string {
	return `---
id: ${id}
label: ${id}
persist: true
---
You are ${id}.`;
}

describe("createWidiRuntime", () => {
	it("creates services and an orchestrator without spawning an agent", async () => {
		const env = new MemoryExecutionEnv();
		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
		});

		expect(runtime.services.cwd).toBe("/workspace/project");
		expect(runtime.services.agentDir).toBe("/home/user/.widi");
		expect(runtime.services.sessionRoot).toBe("/home/user/.widi/runs");
		expect(runtime.orchestrator.getDefaultProfileId()).toBe("default");
		expect(runtime.orchestrator.getDefaultModel()).toBe(defaultModel);
		expect(runtime.orchestrator.agents.size).toBe(0);
		expect(runtime.services.defaultProfile).toMatchObject({
			id: "default",
			source: "builtin",
			profileSource: { kind: "builtin" },
		});
		expect(runtime.services.defaultModel).toEqual({
			provider: "test-provider",
			modelId: "test-model",
			source: "override",
		});
	});

	it("gates project profiles when project trust is not granted", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile(
			"/workspace/project/.widi/profiles/project.md",
			profileMarkdown("project"),
		);

		await expect(
			createWidiRuntime({
				cwd: "/workspace/project",
				agentDir: "/home/user/.widi",
				executionEnv: env,
				defaultModel,
				defaultProfileId: "project",
			}),
		).rejects.toMatchObject({
			code: "profile.default_resolution_failed",
		});
	});

	it("loads project profiles when trust is granted by override", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile(
			"/workspace/project/.widi/profiles/project.md",
			profileMarkdown("project"),
		);

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			defaultProfileId: "project",
			trustOverride: true,
		});

		expect(runtime.orchestrator.getDefaultProfileId()).toBe("project");
		expect(runtime.services.projectTrust.trusted).toBe(true);
		expect(runtime.services.defaultProfile).toMatchObject({
			id: "project",
			source: "override",
			profileSource: { kind: "cwd" },
		});
	});

	it("uses stored parent trust decisions", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/home/user/.widi/trust.json", '{ "/workspace": true }');
		env.addFile(
			"/workspace/project/.widi/profiles/project.md",
			profileMarkdown("project"),
		);

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			defaultProfileId: "project",
		});

		expect(runtime.services.projectTrust).toMatchObject({
			trusted: true,
			source: "store",
		});
		expect(runtime.orchestrator.getDefaultProfileId()).toBe("project");
	});

	it("connects settings resource and extension paths to loaders", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile(
			"/home/user/.widi/settings.json",
			JSON.stringify({
				skills: ["/custom/skills"],
				prompts: ["/custom/prompts"],
				extensions: ["/custom/extensions"],
			}),
		);

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
		});

		expect(runtime.services.resourceLoader.getSkillRoots()).toContainEqual({
			kind: "settings",
			path: "/custom/skills",
		});
		expect(
			runtime.services.resourceLoader.getPromptTemplateRoots(),
		).toContainEqual({
			kind: "settings",
			path: "/custom/prompts",
		});
		expect(runtime.services.extensionLoader.getRoots()).toContainEqual({
			kind: "settings",
			path: "/custom/extensions",
		});
	});

	it("combines settings, project, agent dir, and builtin profile sources", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile(
			"/home/user/.widi/settings.json",
			JSON.stringify({
				defaultProfile: "settings-profile",
				profiles: ["/custom/profiles"],
			}),
		);
		env.addFile(
			"/custom/profiles/settings-profile.md",
			profileMarkdown("settings-profile"),
		);
		env.addFile(
			"/workspace/project/.widi/profiles/project.md",
			profileMarkdown("project"),
		);
		env.addFile("/home/user/.widi/profiles/agent.md", profileMarkdown("agent"));

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			trustOverride: true,
		});

		expect(runtime.services.defaultProfile).toMatchObject({
			id: "settings-profile",
			source: "settings",
			profileSource: {
				kind: "settings",
				path: "/custom/profiles/settings-profile.md",
			},
		});
		expect(runtime.services.profileRoots).toEqual([
			expect.objectContaining({
				kind: "settings",
				path: "/custom/profiles",
				priority: 300,
				missingBehavior: "diagnostic",
			}),
			expect.objectContaining({
				kind: "cwd",
				path: "/workspace/project/.widi/profiles",
				priority: 200,
				missingBehavior: "silent",
			}),
			expect.objectContaining({
				kind: "agent_dir",
				path: "/home/user/.widi/profiles",
				priority: 100,
				missingBehavior: "silent",
			}),
		]);

		await expect(
			runtime.services.profileRegistry.resolveProfile("project"),
		).resolves.toMatchObject({ ok: true, source: { kind: "cwd" } });
		await expect(
			runtime.services.profileRegistry.resolveProfile("agent"),
		).resolves.toMatchObject({ ok: true, source: { kind: "agent_dir" } });
		await expect(
			runtime.services.profileRegistry.resolveProfile("default"),
		).resolves.toMatchObject({ ok: true, source: { kind: "builtin" } });
	});

	it("reports missing settings profile roots through runtime diagnostics", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile(
			"/home/user/.widi/settings.json",
			JSON.stringify({ profiles: ["/missing/profiles"] }),
		);

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
		});

		expect(runtime.diagnostics).toContainEqual(
			expect.objectContaining({ code: "profile.source_missing" }),
		);
	});

	it("prefers explicit session root over settings and fallback", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile(
			"/home/user/.widi/settings.json",
			JSON.stringify({ sessionDir: "/settings/sessions" }),
		);

		const runtime = await createWidiRuntime({
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
			executionEnv: env,
			defaultModel,
			sessionRoot: "/override/sessions",
		});

		expect(runtime.services.sessionRoot).toBe("/override/sessions");
	});
});
