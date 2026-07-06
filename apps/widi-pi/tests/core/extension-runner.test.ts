import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	ExtensionLoader,
	ExtensionRunner,
} from "../../src/core/extension/index.ts";

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
