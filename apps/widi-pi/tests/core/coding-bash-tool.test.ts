import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BashOperations,
	type BashToolDetails,
	createBashToolDefinition,
} from "../../src/core/tools/coding/bash.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";

type BashResult = AgentToolResult<BashToolDetails | undefined>;

function makeContext(
	overrides: Partial<ToolExecutionContext<BashToolDetails | undefined>> = {},
): ToolExecutionContext<BashToolDetails | undefined> {
	return {
		signal: undefined,
		onUpdate: undefined,
		extension: undefined,
		human: undefined,
		...overrides,
	};
}

function textOf(result: BashResult): string {
	const first = result.content[0];
	if (!first || first.type !== "text") {
		throw new Error("Expected a text content block");
	}
	return first.text;
}

describe("bash tool", () => {
	const tempRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(
			tempRoots.map((root) => rm(root, { force: true, recursive: true })),
		);
		tempRoots.length = 0;
	});

	async function tempCwd(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "widi-bash-"));
		tempRoots.push(root);
		return root;
	}

	it("runs a simple command and returns its output", async () => {
		const cwd = await tempCwd();
		const tool = createBashToolDefinition(cwd);
		const result = await tool.execute(
			"call-1",
			{ command: "echo hi" },
			makeContext(),
		);
		expect(textOf(result)).toBe("hi\n");
	});

	it("returns (no output) for a command that prints nothing", async () => {
		const cwd = await tempCwd();
		const tool = createBashToolDefinition(cwd);
		const result = await tool.execute(
			"call-1",
			{ command: "true" },
			makeContext(),
		);
		expect(textOf(result)).toBe("(no output)");
	});

	it("merges stdout and stderr in arrival order", async () => {
		const cwd = await tempCwd();
		const tool = createBashToolDefinition(cwd);
		const result = await tool.execute(
			"call-1",
			{ command: "echo out; echo err 1>&2" },
			makeContext(),
		);
		expect(textOf(result)).toBe("out\nerr\n");
	});

	it("applies a command prefix before the user command", async () => {
		const cwd = await tempCwd();
		const tool = createBashToolDefinition(cwd, {
			commandPrefix: "echo prefixed",
		});
		const result = await tool.execute(
			"call-1",
			{ command: "echo actual" },
			makeContext(),
		);
		expect(textOf(result)).toBe("prefixed\nactual\n");
	});

	it("runs with an explicit shell path", async () => {
		const cwd = await tempCwd();
		const tool = createBashToolDefinition(cwd, { shellPath: "/bin/bash" });
		const result = await tool.execute(
			"call-1",
			{ command: "echo shelled" },
			makeContext(),
		);
		expect(textOf(result)).toBe("shelled\n");
	});

	it("throws on a non-zero exit code and preserves output", async () => {
		const cwd = await tempCwd();
		const tool = createBashToolDefinition(cwd);
		await expect(
			tool.execute("call-1", { command: "echo before; exit 3" }, makeContext()),
		).rejects.toThrow(/before[\s\S]*Command exited with code 3/);
	});

	it("throws when the working directory does not exist", async () => {
		const tool = createBashToolDefinition("/no/such/widi/dir");
		await expect(
			tool.execute("call-1", { command: "echo hi" }, makeContext()),
		).rejects.toThrow(/Working directory does not exist/);
	});

	it("throws when the configured shell path is missing", async () => {
		const cwd = await tempCwd();
		const tool = createBashToolDefinition(cwd, {
			shellPath: "/no/such/shell",
		});
		await expect(
			tool.execute("call-1", { command: "echo hi" }, makeContext()),
		).rejects.toThrow(/Custom shell path not found/);
	});

	it("rejects an invalid timeout", async () => {
		const cwd = await tempCwd();
		const tool = createBashToolDefinition(cwd);
		await expect(
			tool.execute(
				"call-1",
				{ command: "echo hi", timeout: -1 },
				makeContext(),
			),
		).rejects.toThrow(/Invalid timeout/);
	});

	it("kills the process and reports a timeout", async () => {
		const cwd = await tempCwd();
		const tool = createBashToolDefinition(cwd);
		await expect(
			tool.execute(
				"call-1",
				{ command: "sleep 5", timeout: 0.2 },
				makeContext(),
			),
		).rejects.toThrow(/Command timed out after 0.2 seconds/);
	}, 10000);

	it("aborts a running command via the signal", async () => {
		const cwd = await tempCwd();
		const tool = createBashToolDefinition(cwd);
		const controller = new AbortController();
		const pending = tool.execute(
			"call-1",
			{ command: "sleep 5" },
			makeContext({ signal: controller.signal }),
		);
		setTimeout(() => controller.abort(), 50);
		await expect(pending).rejects.toThrow(/Command aborted/);
	}, 10000);

	it("emits an empty partial first and streams content updates", async () => {
		const cwd = await tempCwd();
		const tool = createBashToolDefinition(cwd);
		const updates: BashResult[] = [];
		const result = await tool.execute(
			"call-1",
			{ command: "echo streamed" },
			makeContext({ onUpdate: (partial) => updates.push(partial) }),
		);
		expect(updates.length).toBeGreaterThanOrEqual(1);
		expect(updates[0]?.content).toEqual([]);
		expect(textOf(result)).toBe("streamed\n");
	});

	it("throttles updates when output arrives in many quick chunks", async () => {
		const ops: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 0; i < 6; i++) {
					onData(Buffer.from(`chunk-${i}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition("/workspace", { operations: ops });
		const updates: BashResult[] = [];
		const result = await tool.execute(
			"call-1",
			{ command: "noop" },
			makeContext({ onUpdate: (partial) => updates.push(partial) }),
		);
		// Empty partial + at most a couple of coalesced content updates, far fewer
		// than the six chunks.
		expect(updates.length).toBeLessThan(6);
		expect(updates[0]?.content).toEqual([]);
		expect(textOf(result)).toBe(
			"chunk-0\nchunk-1\nchunk-2\nchunk-3\nchunk-4\nchunk-5\n",
		);
	});

	it("decodes UTF-8 characters split across data chunks", async () => {
		const euro = Buffer.from("€", "utf-8");
		const ops: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.concat([Buffer.from("price "), euro.subarray(0, 1)]));
				onData(Buffer.concat([euro.subarray(1), Buffer.from("5\n")]));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition("/workspace", { operations: ops });
		const result = await tool.execute(
			"call-1",
			{ command: "noop" },
			makeContext(),
		);
		expect(textOf(result)).toBe("price €5\n");
	});

	it("truncates long output by line count and spills to a temp file", async () => {
		const ops: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 0; i < 2100; i++) {
					onData(Buffer.from(`line-${i}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition("/workspace", { operations: ops });
		const result = await tool.execute(
			"call-1",
			{ command: "noop" },
			makeContext(),
		);
		expect(result.details?.truncation?.truncated).toBe(true);
		expect(result.details?.truncation?.truncatedBy).toBe("lines");
		const fullOutputPath = result.details?.fullOutputPath;
		expect(fullOutputPath).toBeDefined();
		expect(textOf(result)).toMatch(/Full output: /);
		if (fullOutputPath) {
			tempRoots.push(fullOutputPath);
			await expect(stat(fullOutputPath)).resolves.toBeDefined();
		}
	});

	it("preserves output emitted before a non-zero exit through the seam", async () => {
		const ops: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("partial work\n"));
				return { exitCode: 2 };
			},
		};
		const tool = createBashToolDefinition("/workspace", { operations: ops });
		await expect(
			tool.execute("call-1", { command: "noop" }, makeContext()),
		).rejects.toThrow(/partial work[\s\S]*Command exited with code 2/);
	});

	it("ignores a late output callback after the tool settles", async () => {
		let capturedOnData: ((data: Buffer) => void) | undefined;
		const ops: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				capturedOnData = onData;
				onData(Buffer.from("done\n"));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition("/workspace", { operations: ops });
		const result = await tool.execute(
			"call-1",
			{ command: "noop" },
			makeContext(),
		);
		expect(textOf(result)).toBe("done\n");
		// A callback arriving after settle must neither throw nor mutate the result.
		expect(() => capturedOnData?.(Buffer.from("late output"))).not.toThrow();
		expect(textOf(result)).toBe("done\n");
	});
});
