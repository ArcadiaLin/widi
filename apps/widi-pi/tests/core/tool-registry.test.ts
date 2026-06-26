import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	createAgentToolFromResolvedTool,
	ToolRegistry,
} from "../../src/core/tools/tool-registry.ts";
import type { ToolDefinition, ToolSource } from "../../src/core/tools/types.ts";

const emptyParams = Type.Object({});

const coreSource: ToolSource = { kind: "core", id: "builtin" };
const extensionSource: ToolSource = {
	kind: "extension",
	id: "ext",
};

function createTool(
	name: string,
	content: string = name,
): ToolDefinition<typeof emptyParams, undefined> {
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

describe("ToolRegistry", () => {
	it("resolves defined tools and patches with deterministic middleware order", async () => {
		const calls: string[] = [];
		const registry = new ToolRegistry();
		registry.defineTool(createTool("write", "base"), coreSource);
		registry.patchTool(
			"write",
			{
				aroundExecute: async (next, toolCallId, params, context) => {
					calls.push("audit:before");
					const result = await next(toolCallId, params, context);
					calls.push("audit:after");
					return result;
				},
			},
			{ kind: "extension", id: "audit" },
		);
		registry.patchTool(
			"write",
			{
				description: "Write via sandbox",
				aroundExecute: async (next, toolCallId, params, context) => {
					calls.push("sandbox:before");
					const result = await next(toolCallId, params, context);
					calls.push("sandbox:after");
					return result;
				},
			},
			{ kind: "extension", id: "sandbox" },
		);

		const result = registry.resolve();
		const resolvedTool = result.getTool("write");
		expect(resolvedTool).toBeDefined();
		if (!resolvedTool) throw new Error("Expected write tool to resolve.");
		expect(resolvedTool.definition.description).toBe("Write via sandbox");
		expect(resolvedTool.patches.map((patch) => patch.source.id)).toEqual([
			"audit",
			"sandbox",
		]);

		const agentTool = createAgentToolFromResolvedTool(resolvedTool, {});
		const toolResult = await agentTool.execute("call-1", {});

		expect(toolResult.content).toEqual([{ type: "text", text: "base" }]);
		expect(calls).toEqual([
			"sandbox:before",
			"audit:before",
			"audit:after",
			"sandbox:after",
		]);
	});

	it("keeps one definition for duplicate tool names and reports a conflict", () => {
		const registry = new ToolRegistry();
		registry.defineTool(createTool("read", "core"), coreSource);
		registry.defineTool(createTool("read", "extension"), extensionSource);

		const result = registry.resolve();

		expect(result.getToolDefinition("read")?.label).toBe("read");
		expect(result.getTool("read")?.source).toEqual(coreSource);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "tool.define_conflict",
				domain: "tool",
				toolName: "read",
				source: { kind: "extension", id: "ext" },
				targetSource: {
					kind: "registry",
					name: "tool:read",
					key: "core:builtin",
				},
				details: expect.objectContaining({
					toolSource: extensionSource,
					targetToolSource: coreSource,
				}),
			}),
		);
	});

	it("reports missing requested and active tools while keeping valid names", () => {
		const registry = new ToolRegistry();
		registry.defineTool(createTool("read"), coreSource);
		registry.defineTool(createTool("write"), coreSource);

		const result = registry.resolve({
			requestedToolNames: ["read", "missing", "read"],
			activeToolNames: ["read", "write", "ghost", "read"],
		});

		expect(result.toolNames).toEqual(["read"]);
		expect(result.activeToolNames).toEqual(["read"]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"tool.requested_duplicate",
			"tool.requested_missing",
			"tool.active_duplicate",
			"tool.active_missing",
			"tool.active_missing",
		]);
	});

	it("reports patches that target missing tools", () => {
		const registry = new ToolRegistry();
		registry.patchTool(
			"write",
			{ description: "Write elsewhere" },
			extensionSource,
		);

		const result = registry.resolve();

		expect(result.tools).toEqual([]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "tool.patch_target_missing",
				toolName: "write",
				source: { kind: "extension", id: "ext" },
				details: expect.objectContaining({
					toolSource: extensionSource,
				}),
			}),
		);
	});

	it("reports parameters patches that do not also patch execution", () => {
		const registry = new ToolRegistry();
		registry.defineTool(createTool("write"), coreSource);
		registry.patchTool(
			"write",
			{
				parameters: Type.Object({ path: Type.String() }),
			},
			extensionSource,
		);

		const result = registry.resolve();

		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "tool.patch_contract_risk",
				toolName: "write",
				source: { kind: "extension", id: "ext" },
				details: expect.objectContaining({
					field: "parameters",
				}),
			}),
		);
	});

	it("binds extension context to the patch currently executing", async () => {
		const events: string[] = [];
		const registry = new ToolRegistry();
		registry.defineTool(
			{
				...createTool("write"),
				execute: async (_toolCallId, _params, context) => {
					events.push(`execute:${context.extension?.extensionId}`);
					return {
						content: [{ type: "text", text: "base" }],
						details: undefined,
					};
				},
			},
			coreSource,
		);
		registry.patchTool(
			"write",
			{
				aroundExecute: async (next, toolCallId, params, context) => {
					events.push(`patch:${context.extension?.extensionId}`);
					return await next(toolCallId, params, context);
				},
			},
			{ kind: "extension", id: "audit" },
		);
		const resolvedTool = registry.resolve().getTool("write");
		expect(resolvedTool).toBeDefined();
		if (!resolvedTool) throw new Error("Expected write tool to resolve.");
		const agentTool = createAgentToolFromResolvedTool(resolvedTool, {
			createExtensionContext: (source) => ({ extensionId: source.id }),
		});

		await agentTool.execute("call-1", {});

		expect(events).toEqual(["patch:audit", "execute:builtin"]);
	});

	it("passes human request capability into tool execution context", async () => {
		const registry = new ToolRegistry();
		registry.defineTool(
			{
				name: "ask",
				label: "Ask",
				description: "Ask human",
				parameters: emptyParams,
				execute: async (_toolCallId, _params, context) => {
					const response = await context.human?.request({
						kind: "confirm",
						title: "Confirm",
						message: "Continue?",
					});
					return {
						content: [
							{
								type: "text",
								text:
									response?.kind === "confirm" && response.confirmed
										? "yes"
										: "no",
							},
						],
						details: response,
					};
				},
			},
			coreSource,
		);
		const resolvedTool = registry.resolve().getTool("ask");
		expect(resolvedTool).toBeDefined();
		if (!resolvedTool) throw new Error("Expected ask tool to resolve.");
		const agentTool = createAgentToolFromResolvedTool(resolvedTool, {
			human: {
				request: async () => ({ kind: "confirm", confirmed: true }),
			},
		});

		const result = await agentTool.execute("call-1", {});

		expect(result).toEqual({
			content: [{ type: "text", text: "yes" }],
			details: { kind: "confirm", confirmed: true },
		});
	});
});
