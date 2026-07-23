import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BackgroundJobChange,
	type BackgroundJobSettlement,
	BackgroundJobTable,
} from "../../src/core/background-job.ts";
import {
	createAgentHarnessToolFromResolvedTool,
	ToolRegistry,
} from "../../src/core/tool-registry.ts";
import type {
	ToolDefinition,
	ToolExecutionContext,
	ToolSource,
} from "../../src/core/tools/types.ts";

const coreSource: ToolSource = { kind: "core", id: "builtin" };
const emptyParams = Type.Object({});

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}

/** Build a backgroundable tool whose execute resolves when `gate` settles. */
function createBackgroundableTool(
	gate: Promise<AgentToolResult<undefined>>,
	onSignal?: (signal: AbortSignal | undefined) => void,
): ToolDefinition<typeof emptyParams, undefined> {
	return {
		name: "sleeper",
		label: "sleeper",
		description: "long running dummy",
		parameters: emptyParams,
		backgroundable: true,
		backgroundTimeoutMs: 50,
		execute: (_toolCallId, _params, context) => {
			onSignal?.(context.signal);
			return gate;
		},
	};
}

function resolveTool(
	definition: ToolDefinition<typeof emptyParams, undefined>,
) {
	const registry = new ToolRegistry();
	registry.defineTool(definition, coreSource);
	const resolvedTool = registry.resolve().getTool(definition.name);
	if (!resolvedTool) throw new Error("tool did not resolve");
	return createAgentHarnessToolFromResolvedTool(resolvedTool);
}

