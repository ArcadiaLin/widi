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
import {
	createReadToolDefinition,
	READ_DEFAULT_MAX_BYTES,
	type ReadToolDetails,
} from "../../src/core/tools/coding/read.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";

class MemoryExecutionEnv implements ExecutionEnv {
	cwd = "/workspace";
	readonly textFiles = new Map<string, string>();
	readonly binaryFiles = new Map<string, Uint8Array>();

	private normalize(path: string): string {
		const absolute = path.startsWith("/") ? path : `${this.cwd}/${path}`;
		return absolute.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(this.normalize(path));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(this.normalize(parts.join("/")));
	}

	async readTextFile(path: string): Promise<Result<string, FileError>> {
		const normalized = this.normalize(path);
		const content = this.textFiles.get(normalized);
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

	async readBinaryFile(path: string): Promise<Result<Uint8Array, FileError>> {
		const normalized = this.normalize(path);
		const content = this.binaryFiles.get(normalized);
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

	async writeFile(
		path: string,
		content: string | Uint8Array,
	): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		if (typeof content === "string") {
			this.textFiles.set(normalized, content);
		} else {
			this.binaryFiles.set(normalized, content);
		}
		return ok(undefined);
	}

	async appendFile(
		path: string,
		content: string | Uint8Array,
	): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		if (typeof content === "string") {
			this.textFiles.set(
				normalized,
				(this.textFiles.get(normalized) ?? "") + content,
			);
		} else {
			const current = this.binaryFiles.get(normalized) ?? new Uint8Array();
			const next = new Uint8Array(current.length + content.length);
			next.set(current);
			next.set(content, current.length);
			this.binaryFiles.set(normalized, next);
		}
		return ok(undefined);
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const normalized = this.normalize(path);
		const text = this.textFiles.get(normalized);
		const binary = this.binaryFiles.get(normalized);
		const size = text?.length ?? binary?.byteLength;
		if (size === undefined) {
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
			size,
			mtimeMs: 0,
		});
	}

	async listDir(): Promise<Result<FileInfo[], FileError>> {
		return ok([]);
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		return ok(this.normalize(path));
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		const normalized = this.normalize(path);
		return ok(
			this.textFiles.has(normalized) || this.binaryFiles.has(normalized),
		);
	}

	async createDir(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async remove(path: string): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		this.textFiles.delete(normalized);
		this.binaryFiles.delete(normalized);
		return ok(undefined);
	}

	async createTempDir(): Promise<Result<string, FileError>> {
		return ok("/tmp/widi-test");
	}

	async createTempFile(): Promise<Result<string, FileError>> {
		return ok("/tmp/widi-test-file");
	}

	async exec(
		_command: string,
		_options?: ExecutionEnvExecOptions,
	): Promise<
		Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
	> {
		return err(new PiExecutionError("shell_unavailable", "shell unavailable"));
	}

	async cleanup(): Promise<void> {}
}

function createContext(
	env: ExecutionEnv | undefined,
): ToolExecutionContext<ReadToolDetails> {
	return {
		env,
		signal: undefined,
		onUpdate: undefined,
		extension: undefined,
		human: undefined,
	};
}

describe("read tool", () => {
	it("reads text through ExecutionEnv and returns Pi-style result details", async () => {
		const env = new MemoryExecutionEnv();
		env.textFiles.set("/workspace/src/app.ts", "line 1\nline 2");
		const tool = createReadToolDefinition();

		const result = await tool.execute(
			"call-1",
			{ path: "src/app.ts" },
			createContext(env),
		);

		expect(result).toEqual({
			content: [{ type: "text", text: "line 1\nline 2" }],
			details: {
				path: "src/app.ts",
				absolutePath: "/workspace/src/app.ts",
				bytes: 13,
			},
		});
	});

	it("supports offset and limit with continuation notice", async () => {
		const env = new MemoryExecutionEnv();
		env.textFiles.set("/workspace/src/app.ts", "a\nb\nc\nd");
		const tool = createReadToolDefinition();

		const result = await tool.execute(
			"call-1",
			{ path: "src/app.ts", offset: 2, limit: 2 },
			createContext(env),
		);

		expect(result.content).toEqual([
			{
				type: "text",
				text: "b\nc\n\n[1 more lines in file. Use offset=4 to continue.]",
			},
		]);
		expect(result.details).toEqual({
			path: "src/app.ts",
			absolutePath: "/workspace/src/app.ts",
			bytes: 7,
		});
	});

	it("adds truncation details when output exceeds the byte limit", async () => {
		const env = new MemoryExecutionEnv();
		const content = Array.from(
			{ length: 256 },
			(_, index) =>
				`line ${index.toString().padStart(3, "0")} ${"x".repeat(240)}`,
		).join("\n");
		env.textFiles.set("/workspace/large.txt", content);
		const tool = createReadToolDefinition();

		const result = await tool.execute(
			"call-1",
			{ path: "large.txt" },
			createContext(env),
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result.");
		}
		expect(result.content[0].text).toContain(
			`(${formatSize(READ_DEFAULT_MAX_BYTES)} limit). Use offset=`,
		);
		expect(result.details.truncation).toEqual(
			expect.objectContaining({
				truncated: true,
				truncatedBy: "bytes",
				maxBytes: READ_DEFAULT_MAX_BYTES,
			}),
		);
	});

	it("returns image content for supported image extensions", async () => {
		const env = new MemoryExecutionEnv();
		env.binaryFiles.set("/workspace/image.png", new Uint8Array([1, 2, 3]));
		const tool = createReadToolDefinition();

		const result = await tool.execute(
			"call-1",
			{ path: "image.png" },
			createContext(env),
		);

		expect(result).toEqual({
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "AQID", mimeType: "image/png" },
			],
			details: {
				path: "image.png",
				absolutePath: "/workspace/image.png",
				bytes: 3,
				mimeType: "image/png",
			},
		});
	});

	it("fails when no execution environment is provided", async () => {
		const tool = createReadToolDefinition();

		await expect(
			tool.execute("call-1", { path: "src/app.ts" }, createContext(undefined)),
		).rejects.toThrow(
			"read tool requires an execution environment with filesystem support.",
		);
	});
});

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
