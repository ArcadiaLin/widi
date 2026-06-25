import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	createAgentToolFromResolvedTool,
	ToolRegistry,
} from "../../src/core/tools/tool-registry.ts";
import type {
	ToolContributionSource,
	ToolDefinition,
} from "../../src/core/tools/types.ts";

const emptyParams = Type.Object({});

const coreSource: ToolContributionSource = { kind: "core", id: "builtin" };
const extensionSource: ToolContributionSource = {
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
	it("resolves define and patch contributions with deterministic middleware order", async () => {
		const calls: string[] = [];
		const registry = new ToolRegistry();
		registry.addContribution({
			type: "define",
			source: coreSource,
			tool: createTool("write", "base"),
		});
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
		expect(resolvedTool).toBeDefined();
		if (!resolvedTool) throw new Error("Expected write tool to resolve.");
		expect(resolvedTool.definition.label).toBe("Write via sandbox");
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
		registry.addContribution({
			type: "define",
			source: coreSource,
			priority: 0,
			tool: createTool("read", "core"),
		});
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
				code: "tool.define_conflict",
				domain: "tool",
				toolName: "read",
				source: { kind: "registry", name: "tool:read", key: "core:builtin" },
				targetSource: { kind: "extension", id: "ext" },
				details: expect.objectContaining({
					contributionSource: coreSource,
					targetContributionSource: extensionSource,
				}),
			}),
		);
	});

	it("reports missing requested and active tools while keeping valid names", () => {
		const registry = new ToolRegistry();
		registry.addContribution({
			type: "define",
			source: coreSource,
			tool: createTool("read"),
		});
		registry.addContribution({
			type: "define",
			source: coreSource,
			tool: createTool("write"),
		});

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
				code: "tool.patch_target_missing",
				toolName: "write",
				source: { kind: "extension", id: "ext" },
				details: expect.objectContaining({
					contributionSource: extensionSource,
				}),
			}),
		);
	});

	it("passes human request capability into tool execution context", async () => {
		const registry = new ToolRegistry();
		registry.addContribution({
			type: "define",
			source: coreSource,
			tool: {
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
		});
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
