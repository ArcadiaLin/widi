import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	type ExtensionActionFailure,
	type ExtensionCoreActions,
	type ExtensionFactory,
	ExtensionLoader,
	ExtensionRunner,
} from "../../src/core/extension/index.ts";

async function createRunner(
	factories: readonly (readonly [string, ExtensionFactory])[],
): Promise<ExtensionRunner> {
	const loader = new ExtensionLoader();
	for (const [extensionId, factory] of factories) {
		loader.registerExtension(extensionId, factory);
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
		loader.registerExtension("sample", (api) => {
			api.observe("agent_harness_event", () => {});
			api.observe("agent_session_info_changed", () => {});
			api.intercept("tool_call", () => undefined);
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
				kind: "observe",
				extensionId: "sample",
				eventName: "agent_session_info_changed",
			},
			{
				kind: "intercept",
				extensionId: "sample",
				eventName: "tool_call",
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
		expect(snapshot.toolContributions[0]).not.toHaveProperty("definition");
		expect(snapshot.toolContributions[1]).not.toHaveProperty("patch");
	});

	it("reports stale state after invalidation", async () => {
		const loader = new ExtensionLoader();
		loader.registerExtension("sample", () => {});
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

describe("ExtensionRunner scoped output action", () => {
	it("injects the runner agent and calling extension ids", async () => {
		const runner = await createRunner([["sample", () => {}]]);
		const calls: Array<[string, string, string]> = [];
		const unboundActions = (
			runner as unknown as { _actions: ExtensionCoreActions }
		)._actions;
		runner.bindCore(
			{
				...unboundActions,
				emitOutput: async (agentId, extensionId, text) => {
					calls.push([agentId, extensionId, text]);
				},
			},
			{},
		);

		await runner.createContext("sample").actions.emitOutput("working");

		expect(calls).toEqual([["agent", "sample", "working"]]);
	});

	it("reports output delivery failures before rethrowing", async () => {
		const runner = await createRunner([["sample", () => {}]]);
		const failure = new Error("output delivery failed");
		const reported: ExtensionActionFailure[] = [];
		const unboundActions = (
			runner as unknown as { _actions: ExtensionCoreActions }
		)._actions;
		runner.bindCore(
			{
				...unboundActions,
				emitOutput: async () => {
					throw failure;
				},
			},
			{
				reportActionFailure: async (actionFailure) => {
					reported.push(actionFailure);
				},
			},
		);

		await expect(
			runner.createContext("sample").actions.emitOutput("working"),
		).rejects.toBe(failure);
		expect(reported).toEqual([
			{
				extensionId: "sample",
				action: "emitOutput",
				code: "extension.action_failed",
				error: failure,
			},
		]);
	});
});

describe("ExtensionRunner scoped notification action", () => {
	it("injects attribution into notifications", async () => {
		const runner = await createRunner([["sample", () => {}]]);
		const calls: Array<[string, string, string]> = [];
		const unboundActions = (
			runner as unknown as { _actions: ExtensionCoreActions }
		)._actions;
		runner.bindCore(
			{
				...unboundActions,
				notify: async (agentId, extensionId, text) => {
					calls.push([agentId, extensionId, text]);
				},
			},
			{},
		);

		await runner.createContext("sample").actions.notify("plain");

		expect(calls).toEqual([["agent", "sample", "plain"]]);
	});

	it("reports notification delivery failures before rethrowing", async () => {
		const runner = await createRunner([["sample", () => {}]]);
		const failure = new Error("notification delivery failed");
		const reported: ExtensionActionFailure[] = [];
		const unboundActions = (
			runner as unknown as { _actions: ExtensionCoreActions }
		)._actions;
		runner.bindCore(
			{
				...unboundActions,
				notify: async () => {
					throw failure;
				},
			},
			{
				reportActionFailure: async (actionFailure) => {
					reported.push(actionFailure);
				},
			},
		);

		await expect(
			runner.createContext("sample").actions.notify("ready"),
		).rejects.toBe(failure);
		expect(reported).toEqual([
			{
				extensionId: "sample",
				action: "notify",
				code: "extension.action_failed",
				error: failure,
			},
		]);
	});
});

describe("ExtensionRunner scoped status actions", () => {
	it("injects attribution into status mutations", async () => {
		const runner = await createRunner([["sample", () => {}]]);
		const calls: Array<
			| [
					"set",
					string,
					string,
					string,
					{ text: string; progress?: { completed: number; total?: number } },
			  ]
			| ["clear", string, string, string]
		> = [];
		const unboundActions = (
			runner as unknown as { _actions: ExtensionCoreActions }
		)._actions;
		runner.bindCore(
			{
				...unboundActions,
				setStatus: async (
					agentId: string,
					extensionId: string,
					key: string,
					status: {
						text: string;
						progress?: { completed: number; total?: number };
					},
				) => {
					calls.push(["set", agentId, extensionId, key, status]);
				},
				clearStatus: async (
					agentId: string,
					extensionId: string,
					key: string,
				) => {
					calls.push(["clear", agentId, extensionId, key]);
				},
			},
			{},
		);

		await runner
			.createContext("sample")
			.actions.setStatus("index", { text: "Scanning" });
		const actions = runner.createContext("sample").actions;
		await actions.setStatus("index", {
			text: "Building",
			progress: { completed: 2, total: 5 },
		});
		await actions.clearStatus("index");

		expect(calls).toEqual([
			["set", "agent", "sample", "index", { text: "Scanning" }],
			[
				"set",
				"agent",
				"sample",
				"index",
				{ text: "Building", progress: { completed: 2, total: 5 } },
			],
			["clear", "agent", "sample", "index"],
		]);
	});

	it("reports status action failures before rethrowing", async () => {
		const runner = await createRunner([["sample", () => {}]]);
		const failure = new Error("status delivery failed");
		const reported: ExtensionActionFailure[] = [];
		const unboundActions = (
			runner as unknown as { _actions: ExtensionCoreActions }
		)._actions;
		runner.bindCore(
			{
				...unboundActions,
				setStatus: async () => {
					throw failure;
				},
				clearStatus: async () => {
					throw failure;
				},
			},
			{
				reportActionFailure: async (actionFailure) => {
					reported.push(actionFailure);
				},
			},
		);
		const actions = runner.createContext("sample").actions;

		await expect(actions.setStatus("index", { text: "Scanning" })).rejects.toBe(
			failure,
		);
		await expect(actions.clearStatus("index")).rejects.toBe(failure);
		expect(reported.map(({ action }) => action)).toEqual([
			"setStatus",
			"clearStatus",
		]);
	});
});

describe("ExtensionRunner scoped message actions", () => {
	it("injects attribution and returns the entry id", async () => {
		const runner = await createRunner([["sample", () => {}]]);
		const calls: Array<
			[string, string, { kind: string; title?: string; content: string }]
		> = [];
		const unboundActions = (
			runner as unknown as { _actions: ExtensionCoreActions }
		)._actions;
		runner.bindCore(
			{
				...unboundActions,
				publishMessage: async (
					agentId: string,
					extensionId: string,
					message: {
						kind: "text" | "markdown" | "code";
						title?: string;
						content: string;
					},
				) => {
					calls.push([agentId, extensionId, message]);
					return { entryId: `entry-${calls.length}` };
				},
			},
			{},
		);

		await expect(
			runner
				.createContext("sample")
				.actions.publishMessage({ kind: "text", content: "plain" }),
		).resolves.toEqual({ entryId: "entry-1" });
		await expect(
			runner.createContext("sample").actions.publishMessage({
				kind: "markdown",
				title: "Summary",
				content: "Done.",
			}),
		).resolves.toEqual({ entryId: "entry-2" });

		expect(calls).toEqual([
			["agent", "sample", { kind: "text", content: "plain" }],
			[
				"agent",
				"sample",
				{ kind: "markdown", title: "Summary", content: "Done." },
			],
		]);
	});

	it("reports publish message failures before rethrowing", async () => {
		const runner = await createRunner([["sample", () => {}]]);
		const failure = new Error("message persistence failed");
		const reported: ExtensionActionFailure[] = [];
		const unboundActions = (
			runner as unknown as { _actions: ExtensionCoreActions }
		)._actions;
		runner.bindCore(
			{
				...unboundActions,
				publishMessage: async () => {
					throw failure;
				},
			},
			{
				reportActionFailure: async (actionFailure) => {
					reported.push(actionFailure);
				},
			},
		);

		await expect(
			runner
				.createContext("sample")
				.actions.publishMessage({ kind: "text", content: "plain" }),
		).rejects.toBe(failure);
		expect(reported.map(({ action }) => action)).toEqual(["publishMessage"]);
	});
});

describe("ExtensionRunner scoped diagnostic actions", () => {
	it("injects attribution into reports", async () => {
		const runner = await createRunner([["sample", () => {}]]);
		const calls: Array<
			[string, string, { severity: string; code: string; message: string }]
		> = [];
		const unboundActions = (
			runner as unknown as { _actions: ExtensionCoreActions }
		)._actions;
		runner.bindCore(
			{
				...unboundActions,
				reportDiagnostic: async (
					agentId: string,
					extensionId: string,
					draft: {
						severity: "info" | "warning" | "error";
						code: string;
						message: string;
					},
				) => {
					calls.push([agentId, extensionId, draft]);
				},
			},
			{},
		);

		await runner.createContext("sample").actions.reportDiagnostic({
			severity: "info",
			code: "scan.finished",
			message: "Scan finished",
		});
		await runner.createContext("sample").actions.reportDiagnostic({
			severity: "warning",
			code: "cache.stale",
			message: "Cache is stale",
		});

		expect(calls).toEqual([
			[
				"agent",
				"sample",
				{ severity: "info", code: "scan.finished", message: "Scan finished" },
			],
			[
				"agent",
				"sample",
				{ severity: "warning", code: "cache.stale", message: "Cache is stale" },
			],
		]);
	});

	it("reports diagnostic action failures before rethrowing", async () => {
		const runner = await createRunner([["sample", () => {}]]);
		const failure = new Error("diagnostic pipeline failed");
		const reported: ExtensionActionFailure[] = [];
		const unboundActions = (
			runner as unknown as { _actions: ExtensionCoreActions }
		)._actions;
		runner.bindCore(
			{
				...unboundActions,
				reportDiagnostic: async () => {
					throw failure;
				},
			},
			{
				reportActionFailure: async (actionFailure) => {
					reported.push(actionFailure);
				},
			},
		);

		await expect(
			runner.createContext("sample").actions.reportDiagnostic({
				severity: "warning",
				code: "cache.stale",
				message: "Cache is stale",
			}),
		).rejects.toBe(failure);
		expect(reported.map(({ action }) => action)).toEqual(["reportDiagnostic"]);
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

	it("chains input transforms and keeps untouched images by reference", async () => {
		const seenTexts: string[] = [];
		const runner = await createRunner([
			[
				"first",
				(api) => {
					api.intercept("input", (event) => {
						seenTexts.push(event.text);
						return { text: `${event.text} first` };
					});
				},
			],
			[
				"pass",
				(api) => {
					api.intercept("input", (event) => {
						seenTexts.push(event.text);
						return undefined;
					});
				},
			],
			[
				"last",
				(api) => {
					api.intercept("input", (event) => {
						seenTexts.push(event.text);
						return { text: `${event.text} last` };
					});
				},
			],
		]);
		const images = [
			{ type: "image" as const, data: "aGk=", mimeType: "image/png" },
		];

		const run = await runner.interceptInput({
			type: "input",
			text: "base",
			images,
		});

		expect(seenTexts).toEqual(["base", "base first", "base first"]);
		expect(run).toMatchObject({
			kind: "transform",
			text: "base first last",
			transformedBy: ["first", "last"],
			diagnostics: [],
		});
		if (run.kind !== "transform") throw new Error("expected transform");
		expect(run.images).toBe(images);
	});

	it("short-circuits input on the first block with attribution", async () => {
		let lastCalled = false;
		const runner = await createRunner([
			[
				"first",
				(api) => {
					api.intercept("input", (event) => ({ text: `${event.text}!` }));
				},
			],
			[
				"policy",
				(api) => {
					api.intercept("input", () => ({
						block: true,
						reason: "Input is denied.",
					}));
				},
			],
			[
				"last",
				(api) => {
					api.intercept("input", () => {
						lastCalled = true;
						return undefined;
					});
				},
			],
		]);

		const run = await runner.interceptInput({ type: "input", text: "base" });

		expect(run).toEqual({
			kind: "block",
			reason: "Input is denied.",
			blockedBy: "policy",
			diagnostics: [],
		});
		expect(lastCalled).toBe(false);
	});

	it("blocks input fail-closed when a handler throws", async () => {
		let lastCalled = false;
		const runner = await createRunner([
			[
				"broken",
				(api) => {
					api.intercept("input", () => {
						throw new Error("input policy exploded");
					});
				},
			],
			[
				"last",
				(api) => {
					api.intercept("input", () => {
						lastCalled = true;
						return undefined;
					});
				},
			],
		]);

		const run = await runner.interceptInput({ type: "input", text: "base" });

		expect(run).toMatchObject({
			kind: "block",
			blockedBy: "broken",
			diagnostics: [
				expect.objectContaining({
					code: "extension.handler_failed",
					extensionId: "broken",
					details: { eventName: "input" },
				}),
			],
		});
		expect(lastCalled).toBe(false);
	});

	it("passes input through when no handler rewrites it", async () => {
		const runner = await createRunner([
			[
				"pass",
				(api) => {
					api.intercept("input", () => undefined);
				},
			],
		]);

		await expect(
			runner.interceptInput({ type: "input", text: "base" }),
		).resolves.toEqual({ kind: "pass", diagnostics: [] });
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

describe("ExtensionRunner before_provider_request pipeline", () => {
	const baseEvent = {
		type: "before_provider_request" as const,
		model: { provider: "gateway", id: "gateway-model" } as never,
		sessionId: "session-1",
	};

	it("composes sequential patches, shows each handler the patched options, and encodes deletes", async () => {
		const seenByLast: Array<Record<string, string> | undefined> = [];
		const runner = await createRunner([
			[
				"first",
				(api) => {
					api.intercept("before_provider_request", () => ({
						streamOptions: {
							timeoutMs: 5000,
							headers: { legacy: undefined, "X-A": "1" },
						},
					}));
				},
			],
			[
				"last",
				(api) => {
					api.intercept("before_provider_request", (event) => {
						seenByLast.push(event.streamOptions.headers);
						return { streamOptions: { headers: { "X-A": "2" } } };
					});
				},
			],
		]);

		const run = await runner.interceptWithDiagnostics({
			...baseEvent,
			streamOptions: { timeoutMs: 1000, headers: { legacy: "x" } },
		});

		expect(seenByLast).toEqual([{ "X-A": "1" }]);
		expect(run.result).toEqual({
			streamOptions: {
				timeoutMs: 5000,
				headers: { legacy: undefined, "X-A": "2" },
			},
		});
		expect(run.diagnostics).toEqual([]);
	});

	it("skips a failing handler and keeps the remaining patches", async () => {
		const runner = await createRunner([
			[
				"broken",
				(api) => {
					api.intercept("before_provider_request", () => {
						throw new Error("boom");
					});
				},
			],
			[
				"stamp",
				(api) => {
					api.intercept("before_provider_request", () => ({
						streamOptions: { metadata: { audited: true } },
					}));
				},
			],
		]);

		const run = await runner.interceptWithDiagnostics({
			...baseEvent,
			streamOptions: {},
		});

		expect(run.result).toEqual({
			streamOptions: { metadata: { audited: true } },
		});
		expect(run.diagnostics).toEqual([
			expect.objectContaining({
				code: "extension.handler_failed",
				extensionId: "broken",
				details: { eventName: "before_provider_request" },
			}),
		]);
	});

	it("returns undefined when no handler patches the request", async () => {
		const runner = await createRunner([
			[
				"observer",
				(api) => {
					api.intercept("before_provider_request", () => undefined);
				},
			],
		]);

		const run = await runner.interceptWithDiagnostics({
			...baseEvent,
			streamOptions: { timeoutMs: 1000 },
		});

		expect(run.result).toBe(undefined);
	});
});
