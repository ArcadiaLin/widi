import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BackgroundJobSettlement,
	BackgroundJobTable,
} from "../../src/core/background-job.ts";
import {
	createAgentToolFromResolvedTool,
	ToolRegistry,
} from "../../src/core/tool-registry.ts";
import type { ToolDefinition, ToolSource } from "../../src/core/tools/types.ts";

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
	table: BackgroundJobTable,
) {
	const registry = new ToolRegistry();
	registry.defineTool(definition, coreSource);
	const resolvedTool = registry.resolve().getTool(definition.name);
	if (!resolvedTool) throw new Error("tool did not resolve");
	return createAgentToolFromResolvedTool(resolvedTool, {
		backgroundJobTable: table,
	});
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
		const settlements: BackgroundJobSettlement[] = [];
		table.onResult((settlement) => settlements.push(settlement));
		const gate = createDeferred<AgentToolResult<undefined>>();
		const agentTool = resolveTool(
			createBackgroundableTool(gate.promise),
			table,
		);

		const execPromise = agentTool.execute("call-1", {}, undefined, undefined);
		gate.resolve(textResult("done"));
		const result = await execPromise;

		expect(result.content).toEqual([{ type: "text", text: "done" }]);
		// Never backgrounded, so no listener fired and no job lingers.
		expect(settlements).toEqual([]);
		expect(table.list()).toEqual([]);
	});

	it("settles with a job handle at the deadline and delivers t1 later", async () => {
		const table = new BackgroundJobTable();
		const settlement = createDeferred<BackgroundJobSettlement>();
		table.onResult((value) => settlement.resolve(value));
		const gate = createDeferred<AgentToolResult<undefined>>();
		const agentTool = resolveTool(
			createBackgroundableTool(gate.promise),
			table,
		);

		const execPromise = agentTool.execute("call-1", {}, undefined, undefined);
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
		const agentTool = resolveTool(
			createBackgroundableTool(gate.promise),
			table,
		);

		const execPromise = agentTool.execute("call-1", {}, undefined, undefined);
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
			table,
		);

		const runController = new AbortController();
		const execPromise = agentTool.execute(
			"call-1",
			{},
			runController.signal,
			undefined,
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
		const agentTool = resolveTool(definition, table);

		await expect(
			agentTool.execute("call-1", {}, undefined, undefined),
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
		const agentTool = resolveTool(definition, table);

		await expect(
			agentTool.execute("call-1", {}, undefined, undefined),
		).resolves.toEqual(textResult("sync result"));
		expect(table.list()).toEqual([]);
	});

	it("lets the run signal cancel the call before it is backgrounded", async () => {
		const table = new BackgroundJobTable();
		const gate = createDeferred<AgentToolResult<undefined>>();
		let toolSignal: AbortSignal | undefined;
		const agentTool = resolveTool(
			createBackgroundableTool(gate.promise, (signal) => {
				toolSignal = signal;
			}),
			table,
		);

		const runController = new AbortController();
		const execPromise = agentTool.execute(
			"call-1",
			{},
			runController.signal,
			undefined,
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
