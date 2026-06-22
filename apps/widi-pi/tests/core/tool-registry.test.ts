import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	createAgentToolFromResolvedTool,
	ToolRegistry,
} from "../../src/core/tools/tool-registry.ts";
import { InMemoryToolTracker } from "../../src/core/tools/tracker.ts";
import type {
	SessionFact,
	SessionFactDefinition,
	SessionFactDraft,
	SessionFactQuery,
	SessionFactStore,
	ToolContributionSource,
	ToolDefinition,
} from "../../src/core/tools/types.ts";

const emptyParams = Type.Object({});

const coreSource: ToolContributionSource = { kind: "core", id: "builtin" };
const extensionSource: ToolContributionSource = { kind: "extension", id: "ext" };

class MemorySessionFactStore implements SessionFactStore {
	private readonly facts: SessionFact[] = [];

	async append<TPayload>(fact: SessionFactDraft<TPayload>): Promise<SessionFact<TPayload>> {
		const stored = {
			...fact,
			id: `fact-${this.facts.length + 1}`,
			parentId: null,
			timestamp: "2026-06-16T00:00:00.000Z",
		};
		this.facts.push(stored);
		return stored;
	}

	async get<TPayload = unknown>(id: string): Promise<SessionFact<TPayload> | undefined> {
		return this.facts.find((fact) => fact.id === id) as SessionFact<TPayload> | undefined;
	}

	async find<TPayload = unknown>(query: SessionFactQuery = {}): Promise<Array<SessionFact<TPayload>>> {
		return this.facts.filter((fact) => {
			if (query.namespace !== undefined && fact.namespace !== query.namespace) return false;
			if (query.source !== undefined && fact.source !== query.source) return false;
			if (query.sourceName !== undefined && fact.sourceName !== query.sourceName) return false;
			if (query.factType !== undefined && fact.factType !== query.factType) return false;
			if (query.version !== undefined && fact.version !== query.version) return false;
			if (query.toolCallId !== undefined && fact.toolCallId !== query.toolCallId) return false;
			return true;
		}) as Array<SessionFact<TPayload>>;
	}

	async restore<TPayload = unknown, TRestored = TPayload>(
		definition: SessionFactDefinition<TPayload, TRestored>,
		query: Omit<SessionFactQuery, "namespace" | "factType" | "version"> = {},
	): Promise<TRestored[]> {
		const facts = await this.find<TPayload>({
			...query,
			namespace: definition.namespace,
			factType: definition.factType,
			version: definition.version,
		});
		return Promise.all(facts.map((fact) => definition.restore(fact)));
	}
}

function createTool(name: string, content: string = name): ToolDefinition<typeof emptyParams, undefined> {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: emptyParams,
		execute: async (): Promise<AgentToolResult<undefined>> => ({
			content: [{ type: "text", text: content }],
			details: undefined,
		}),
	};
}

function createUpdatingTool(): ToolDefinition<typeof emptyParams, { count: number }> {
	return {
		name: "update",
		label: "update",
		description: "update tool",
		parameters: emptyParams,
		tracking: {
			mode: "metadata",
			describeUpdate: (update) => update.details,
			describeResult: (result) => result.details,
		},
		execute: async (_toolCallId, _params, context) => {
			context.onUpdate?.({
				content: [{ type: "text", text: "partial" }],
				details: { count: 1 },
			});
			return {
				content: [{ type: "text", text: "done" }],
				details: { count: 2 },
			};
		},
	};
}

