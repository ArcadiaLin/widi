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
import { describe, expect, it } from "vitest";
import {
	AgentProfileRegistry,
	FileProfileStorageBackend,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";

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
		_options?: ShellExecOptions,
	): Promise<
		Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
	> {
		return err(new PiExecutionError("shell_unavailable", "not supported"));
	}

	async cleanup(): Promise<void> {}
}

describe("AgentProfileRegistry", () => {
	it("resolves project profiles over user profiles as whole-profile override", async () => {
		const env = new MemoryExecutionEnv();
		await env.createDir("/home/user/.widi/profiles", { recursive: true });
		await env.createDir("/workspace/project/.widi/profiles", {
			recursive: true,
		});
		await env.writeFile(
			"/home/user/.widi/profiles/worker.md",
			"---\nid: worker\nlabel: User Worker\npersist: true\nskills: [code]\n---\nUser prompt",
		);
		await env.writeFile(
			"/workspace/project/.widi/profiles/worker.md",
			"---\nid: worker\nlabel: Project Worker\n---\nProject prompt",
		);

		const registry = new AgentProfileRegistry(
			new FileProfileStorageBackend(env, [
				{
					kind: "agent_dir",
					path: "/home/user/.widi/profiles",
					priority: 100,
					missingBehavior: "silent",
				},
				{
					kind: "cwd",
					path: "/workspace/project/.widi/profiles",
					priority: 200,
					missingBehavior: "silent",
				},
			]),
		);

		const result = await registry.resolveProfile("worker");

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("Expected profile to resolve.");
		expect(result.profile).toMatchObject({
			id: "worker",
			label: "Project Worker",
			systemPrompt: "Project prompt",
			persist: false,
		});
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "profile.source_overridden",
				profileId: "worker",
			}),
		);
	});

	it("hard fails duplicate profile ids at the same priority", async () => {
		const registry = new AgentProfileRegistry(
			new InMemoryProfileStorageBackend([
				{
					entryId: "memory:a",
					filenameId: "a",
					source: { kind: "memory", priority: 100 },
					content: "---\nid: reviewer\n---\nA",
				},
				{
					entryId: "memory:b",
					filenameId: "b",
					source: { kind: "memory", priority: 100 },
					content: "---\nid: reviewer\n---\nB",
				},
			]),
		);

		const result = await registry.resolveProfile("reviewer");

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected duplicate profile failure.");
		expect(result.reason).toBe("duplicate_profile_id");
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "profile.duplicate_id" }),
		);
	});

	it("indexes declared ids and does not treat filename as an alias", async () => {
		const env = new MemoryExecutionEnv();
		await env.writeFile(
			"/profiles/special.md",
			"---\nid: reviewer\nlabel: Reviewer\n---\nReview prompt",
		);
		const registry = new AgentProfileRegistry(
			new FileProfileStorageBackend(env, [
				{
					kind: "settings",
					path: "/profiles/special.md",
					priority: 300,
					missingBehavior: "diagnostic",
				},
			]),
		);

		const declared = await registry.resolveProfile("reviewer");
		const filename = await registry.resolveProfile("special");

		expect(declared.ok).toBe(true);
		expect(filename.ok).toBe(false);
		if (declared.ok) {
			expect(declared.diagnostics).toContainEqual(
				expect.objectContaining({ code: "profile.id_filename_mismatch" }),
			);
		}
		if (!filename.ok) {
			expect(filename.reason).toBe("profile_missing");
		}
	});

	it("lists only summaries for resolvable direct markdown children", async () => {
		const env = new MemoryExecutionEnv();
		await env.createDir("/workspace/project/.widi/profiles/nested", {
			recursive: true,
		});
		await env.writeFile("/workspace/project/.widi/profiles/b.md", "B prompt");
		await env.writeFile("/workspace/project/.widi/profiles/a.md", "A prompt");
		await env.writeFile(
			"/workspace/project/.widi/profiles/nested/ignored.md",
			"ignored",
		);
		const registry = new AgentProfileRegistry(
			new FileProfileStorageBackend(env, [
				{
					kind: "cwd",
					path: "/workspace/project/.widi/profiles",
					priority: 200,
					missingBehavior: "silent",
				},
			]),
		);

		const result = await registry.listProfiles();

		expect(result.profiles.map((profile) => profile.id)).toEqual(["a", "b"]);
		expect(result.profiles[0]).not.toHaveProperty("systemPrompt");
	});

	it("parses the commands policy from frontmatter", async () => {
		const env = new MemoryExecutionEnv();
		await env.createDir("/workspace/project/.widi/profiles", {
			recursive: true,
		});
		await env.writeFile(
			"/workspace/project/.widi/profiles/gated.md",
			"---\nid: gated\ncommands:\n  enabled: true\n  deny: [abort, steer]\n---\nGated prompt",
		);
		await env.writeFile(
			"/workspace/project/.widi/profiles/broken.md",
			"---\nid: broken\ncommands:\n  enabled: sometimes\n---\nBroken prompt",
		);
		const registry = new AgentProfileRegistry(
			new FileProfileStorageBackend(env, [
				{
					kind: "cwd",
					path: "/workspace/project/.widi/profiles",
					priority: 200,
					missingBehavior: "silent",
				},
			]),
		);

		const gated = await registry.resolveProfile("gated");
		expect(gated.ok).toBe(true);
		if (gated.ok) {
			expect(gated.profile.commands).toEqual({
				enabled: true,
				deny: ["abort", "steer"],
			});
		}

		const broken = await registry.resolveProfile("broken");
		expect(broken.ok).toBe(false);
		if (!broken.ok) {
			expect(broken.diagnostics).toContainEqual(
				expect.objectContaining({ code: "profile.invalid_metadata" }),
			);
		}
	});

	it("diagnoses missing explicit profile sources", async () => {
		const env = new MemoryExecutionEnv();
		const registry = new AgentProfileRegistry(
			new FileProfileStorageBackend(env, [
				{
					kind: "settings",
					path: "/missing.md",
					priority: 300,
					missingBehavior: "diagnostic",
				},
			]),
		);

		const result = await registry.listProfiles();

		expect(result.profiles).toEqual([]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "profile.source_missing" }),
		);
	});
});
