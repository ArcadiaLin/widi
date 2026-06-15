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
import { describe, expect, it } from "vitest";
import { AgentProfileLoader } from "../../src/core/agent-profile.ts";

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
		const content = this.files.get(normalized);
		if (content !== undefined) {
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
		_options?: ExecutionEnvExecOptions,
	): Promise<
		Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
	> {
		return err(new PiExecutionError("shell_unavailable", "not supported"));
	}

	async cleanup(): Promise<void> {}
}

describe("AgentProfileLoader", () => {
	it("loads named profiles from agent and cwd profile roots", async () => {
		const env = new MemoryExecutionEnv();
		await env.createDir("/home/user/.widi/profiles", { recursive: true });
		await env.createDir("/workspace/project/.widi/profiles", {
			recursive: true,
		});
		await env.writeFile(
			"/home/user/.widi/profiles/worker.md",
			"---\nid: global-worker\nlabel: Global Worker\npersist: true\nskills: [code]\nprompt-templates: [review]\nextensions: [mailbox]\nmissing-extension-severity: error\n---\nGlobal prompt",
		);
		await env.writeFile(
			"/workspace/project/.widi/profiles/worker.md",
			"---\nid: project-worker\nlabel: Project Worker\n---\nProject prompt",
		);

		const loader = new AgentProfileLoader({
			executionEnv: env,
			cwd: "/workspace/project",
			agentDir: "/home/user/.widi",
		});
		const result = await loader.loadProfiles(["worker"]);

		expect(result.diagnostics).toEqual([]);
		expect(result.profiles.map(({ profile }) => profile.id)).toEqual([
			"global-worker",
			"project-worker",
		]);
		expect(result.profiles[0]?.profile).toMatchObject({
			label: "Global Worker",
			systemPrompt: "Global prompt",
			persist: true,
			skills: ["code"],
			promptTemplates: ["review"],
			extensions: ["mailbox"],
			missingExtensionSeverity: "error",
		});
		expect(result.profiles.map(({ source }) => source)).toEqual([
			{ kind: "agent_dir", path: "/home/user/.widi/profiles/worker.md" },
			{ kind: "cwd", path: "/workspace/project/.widi/profiles/worker.md" },
		]);
	});

	it("loads every direct markdown profile when no profile names are provided", async () => {
		const env = new MemoryExecutionEnv();
		await env.createDir("/workspace/project/.widi/profiles/nested", {
			recursive: true,
		});
		await env.writeFile("/workspace/project/.widi/profiles/b.md", "B prompt");
		await env.writeFile("/workspace/project/.widi/profiles/a.md", "A prompt");
		await env.writeFile(
			"/workspace/project/.widi/profiles/note.txt",
			"ignored",
		);
		await env.writeFile(
			"/workspace/project/.widi/profiles/nested/ignored.md",
			"ignored",
		);

		const loader = new AgentProfileLoader({
			executionEnv: env,
			cwd: "/workspace/project",
			agentDir: "",
		});
		const result = await loader.loadProfiles();

		expect(result.diagnostics).toEqual([]);
		expect(result.profiles.map(({ profile }) => profile.id)).toEqual([
			"a",
			"b",
		]);
		expect(result.profiles.map(({ source }) => source.path)).toEqual([
			"/workspace/project/.widi/profiles/a.md",
			"/workspace/project/.widi/profiles/b.md",
		]);
	});

	it("keeps explicit path loading available", async () => {
		const env = new MemoryExecutionEnv();
		await env.writeFile(
			"/profiles/special.md",
			"---\nlabel: Special\n---\nSpecial prompt",
		);
		const loader = new AgentProfileLoader({
			executionEnv: env,
			cwd: "/workspace/project",
			agentDir: "",
		});

		const result = await loader.loadProfileFromPath("/profiles/special.md");

		expect(result.diagnostics).toEqual([]);
		expect(result.profile).toMatchObject({
			id: "special",
			label: "Special",
			systemPrompt: "Special prompt",
		});
	});
});
