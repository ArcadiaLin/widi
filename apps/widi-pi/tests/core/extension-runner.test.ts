import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	type ExtensionFactory,
	ExtensionLoader,
	ExtensionRunner,
} from "../../src/core/extension/index.ts";

async function createRunner(
	factories: readonly (readonly [string, ExtensionFactory])[],
): Promise<ExtensionRunner> {
	const loader = new ExtensionLoader();
	for (const [extensionId, factory] of factories) {
		loader.registerExtensionFactory(extensionId, factory);
	}
	const scope = await loader.loadForAgent({
		agentId: "agent",
		profileId: "profile",
		extensionIds: factories.map(([extensionId]) => extensionId),
	});
	return new ExtensionRunner({ loadedScope: scope });
}

describe("ExtensionRunner inspect", () => {
	it("exposes serializable facts without handler or tool implementation closures", async () => {
		const loader = new ExtensionLoader();
		loader.registerExtensionFactory("sample", (api) => {
			api.observe("agent_harness_event", () => {});
			api.intercept("tool_call", () => undefined);
			api.registerCommand({
				name: "sample",
				description: "Sample command",
				handler: () => {},
			});
			api.registerTool({
				name: "sampleTool",
				label: "Sample Tool",
				description: "sample tool",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text", text: "sample" }],
					details: undefined,
				}),
			});
			api.patchTool("base", {
				strict: true,
				execute: async () => ({
					content: [{ type: "text", text: "patched" }],
					details: undefined,
				}),
			});
		});
		const scope = await loader.loadForAgent({
			agentId: "agent",
			profileId: "profile",
			extensionIds: ["sample"],
		});
		const runner = new ExtensionRunner({ loadedScope: scope });

		const snapshot = runner.inspect();

		expect(snapshot.hooks).toEqual([
			{
				kind: "observe",
				extensionId: "sample",
				eventName: "agent_harness_event",
			},
			{
				kind: "intercept",
				extensionId: "sample",
				eventName: "tool_call",
			},
		]);
		expect(snapshot.commands).toEqual([
			{
				extensionId: "sample",
				command: {
					name: "sample",
					description: "Sample command",
					source: { kind: "extension", extensionId: "sample" },
					placement: "line",
					trigger: "/",
				},
			},
		]);
		expect(snapshot.toolContributions).toEqual([
			{
				kind: "define",
				extensionId: "sample",
				toolName: "sampleTool",
				source: { kind: "extension", id: "sample" },
			},
			{
				kind: "patch",
				extensionId: "sample",
				targetToolName: "base",
				patchedFields: ["strict", "execute"],
				source: { kind: "extension", id: "sample" },
			},
		]);
		expect(snapshot.hooks[0]).not.toHaveProperty("handler");
		expect(snapshot.commands[0]).not.toHaveProperty("handler");
		expect(snapshot.toolContributions[0]).not.toHaveProperty("definition");
		expect(snapshot.toolContributions[1]).not.toHaveProperty("patch");
	});

	it("reports stale state after invalidation", async () => {
		const loader = new ExtensionLoader();
		loader.registerExtensionFactory("sample", () => {});
		const scope = await loader.loadForAgent({
			agentId: "agent",
			profileId: "profile",
			extensionIds: ["sample"],
		});
		const runner = new ExtensionRunner({ loadedScope: scope });

		runner.invalidate("stale for test");

		expect(runner.inspect().stale).toEqual({
			stale: true,
			message: "stale for test",
		});
	});
});

