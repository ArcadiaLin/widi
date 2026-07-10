import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { HarnessEventFacts } from "../../src/core/harness-event-facts.ts";

function createAssistantMessage(
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
			totalTokens: 0,
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function createAssistantPartial(
	toolCallId: string,
	toolName: string,
): AssistantMessage {
	return createAssistantMessage([
		{
			type: "toolCall",
			id: toolCallId,
			name: toolName,
			arguments: {},
		},
	]);
}

function toolCallStart(
	toolCallId: string,
	toolName: string,
): AgentHarnessEvent {
	const partial = createAssistantPartial(toolCallId, toolName);
	return {
		type: "message_update",
		message: partial,
		assistantMessageEvent: {
			type: "toolcall_start",
			contentIndex: 0,
			partial,
		},
	};
}

function toolCallDelta(delta: string): AgentHarnessEvent {
	const partial = createAssistantPartial("unused", "unused");
	return {
		type: "message_update",
		message: partial,
		assistantMessageEvent: {
			type: "toolcall_delta",
			contentIndex: 0,
			delta,
			partial,
		},
	};
}

describe("HarnessEventFacts", () => {
	it("keeps streaming tool-call refs isolated by agent and clears lifecycle boundaries", () => {
		const facts = new HarnessEventFacts();

		expect(
			facts.toToolLifecycleEvent("agent-a", toolCallStart("a", "alpha")),
		).toMatchObject({
			type: "tool_call_created",
			toolCallId: "a",
			toolName: "alpha",
		});
		expect(
			facts.toToolLifecycleEvent("agent-b", toolCallStart("b", "beta")),
		).toMatchObject({
			type: "tool_call_created",
			toolCallId: "b",
			toolName: "beta",
		});

		expect(
			facts.toToolLifecycleEvent("agent-a", toolCallDelta("1")),
		).toMatchObject({
			type: "arguments_delta",
			toolCallId: "a",
			toolName: "alpha",
		});
		expect(
			facts.toToolLifecycleEvent("agent-b", toolCallDelta("2")),
		).toMatchObject({
			type: "arguments_delta",
			toolCallId: "b",
			toolName: "beta",
		});

		expect(
			facts.toToolLifecycleEvent("agent-a", {
				type: "turn_end",
				message: createAssistantMessage([{ type: "text", text: "done" }]),
				toolResults: [],
			}),
		).toBeUndefined();
		expect(
			facts.toToolLifecycleEvent("agent-a", toolCallDelta("3")),
		).toMatchObject({
			type: "arguments_delta",
			toolCallId: undefined,
			toolName: undefined,
		});
		expect(
			facts.toToolLifecycleEvent("agent-b", toolCallDelta("4")),
		).toMatchObject({
			type: "arguments_delta",
			toolCallId: "b",
			toolName: "beta",
		});

		expect(
			facts.toToolLifecycleEvent("agent-b", {
				type: "agent_end",
				messages: [],
			}),
		).toBeUndefined();
		expect(
			facts.toToolLifecycleEvent("agent-b", toolCallDelta("5")),
		).toMatchObject({
			type: "arguments_delta",
			toolCallId: undefined,
			toolName: undefined,
		});
	});
});
