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
	BASH_DEFAULT_MAX_BYTES,
	type BashToolDetails,
	createBashToolDefinition,
} from "../../src/core/tools/coding/bash.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";

type ExecHandler = (
	command: string,
	options?: ExecutionEnvExecOptions,
) => Promise<
	Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
>;

class MemoryExecutionEnv implements ExecutionEnv {
	cwd = "/workspace";
	readonly files = new Map<string, string | Uint8Array>();
	readonly execCalls: Array<{
		command: string;
		options?: ExecutionEnvExecOptions;
	}> = [];
	private readonly execHandler: ExecHandler;
	private nextTempId = 1;

	constructor(execHandler: ExecHandler) {
		this.execHandler = execHandler;
	}

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
		const content = this.files.get(this.normalize(path));
		if (typeof content === "string") return ok(content);
		return err(new PiFileError("not_found", "File not found"));
	}

	async readTextLines(path: string): Promise<Result<string[], FileError>> {
		const result = await this.readTextFile(path);
		if (!result.ok) return result;
		return ok(result.value.split("\n"));
	}

	async readBinaryFile(path: string): Promise<Result<Uint8Array, FileError>> {
		const content = this.files.get(this.normalize(path));
		if (content instanceof Uint8Array) return ok(content);
		if (typeof content === "string") return ok(Buffer.from(content));
		return err(new PiFileError("not_found", "File not found"));
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
	): Promise<Result<void, FileError>> {
		this.files.set(this.normalize(path), content);
		return ok(undefined);
	}

	async appendFile(
		path: string,
		content: string | Uint8Array,
	): Promise<Result<void, FileError>> {
		const normalized = this.normalize(path);
		const current = this.files.get(normalized);
		const currentText =
			current === undefined
				? ""
				: typeof current === "string"
					? current
					: Buffer.from(current).toString("utf-8");
		const next =
			typeof content === "string"
				? content
				: Buffer.from(content).toString("utf-8");
		this.files.set(normalized, currentText + next);
		return ok(undefined);
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const normalized = this.normalize(path);
		const content = this.files.get(normalized);
		if (content === undefined) {
			return err(new PiFileError("not_found", "Path not found", normalized));
		}
		return ok({
			name: normalized.slice(normalized.lastIndexOf("/") + 1),
			path: normalized,
			kind: "file",
			size: typeof content === "string" ? content.length : content.byteLength,
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
		return ok(this.files.has(this.normalize(path)));
	}

	async createDir(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async remove(path: string): Promise<Result<void, FileError>> {
		this.files.delete(this.normalize(path));
		return ok(undefined);
	}

	async createTempDir(): Promise<Result<string, FileError>> {
		return ok("/tmp/widi-test");
	}

	async createTempFile(): Promise<Result<string, FileError>> {
		const path = `/tmp/widi-bash-${this.nextTempId}.log`;
		this.nextTempId += 1;
		return ok(path);
	}

	async exec(
		command: string,
		options?: ExecutionEnvExecOptions,
	): Promise<
		Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
	> {
		this.execCalls.push({ command, options });
		return await this.execHandler(command, options);
	}

	async cleanup(): Promise<void> {}
}

function createContext(
	env: ExecutionEnv | undefined,
	onUpdate?: ToolExecutionContext<BashToolDetails | undefined>["onUpdate"],
): ToolExecutionContext<BashToolDetails | undefined> {
	return {
		env,
		signal: undefined,
		onUpdate,
		extension: undefined,
		human: undefined,
	};
}

describe("bash tool", () => {
	it("executes commands through ExecutionEnv and returns streamed output", async () => {
		const env = new MemoryExecutionEnv(async (_command, options) => {
			options?.onStdout?.("hello\n");
			options?.onStderr?.("warn\n");
			return ok({ stdout: "", stderr: "", exitCode: 0 });
		});
		const tool = createBashToolDefinition();

		const result = await tool.execute(
			"call-1",
			{ command: "npm test", timeout: 10 },
			createContext(env),
		);

		expect(env.execCalls[0]).toMatchObject({
			command: "npm test",
			options: { cwd: "/workspace", timeout: 10 },
		});
		expect(result).toEqual({
			content: [{ type: "text", text: "hello\nwarn\n" }],
			details: undefined,
		});
	});

	it("falls back to returned stdout and stderr when the backend does not stream", async () => {
		const env = new MemoryExecutionEnv(async () =>
			ok({ stdout: "out\n", stderr: "err\n", exitCode: 0 }),
		);
		const tool = createBashToolDefinition();

		const result = await tool.execute(
			"call-1",
			{ command: "echo out" },
			createContext(env),
		);

		expect(result.content).toEqual([{ type: "text", text: "out\nerr\n" }]);
	});

	it("throws with output and exit code when the command fails", async () => {
		const env = new MemoryExecutionEnv(async (_command, options) => {
			options?.onStdout?.("build failed\n");
			return ok({ stdout: "", stderr: "", exitCode: 2 });
		});
		const tool = createBashToolDefinition();

		await expect(
			tool.execute("call-1", { command: "npm run build" }, createContext(env)),
		).rejects.toThrow("build failed\n\n\nCommand exited with code 2");
	});

	it("formats timeout errors with partial output", async () => {
		const env = new MemoryExecutionEnv(async (_command, options) => {
			options?.onStdout?.("still running\n");
			return err(new PiExecutionError("timeout", "timed out"));
		});
		const tool = createBashToolDefinition();

		await expect(
			tool.execute(
				"call-1",
				{ command: "sleep 10", timeout: 3 },
				createContext(env),
			),
		).rejects.toThrow("still running\n\n\nCommand timed out after 3 seconds");
	});

	it("emits output updates as data streams", async () => {
		const env = new MemoryExecutionEnv(async (_command, options) => {
			options?.onStdout?.("first\n");
			options?.onStdout?.("second\n");
			return ok({ stdout: "", stderr: "", exitCode: 0 });
		});
		const updates: Array<unknown> = [];
		const tool = createBashToolDefinition();

		await tool.execute(
			"call-1",
			{ command: "printf" },
			createContext(env, (update) => updates.push(update)),
		);

		expect(updates).toEqual([
			{ content: [{ type: "text", text: "first\n" }], details: undefined },
			{
				content: [{ type: "text", text: "first\nsecond\n" }],
				details: undefined,
			},
		]);
	});

	it("truncates long output from the tail and persists the full output", async () => {
		const fullOutput = Array.from(
			{ length: 256 },
			(_, index) =>
				`line ${index.toString().padStart(3, "0")} ${"x".repeat(240)}`,
		).join("\n");
		const env = new MemoryExecutionEnv(async () =>
			ok({ stdout: fullOutput, stderr: "", exitCode: 0 }),
		);
		const tool = createBashToolDefinition();

		const result = await tool.execute(
			"call-1",
			{ command: "large-output" },
			createContext(env),
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result.");
		}
		expect(result.content[0].text).toContain(
			`(${formatSize(BASH_DEFAULT_MAX_BYTES)} limit). Full output: /tmp/widi-bash-1.log`,
		);
		expect(result.details?.truncation).toEqual(
			expect.objectContaining({
				truncated: true,
				truncatedBy: "bytes",
				maxBytes: BASH_DEFAULT_MAX_BYTES,
			}),
		);
		expect(result.details?.fullOutputPath).toBe("/tmp/widi-bash-1.log");
		expect(env.files.get("/tmp/widi-bash-1.log")).toBe(fullOutput);
	});

	it("fails when no execution environment is provided", async () => {
		const tool = createBashToolDefinition();

		await expect(
			tool.execute("call-1", { command: "pwd" }, createContext(undefined)),
		).rejects.toThrow(
			"bash tool requires an execution environment with shell support.",
		);
	});
});

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