describe("ExtensionRunner interceptors", () => {
	it("keeps successful before_agent_start contributions around a failed handler", async () => {
		const runner = await createRunner([
			[
				"first",
				(api) => {
					api.intercept("before_agent_start", () => ({
						messages: [{ role: "user", content: "first", timestamp: 1 }],
						systemPrompt: "first prompt",
					}));
				},
			],
			[
				"broken",
				(api) => {
					api.intercept("before_agent_start", () => {
						throw new Error("before start failed");
					});
				},
			],
			[
				"last",
				(api) => {
					api.intercept("before_agent_start", () => ({
						messages: [{ role: "user", content: "last", timestamp: 2 }],
						systemPrompt: "last prompt",
					}));
				},
			],
		]);

		const run = await runner.interceptWithDiagnostics({
			type: "before_agent_start",
			prompt: "go",
			systemPrompt: "base prompt",
			resources: {},
		});

		expect(run.result).toEqual({
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "user", content: "last", timestamp: 2 },
			],
			systemPrompt: "last prompt",
		});
		expect(run.diagnostics).toEqual([
			expect.objectContaining({
				code: "extension.handler_failed",
				extensionId: "broken",
				details: { eventName: "before_agent_start" },
			}),
		]);
	});

	it("continues the context pipeline from the last successful result", async () => {
		let lastMessages: readonly unknown[] = [];
		const runner = await createRunner([
			[
				"first",
				(api) => {
					api.intercept("context", (event) => ({
						messages: [
							...event.messages,
							{ role: "user", content: "first", timestamp: 1 },
						],
					}));
				},
			],
			[
				"broken-a",
				(api) => {
					api.intercept("context", () => {
						throw new Error("context failed a");
					});
				},
			],
			[
				"broken-b",
				(api) => {
					api.intercept("context", () => {
						throw new Error("context failed b");
					});
				},
			],
			[
				"last",
				(api) => {
					api.intercept("context", (event) => {
						lastMessages = event.messages;
						return {
							messages: [
								...event.messages,
								{ role: "user", content: "last", timestamp: 2 },
							],
						};
					});
				},
			],
		]);
		const base = { role: "user" as const, content: "base", timestamp: 0 };

		const run = await runner.interceptWithDiagnostics({
			type: "context",
			messages: [base],
		});

		expect(lastMessages).toEqual([
			base,
			{ role: "user", content: "first", timestamp: 1 },
		]);
		expect(run.result).toEqual({
			messages: [
				base,
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "user", content: "last", timestamp: 2 },
			],
		});
		expect(run.diagnostics.map((diagnostic) => diagnostic.extensionId)).toEqual(
			["broken-a", "broken-b"],
		);
	});

	it("keeps tool_result patches around a failed handler", async () => {
		let lastContent: unknown;
		const runner = await createRunner([
			[
				"first",
				(api) => {
					api.intercept("tool_result", () => ({
						content: [{ type: "text", text: "first result" }],
						details: { first: true },
						terminate: true,
					}));
				},
			],
			[
				"broken",
				(api) => {
					api.intercept("tool_result", () => {
						throw new Error("tool result failed");
					});
				},
			],
			[
				"last",
				(api) => {
					api.intercept("tool_result", (event) => {
						lastContent = event.content;
						return { isError: true };
					});
				},
			],
		]);

		const run = await runner.interceptWithDiagnostics({
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "write",
			input: {},
			content: [{ type: "text", text: "base result" }],
			details: undefined,
			isError: false,
		});

		expect(lastContent).toEqual([{ type: "text", text: "first result" }]);
		expect(run.result).toEqual({
			content: [{ type: "text", text: "first result" }],
			details: { first: true },
			isError: true,
			terminate: true,
		});
		expect(run.diagnostics).toEqual([
			expect.objectContaining({
				extensionId: "broken",
				details: { eventName: "tool_result" },
			}),
		]);
	});

	it("blocks tool_call when an interceptor fails", async () => {
		let lastCalled = false;
		const runner = await createRunner([
			[
				"pass",
				(api) => {
					api.intercept("tool_call", () => undefined);
				},
			],
			[
				"broken",
				(api) => {
					api.intercept("tool_call", () => {
						throw new Error("tool call failed");
					});
				},
			],
			[
				"last",
				(api) => {
					api.intercept("tool_call", () => {
						lastCalled = true;
						return undefined;
					});
				},
			],
		]);

		const run = await runner.interceptWithDiagnostics({
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "write",
			input: {},
		});

		expect(run.result).toEqual({ block: true });
		expect(lastCalled).toBe(false);
		expect(run.diagnostics).toEqual([
			expect.objectContaining({
				code: "extension.handler_failed",
				extensionId: "broken",
				details: { eventName: "tool_call" },
			}),
		]);
	});
});
