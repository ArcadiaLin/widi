import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import {
	BUILT_IN_COMMANDS,
	type Command,
	isCommandName,
	parseLineCommand,
} from "../../src/core/command.ts";

describe("Command contract", () => {
	it("accepts stable command names without embedding the trigger", () => {
		expect(isCommandName("mark")).toBe(true);
		expect(isCommandName("follow-up")).toBe(true);
		expect(isCommandName("agent.status")).toBe(true);
		expect(isCommandName("agent_status")).toBe(true);
		expect(isCommandName("2nd")).toBe(true);
	});

	it("rejects names that would blur trigger, argument, or token boundaries", () => {
		expect(isCommandName("")).toBe(false);
		expect(isCommandName("/mark")).toBe(false);
		expect(isCommandName("<mark>")).toBe(false);
		expect(isCommandName("mark:")).toBe(false);
		expect(isCommandName("agent status")).toBe(false);
	});

	it("does not parse a trigger-prefixed name as a valid line command", () => {
		expect(parseLineCommand("//mark:value", ["/"])).toBeUndefined();
		expect(parseLineCommand("/mark:value", ["/"])).toEqual({
			trigger: "/",
			name: "mark",
			argument: "value",
		});
	});
});

describe("Built-in command argument completion", () => {
	const treeEntries = [
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-07-17T01:00:00.000Z",
			message: { role: "user", content: "请检查这个仓库\n第二行" },
		},
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: "2026-07-17T01:01:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "好的" }] },
		},
		{
			type: "message",
			id: "m3",
			parentId: "m2",
			timestamp: "2026-07-17T01:02:00.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "继续修改 footer" }],
			},
		},
		{
			type: "model_change",
			id: "m4",
			parentId: "m3",
			timestamp: "2026-07-17T01:03:00.000Z",
			provider: "vllm",
			modelId: "qwen",
		},
	];
	const orchestrator = {
		listAgentSessions: async () => ({
			sessions: [
				{
					id: "session-1",
					path: "/home/user/.widi/sessions/session-1.jsonl",
					createdAt: "2026-07-16T09:00:00.000Z",
					cwd: "/repo",
				},
			],
		}),
		getAgentSessionTree: async () => ({ entries: treeEntries }),
	} as unknown as AgentOrchestrator;

	async function completeFor(name: string) {
		const command = BUILT_IN_COMMANDS.find(
			(binding) => binding.command.name === name,
		)?.command as Command;
		const complete = command.arguments?.complete;
		if (!complete) throw new Error(`/${name} has no argument completion`);
		return await complete({
			agentId: "agent-1",
			command,
			argumentPrefix: "",
			orchestrator,
		});
	}

	it("completes /resume with persisted sessions", async () => {
		expect(await completeFor("resume")).toEqual([
			{
				value: "session-1",
				description: "/repo · 2026-07-16T09:00:00.000Z",
			},
		]);
	});

	it("completes /tree with user message entries only", async () => {
		expect(await completeFor("tree")).toEqual([
			{
				value: "m1",
				label: "请检查这个仓库",
				description: "2026-07-17T01:00:00.000Z",
			},
			{
				value: "m3",
				label: "继续修改 footer",
				description: "2026-07-17T01:02:00.000Z",
			},
		]);
	});

	it("completes /fork with the same fork points as /tree", async () => {
		expect(await completeFor("fork")).toEqual(await completeFor("tree"));
	});
});
