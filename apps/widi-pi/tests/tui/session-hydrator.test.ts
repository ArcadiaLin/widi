import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	COMMAND_EXPANSION_CUSTOM_TYPE,
	EXTENSION_MESSAGE_CUSTOM_TYPE,
	INPUT_TRANSFORM_CUSTOM_TYPE,
} from "../../src/core/session-manager.ts";
import { hydrateSessionEntries } from "../../src/tui/session-hydrator.ts";

describe("hydrateSessionEntries", () => {
	it("restores human-facing messages, tools, extension messages and display facts", () => {
		const entries: SessionTreeEntry[] = [
			custom("transform", INPUT_TRANSFORM_CUSTOM_TYPE, {
				inputId: "input-1",
				originalText: "human original",
				text: "extension rewritten",
				transformedBy: ["rewrite"],
			}),
			custom("expansion", COMMAND_EXPANSION_CUSTOM_TYPE, {
				inputId: "input-1",
				originalText: "extension rewritten",
				expansions: [],
			}),
			message("user", userMessage("model-facing expanded text")),
			message(
				"assistant",
				assistantMessage("I will inspect.", [
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: { path: "README.md" },
					},
				]),
			),
			message("tool-result", toolResult("call-1", "read", "file contents")),
			custom("extension-message", EXTENSION_MESSAGE_CUSTOM_TYPE, {
				extensionId: "reports",
				// Legacy entries may carry this removed field; structural
				// hydration ignores it without rewriting the stored entry.
				commandId: "legacy-command",
				message: {
					kind: "markdown",
					title: "Report",
					content: "durable result",
				},
			}),
			custom("private", "extension:reports:private", { secret: true }),
			{
				type: "model_change",
				id: "model",
				parentId: null,
				timestamp: timestamp(7),
				provider: "test",
				modelId: "model-2",
			},
			{
				type: "thinking_level_change",
				id: "thinking",
				parentId: null,
				timestamp: timestamp(8),
				thinkingLevel: "high",
			},
			{
				type: "active_tools_change",
				id: "tools",
				parentId: null,
				timestamp: timestamp(9),
				activeToolNames: ["read"],
			},
			{
				type: "session_info",
				id: "session-info",
				parentId: null,
				timestamp: timestamp(10),
				name: "research",
			},
			{
				type: "compaction",
				id: "compact",
				parentId: null,
				timestamp: timestamp(11),
				summary: "Earlier work was compacted.",
				firstKeptEntryId: "user",
				tokensBefore: 1000,
			},
		];

		const result = hydrateSessionEntries(entries);

		expect(result.display).toEqual({
			model: { provider: "test", modelId: "model-2" },
			thinkingLevel: "high",
			activeToolNames: ["read"],
			sessionName: "research",
		});
		expect(result.timeline.map((item) => item.type)).toEqual([
			"user-message",
			"assistant-message",
			"tool-execution",
			"extension-message",
			"session-marker",
		]);
		expect(result.timeline[0]).toMatchObject({
			type: "user-message",
			text: "human original",
			modelText: "model-facing expanded text",
		});
		expect(result.timeline[2]).toMatchObject({
			type: "tool-execution",
			toolCallId: "call-1",
			toolName: "read",
			status: "completed",
			isError: false,
		});
		expect(result.timeline[3]).toMatchObject({
			type: "extension-message",
			entryId: "extension-message",
			extensionId: "reports",
			message: { content: "durable result" },
		});
		expect(JSON.stringify(result.timeline)).not.toContain("secret");
	});

	it("creates a completed fallback tool item for orphan tool results", () => {
		const result = hydrateSessionEntries([
			message("orphan", toolResult("missing-call", "shell", "done", true)),
			{
				type: "branch_summary",
				id: "summary",
				parentId: null,
				timestamp: timestamp(2),
				fromId: "old-branch",
				summary: "Alternative branch summary.",
			},
		]);

		expect(result.timeline).toMatchObject([
			{
				type: "tool-execution",
				toolCallId: "missing-call",
				status: "completed",
				isError: true,
			},
			{
				type: "session-marker",
				marker: "branch-summary",
			},
		]);
	});
});

function message(
	id: string,
	value: UserMessage | AssistantMessage | ToolResultMessage,
): Extract<SessionTreeEntry, { type: "message" }> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: timestamp(1),
		message: value,
	};
}

function custom(
	id: string,
	customType: string,
	data: unknown,
): Extract<SessionTreeEntry, { type: "custom" }> {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: timestamp(1),
		customType,
		data,
	};
}

function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.parse(timestamp(1)) };
}

function assistantMessage(
	text: string,
	extra: AssistantMessage["content"] = [],
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }, ...extra],
		api: "anthropic-messages",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.parse(timestamp(2)),
	};
}

function toolResult(
	toolCallId: string,
	toolName: string,
	text: string,
	isError = false,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.parse(timestamp(3)),
	};
}

function timestamp(offset: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}
