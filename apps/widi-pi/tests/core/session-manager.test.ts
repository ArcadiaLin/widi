import type {
	FileError,
	FileInfo,
	FileSystem,
	Result,
} from "@earendil-works/pi-agent-core";
import {
	err,
	ok,
	FileError as PiFileError,
} from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../../src/core/agent-profile.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

class MemoryFileSystem implements FileSystem {
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

	async fileInfo(): Promise<Result<FileInfo, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
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

	async cleanup(): Promise<void> {}
}

const profile: AgentProfile = {
	id: "main",
	label: "Main Agent",
	systemPrompt: "You are WIDI.",
	persist: true,
	skills: ["code"],
	promptTemplates: ["review"],
};

describe("SessionManager", () => {
	it("stores agent profile references in extended jsonl session headers", async () => {
		const fs = new MemoryFileSystem();
		const manager = new SessionManager({
			fs,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
		});

		await manager.createAgentSession({
			agentId: "main",
			agentProfile: profile,
		});
		const [metadata] = await manager.sessionRepo.list({
			cwd: "/workspace/project",
		});
		const profileReference = { id: profile.id, label: profile.label };

		expect(metadata?.metadata?.profile).toEqual(profileReference);
		if (!metadata) throw new Error("Expected session metadata.");
		const headerLine = fs.files.get(metadata.path)?.split("\n")[0];
		if (!headerLine) throw new Error("Expected session header line.");
		expect(JSON.parse(headerLine)).toMatchObject({
			type: "session",
			version: 3,
			id: "main",
			metadata: { profile: profileReference },
		});
	});

	it("stores namespaced extension custom entries on the current branch path", async () => {
		const fs = new MemoryFileSystem();
		const manager = new SessionManager({
			fs,
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
		});
		const session = await manager.createAgentSession({
			agentId: "main",
			agentProfile: profile,
		});

		const firstId = await manager.appendExtensionCustomEntry(
			"main",
			"writer",
			"state",
			{ value: 1 },
		);
		await manager.appendExtensionCustomEntry("main", "writer", "note", {
			value: 2,
		});
		await manager.appendExtensionCustomEntry("main", "other", "state", {
			value: "other",
		});
		const secondId = await manager.appendExtensionCustomEntry(
			"main",
			"writer",
			"state",
			{ value: 3 },
		);

		await expect(
			manager.findExtensionCustomEntries<{ value: number }>(
				"main",
				"writer",
				"state",
			),
		).resolves.toEqual([
			expect.objectContaining({
				id: firstId,
				type: "state",
				data: { value: 1 },
			}),
			expect.objectContaining({
				id: secondId,
				type: "state",
				data: { value: 3 },
			}),
		]);
		await expect(
			manager.findExtensionCustomEntries("main", "writer"),
		).resolves.toMatchObject([
			{ type: "state", data: { value: 1 } },
			{ type: "note", data: { value: 2 } },
			{ type: "state", data: { value: 3 } },
		]);
		await expect(
			manager.findExtensionCustomEntries("main", "writer", "missing"),
		).resolves.toEqual([]);

		const storageCustomEntries = await session
			.getStorage()
			.findEntries("custom");
		expect(storageCustomEntries.map((entry) => entry.customType)).toEqual([
			"extension:writer:state",
			"extension:writer:note",
			"extension:other:state",
			"extension:writer:state",
		]);

		await session.getStorage().setLeafId(firstId);
		await expect(
			manager.findExtensionCustomEntries("main", "writer", "state"),
		).resolves.toMatchObject([{ id: firstId, type: "state" }]);
	});

	it("validates extension custom entry type and JSON serializability", async () => {
		const manager = new SessionManager({
			fs: new MemoryFileSystem(),
			cwd: "/workspace/project",
			sessionsRoot: "/sessions",
		});
		await manager.createAgentSession({
			agentId: "main",
			agentProfile: profile,
		});
		const circular: { self?: unknown } = {};
		circular.self = circular;

		await expect(
			manager.appendExtensionCustomEntry("main", "writer", " ", {}),
		).rejects.toThrow("must not be empty");
		await expect(
			manager.appendExtensionCustomEntry("main", "writer", "bad/type", {}),
		).rejects.toThrow("must contain only");
		await expect(
			manager.appendExtensionCustomEntry("main", "writer", "state", () => {}),
		).rejects.toThrow("JSON serializable");
		await expect(
			manager.appendExtensionCustomEntry("main", "writer", "state", circular),
		).rejects.toThrow("JSON serializable");
	});
});