describe("backgroundable tool adapter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns the real result inline when it settles before the deadline", async () => {
		const table = new BackgroundJobTable();
		const changes: BackgroundJobChange[] = [];
		table.onChange((change) => changes.push(change));
		const gate = createDeferred<AgentToolResult<undefined>>();
		const agentTool = resolveTool(createBackgroundableTool(gate.promise));

		const execPromise = agentTool.execute("call-1", {}, undefined, undefined, {
			backgroundJobTable: table,
		});
		gate.resolve(textResult("done"));
		const result = await execPromise;

		expect(result.content).toEqual([{ type: "text", text: "done" }]);
		// Never backgrounded, so no change fired and no job lingers.
		expect(changes).toEqual([]);
		expect(table.list()).toEqual([]);
	});

	it("settles with a job handle at the deadline and delivers t1 later", async () => {
		const table = new BackgroundJobTable();
		const settlement = createDeferred<BackgroundJobSettlement>();
		table.onChange((change) => {
			if (change.transition === "settled") settlement.resolve(change);
		});
		const gate = createDeferred<AgentToolResult<undefined>>();
		const agentTool = resolveTool(createBackgroundableTool(gate.promise));

		const execPromise = agentTool.execute("call-1", {}, undefined, undefined, {
			backgroundJobTable: table,
		});
		await vi.advanceTimersByTimeAsync(50);
		const t0 = await execPromise;

		expect(t0.details).toEqual({
			jobId: "job-1",
			toolCallId: "call-1",
			toolName: "sleeper",
			backgrounded: true,
		});
		// The job stays live in the background until its promise settles.
		expect(table.list()).toHaveLength(1);
		expect(table.get("job-1")?.phase).toBe("backgrounded");

		gate.resolve(textResult("late result"));
		const delivered = await settlement.promise;

		expect(delivered.job.id).toBe("job-1");
		expect(delivered.outcome.status).toBe("completed");
		expect(delivered.outcome.result?.content).toEqual([
			{ type: "text", text: "late result" },
		]);
		expect(table.list()).toEqual([]);
	});

	it("propagates a rejection inline when it fails before the deadline", async () => {
		const table = new BackgroundJobTable();
		const gate = createDeferred<AgentToolResult<undefined>>();
		const agentTool = resolveTool(createBackgroundableTool(gate.promise));

		const execPromise = agentTool.execute("call-1", {}, undefined, undefined, {
			backgroundJobTable: table,
		});
		gate.reject(new Error("boom"));

		await expect(execPromise).rejects.toThrow("boom");
		expect(table.list()).toEqual([]);
	});

	it("runs the tool under the job signal, decoupled from the run signal after t0", async () => {
		const table = new BackgroundJobTable();
		const gate = createDeferred<AgentToolResult<undefined>>();
		let toolSignal: AbortSignal | undefined;
		const agentTool = resolveTool(
			createBackgroundableTool(gate.promise, (signal) => {
				toolSignal = signal;
			}),
		);

		const runController = new AbortController();
		const execPromise = agentTool.execute(
			"call-1",
			{},
			runController.signal,
			undefined,
			{ backgroundJobTable: table },
		);
		await vi.advanceTimersByTimeAsync(50);
		await execPromise;

		// The tool saw the job's own signal, distinct from the run signal.
		expect(toolSignal).toBeDefined();
		expect(toolSignal).not.toBe(runController.signal);
		expect(toolSignal).toBe(table.get("job-1")?.signal);

		// After t0 the run signal no longer owns the job: aborting it does nothing.
		runController.abort();
		expect(toolSignal?.aborted).toBe(false);

		// The job table still owns the lifecycle and can cancel it.
		table.abort("job-1");
		expect(toolSignal?.aborted).toBe(true);

		gate.resolve(textResult("ignored"));
		await Promise.resolve();
	});

	it("normalizes a synchronous throw from execute and cleans up the job", async () => {
		const table = new BackgroundJobTable();
		const definition: ToolDefinition<typeof emptyParams, undefined> = {
			name: "sleeper",
			label: "sleeper",
			description: "throws synchronously",
			parameters: emptyParams,
			backgroundable: true,
			backgroundTimeoutMs: 50,
			execute: () => {
				throw new Error("sync boom");
			},
		};
		const agentTool = resolveTool(definition);

		await expect(
			agentTool.execute("call-1", {}, undefined, undefined, {
				backgroundJobTable: table,
			}),
		).rejects.toThrow("sync boom");
		// The job is settled and removed rather than orphaned in the table.
		expect(table.list()).toEqual([]);
	});

	it("normalizes a plain synchronous result from an untyped execute", async () => {
		const table = new BackgroundJobTable();
		const definition = {
			name: "sleeper",
			label: "sleeper",
			description: "returns a plain result",
			parameters: emptyParams,
			backgroundable: true,
			backgroundTimeoutMs: 50,
			execute: () => textResult("sync result"),
		} as unknown as ToolDefinition<typeof emptyParams, undefined>;
		const agentTool = resolveTool(definition);

		await expect(
			agentTool.execute("call-1", {}, undefined, undefined, {
				backgroundJobTable: table,
			}),
		).resolves.toEqual(textResult("sync result"));
		expect(table.list()).toEqual([]);
	});

	it("backgrounds immediately when the call requests it, without a configured deadline", async () => {
		const table = new BackgroundJobTable();
		const settlement = createDeferred<BackgroundJobSettlement>();
		table.onChange((change) => {
			if (change.transition === "settled") settlement.resolve(change);
		});
		const gate = createDeferred<AgentToolResult<undefined>>();
		const definition: ToolDefinition<typeof emptyParams, undefined> = {
			name: "sleeper",
			label: "sleeper",
			description: "no wall-clock deadline; explicit request only",
			parameters: emptyParams,
			backgroundable: true,
			execute: () => gate.promise,
		};
		const agentTool = resolveTool(definition);

		const execPromise = agentTool.execute(
			"call-1",
			{ background: true },
			undefined,
			undefined,
			{ backgroundJobTable: table },
		);
		// A deadline of 0 backgrounds on the next macrotask, not inline.
		await vi.advanceTimersByTimeAsync(0);
		const t0 = await execPromise;

		expect(t0.details).toEqual({
			jobId: "job-1",
			toolCallId: "call-1",
			toolName: "sleeper",
			backgrounded: true,
		});
		expect(table.get("job-1")?.phase).toBe("backgrounded");

		gate.resolve(textResult("late result"));
		const delivered = await settlement.promise;
		expect(delivered.outcome.status).toBe("completed");
	});

	it("stays synchronous when no deadline is configured and the call does not request background", async () => {
		const table = new BackgroundJobTable();
		const gate = createDeferred<AgentToolResult<undefined>>();
		const definition: ToolDefinition<typeof emptyParams, undefined> = {
			name: "sleeper",
			label: "sleeper",
			description: "no wall-clock deadline; explicit request only",
			parameters: emptyParams,
			backgroundable: true,
			execute: () => gate.promise,
		};
		const agentTool = resolveTool(definition);

		const execPromise = agentTool.execute("call-1", {}, undefined, undefined, {
			backgroundJobTable: table,
		});
		// No deadline and no request: it must never register a job or background.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(table.list()).toEqual([]);

		gate.resolve(textResult("inline"));
		const result = await execPromise;
		expect(result.content).toEqual([{ type: "text", text: "inline" }]);
		expect(table.list()).toEqual([]);
	});

	it("injects the job context and mirrors appended output into the table", async () => {
		const table = new BackgroundJobTable();
		const gate = createDeferred<AgentToolResult<undefined>>();
		let jobContext: ToolExecutionContext<undefined>["job"];
		const definition: ToolDefinition<typeof emptyParams, undefined> = {
			name: "sleeper",
			label: "sleeper",
			description: "reports its job context",
			parameters: emptyParams,
			backgroundable: true,
			backgroundTimeoutMs: 50,
			execute: (_toolCallId, _params, context) => {
				jobContext = context.job;
				context.job?.output.append("step 1\n");
				return gate.promise;
			},
		};
		const agentTool = resolveTool(definition);

		const execPromise = agentTool.execute("call-1", {}, undefined, undefined, {
			backgroundJobTable: table,
		});
		expect(jobContext?.id).toBe("job-1");
		// The context buffer is the job's own: the live tail is reachable through
		// the table before the call even settles.
		expect(table.get("job-1")?.output.read()).toBe("step 1\n");

		await vi.advanceTimersByTimeAsync(50);
		await execPromise;
		gate.resolve(textResult("done"));
	});

	it("does not inject a job context on the plain synchronous path", async () => {
		const table = new BackgroundJobTable();
		let sawJob: ToolExecutionContext<undefined>["job"] | "unset" = "unset";
		const definition: ToolDefinition<typeof emptyParams, undefined> = {
			name: "sleeper",
			label: "sleeper",
			description: "no deadline, no background request",
			parameters: emptyParams,
			backgroundable: true,
			execute: async (_toolCallId, _params, context) => {
				sawJob = context.job;
				return textResult("inline");
			},
		};
		const agentTool = resolveTool(definition);

		await agentTool.execute("call-1", {}, undefined, undefined, {
			backgroundJobTable: table,
		});
		expect(sawJob).toBeUndefined();
	});

	it("lets the run signal cancel the call before it is backgrounded", async () => {
		const table = new BackgroundJobTable();
		const gate = createDeferred<AgentToolResult<undefined>>();
		let toolSignal: AbortSignal | undefined;
		const agentTool = resolveTool(
			createBackgroundableTool(gate.promise, (signal) => {
				toolSignal = signal;
			}),
		);

		const runController = new AbortController();
		const execPromise = agentTool.execute(
			"call-1",
			{},
			runController.signal,
			undefined,
			{ backgroundJobTable: table },
		);

		// Still in the synchronous window (deadline not advanced): a user
		// interrupt on the run signal must cancel the in-flight call.
		runController.abort();
		expect(toolSignal?.aborted).toBe(true);

		gate.reject(new Error("aborted"));
		await expect(execPromise).rejects.toThrow("aborted");
		expect(table.list()).toEqual([]);
	});
});