describe("ToolRegistry", () => {
	it("resolves define and patch contributions with deterministic middleware order", async () => {
		const calls: string[] = [];
		const registry = new ToolRegistry();
		registry.addContribution({ type: "define", source: coreSource, tool: createTool("write", "base") });
		registry.addContribution({
			type: "patch",
			source: { kind: "extension", id: "audit" },
			targetToolName: "write",
			priority: 5,
			patch: {
				aroundExecute: async (next, toolCallId, params, context) => {
					calls.push("audit:before");
					const result = await next(toolCallId, params, context);
					calls.push("audit:after");
					return result;
				},
			},
		});
		registry.addContribution({
			type: "patch",
			source: { kind: "extension", id: "sandbox" },
			targetToolName: "write",
			priority: 10,
			patch: {
				label: "Write via sandbox",
				aroundExecute: async (next, toolCallId, params, context) => {
					calls.push("sandbox:before");
					const result = await next(toolCallId, params, context);
					calls.push("sandbox:after");
					return result;
				},
			},
		});

		const result = registry.resolve();
		const resolvedTool = result.getTool("write");
		expect(resolvedTool?.definition.label).toBe("Write via sandbox");
		expect(resolvedTool?.patches.map((patch) => patch.source.id)).toEqual(["audit", "sandbox"]);

		const agentTool = createAgentToolFromResolvedTool(resolvedTool!, { session: new MemorySessionFactStore() });
		const toolResult = await agentTool.execute("call-1", {});

		expect(toolResult.content).toEqual([{ type: "text", text: "base" }]);
		expect(calls).toEqual(["sandbox:before", "audit:before", "audit:after", "sandbox:after"]);
	});

	it("keeps one definition for duplicate tool names and reports a conflict", () => {
		const registry = new ToolRegistry();
		registry.addContribution({ type: "define", source: coreSource, priority: 0, tool: createTool("read", "core") });
		registry.addContribution({
			type: "define",
			source: extensionSource,
			priority: 10,
			tool: createTool("read", "extension"),
		});

		const result = registry.resolve();

		expect(result.getToolDefinition("read")?.label).toBe("read");
		expect(result.getTool("read")?.source).toEqual(extensionSource);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "tool_define_conflict",
				toolName: "read",
				source: coreSource,
				targetSource: extensionSource,
			}),
		);
	});

	it("reports missing requested and active tools while keeping valid names", () => {
		const registry = new ToolRegistry();
		registry.addContribution({ type: "define", source: coreSource, tool: createTool("read") });
		registry.addContribution({ type: "define", source: coreSource, tool: createTool("write") });

		const result = registry.resolve({
			requestedToolNames: ["read", "missing", "read"],
			activeToolNames: ["read", "write", "ghost", "read"],
		});

		expect(result.toolNames).toEqual(["read"]);
		expect(result.activeToolNames).toEqual(["read"]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"tool_requested_duplicate",
			"tool_requested_missing",
			"tool_active_duplicate",
			"tool_active_missing",
			"tool_active_missing",
		]);
	});

	it("reports patches that target missing tools", () => {
		const registry = new ToolRegistry();
		registry.addContribution({
			type: "patch",
			source: extensionSource,
			targetToolName: "write",
			patch: { label: "Write elsewhere" },
		});

		const result = registry.resolve();

		expect(result.tools).toEqual([]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "tool_patch_target_missing",
				toolName: "write",
				source: extensionSource,
			}),
		);
	});

	it("tracks resolved tool execution with minimal metadata by default", async () => {
		const registry = new ToolRegistry();
		registry.addContribution({ type: "define", source: coreSource, tool: createTool("read", "ok") });
		const tracker = new InMemoryToolTracker();
		const resolvedTool = registry.resolve().getTool("read");
		const agentTool = createAgentToolFromResolvedTool(resolvedTool!, {
			session: new MemorySessionFactStore(),
			tracker,
		});

		await agentTool.execute("call-1", {});

		expect(tracker.list()).toHaveLength(1);
		expect(tracker.list()[0]).toMatchObject({
			toolCallId: "call-1",
			toolName: "read",
			source: coreSource,
			status: "succeeded",
			metadata: undefined,
			updates: [],
			result: undefined,
		});
	});

	it("does not track tools with tracking disabled", async () => {
		const registry = new ToolRegistry();
		registry.addContribution({
			type: "define",
			source: coreSource,
			tool: {
				...createTool("quiet", "ok"),
				tracking: false,
			},
		});
		const tracker = new InMemoryToolTracker();
		const resolvedTool = registry.resolve().getTool("quiet");
		const agentTool = createAgentToolFromResolvedTool(resolvedTool!, {
			session: new MemorySessionFactStore(),
			tracker,
		});

		await agentTool.execute("call-1", {});

		expect(tracker.list()).toEqual([]);
	});

	it("stores tracking metadata extracted from params, updates, and results", async () => {
		const registry = new ToolRegistry();
		registry.addContribution({ type: "define", source: coreSource, tool: createUpdatingTool() });
		const tracker = new InMemoryToolTracker();
		const updates: Array<Parameters<AgentToolUpdateCallback<unknown>>[0]> = [];
		const resolvedTool = registry.resolve().getTool("update");
		const agentTool = createAgentToolFromResolvedTool(resolvedTool!, {
			session: new MemorySessionFactStore(),
			tracker,
		});

		await agentTool.execute("call-1", {}, undefined, (update) => updates.push(update));

		expect(updates).toEqual([
			{
				content: [{ type: "text", text: "partial" }],
				details: { count: 1 },
			},
		]);
		expect(tracker.list()[0]).toMatchObject({
			status: "succeeded",
			updates: [{ count: 1 }],
			result: { count: 2 },
		});
	});

	it("marks failed executions while preserving thrown errors", async () => {
		const registry = new ToolRegistry();
		const error = new Error("boom");
		registry.addContribution({
			type: "define",
			source: coreSource,
			tool: {
				...createTool("fail"),
				tracking: {
					mode: "metadata",
					describeError: (caught) => caught instanceof Error ? caught.message : String(caught),
				},
				execute: async () => {
					throw error;
				},
			},
		});
		const tracker = new InMemoryToolTracker();
		const resolvedTool = registry.resolve().getTool("fail");
		const agentTool = createAgentToolFromResolvedTool(resolvedTool!, {
			session: new MemorySessionFactStore(),
			tracker,
		});

		await expect(agentTool.execute("call-1", {})).rejects.toBe(error);
		expect(tracker.list()[0]).toMatchObject({
			status: "failed",
			error: "boom",
		});
	});

	it("lets patches override tracking policy", async () => {
		const registry = new ToolRegistry();
		registry.addContribution({
			type: "define",
			source: coreSource,
			tool: {
				...createTool("read"),
				tracking: false,
			},
		});
		registry.addContribution({
			type: "patch",
			source: extensionSource,
			targetToolName: "read",
			patch: {
				tracking: {
					mode: "metadata",
					describeParams: () => ({ enabledBy: "ext" }),
				},
			},
		});
		const tracker = new InMemoryToolTracker();
		const resolvedTool = registry.resolve().getTool("read");
		const agentTool = createAgentToolFromResolvedTool(resolvedTool!, {
			session: new MemorySessionFactStore(),
			tracker,
		});

		await agentTool.execute("call-1", {});

		expect(tracker.list()[0]).toMatchObject({
			status: "succeeded",
			metadata: { enabledBy: "ext" },
		});
	});
});
