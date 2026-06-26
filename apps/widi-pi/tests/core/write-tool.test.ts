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
	createWriteToolDefinition,
	type WriteToolDetails,
} from "../../src/core/tools/coding/write.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";

class MemoryExecutionEnv implements ExecutionEnv {
	cwd = "/workspace";
	readonly files = new Map<string, string>();

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
		this.files.set(
			this.normalize(path),
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
): ToolExecutionContext<WriteToolDetails> {
	return {
		env,
		signal: undefined,
		onUpdate: undefined,
		extension: undefined,
		human: undefined,
	};
}

describe("write tool", () => {
	it("writes content through ExecutionEnv and returns Pi-style result details", async () => {
		const env = new MemoryExecutionEnv();
		const tool = createWriteToolDefinition();

		const result = await tool.execute(
			"call-1",
			{ path: "src/app.ts", content: "console.log('hi');" },
			createContext(env),
		);

		expect(env.files.get("/workspace/src/app.ts")).toBe("console.log('hi');");
		expect(result).toEqual({
			content: [
				{
					type: "text",
					text: "Successfully wrote 18 bytes to src/app.ts",
				},
			],
			details: {
				path: "src/app.ts",
				absolutePath: "/workspace/src/app.ts",
				bytes: 18,
			},
		});
	});

	it("fails when no execution environment is provided", async () => {
		const tool = createWriteToolDefinition();

		await expect(
			tool.execute(
				"call-1",
				{ path: "src/app.ts", content: "content" },
				createContext(undefined),
			),
		).rejects.toThrow(
			"write tool requires an execution environment with filesystem support.",
		);
	});
});
