import { describe, expect, it } from "vitest";
import {
	formatExtensionMessageEvent,
	formatExtensionStatusEvent,
	MAX_CLI_MESSAGE_CHARS,
	MAX_CLI_MESSAGE_LINES,
} from "../src/cli-event-format.ts";
import type { OrchestratorEvent } from "../src/core/types.ts";

type ExtensionStatusChangedEvent = Extract<
	OrchestratorEvent,
	{ type: "extension_status_changed" }
>;

type ExtensionMessagePublishedEvent = Extract<
	OrchestratorEvent,
	{ type: "extension_message_published" }
>;

function messageEvent(
	message: ExtensionMessagePublishedEvent["message"],
): ExtensionMessagePublishedEvent {
	return {
		type: "extension_message_published",
		presentationId: "presentation-1",
		entryId: "entry-1",
		agentId: "agent-1",
		extensionId: "indexer",
		message,
		createdAt: "2026-07-16T00:00:00.000Z",
	};
}

function statusEvent(
	overrides: Partial<ExtensionStatusChangedEvent> = {},
): ExtensionStatusChangedEvent {
	return {
		type: "extension_status_changed",
		presentationId: "presentation-1",
		agentId: "agent-1",
		extensionId: "indexer",
		key: "build",
		status: {
			text: "Building symbol index",
			progress: { completed: 418, total: 672 },
		},
		changedAt: "2026-07-16T00:00:00.000Z",
		...overrides,
	};
}

describe("formatExtensionStatusEvent", () => {
	it("formats status with no, determinate, and indeterminate progress", () => {
		expect(
			formatExtensionStatusEvent(
				statusEvent({
					status: { text: "Ready" },
				}),
			),
		).toBe("[extension:indexer] status build: Ready");
		expect(formatExtensionStatusEvent(statusEvent())).toBe(
			"[extension:indexer] status build: Building symbol index (418/672)",
		);
		expect(
			formatExtensionStatusEvent(
				statusEvent({
					status: {
						text: "Scanning",
						progress: { completed: 418 },
					},
				}),
			),
		).toBe("[extension:indexer] status build: Scanning (418/?)");
	});

	it("does not print clear mutations", () => {
		expect(formatExtensionStatusEvent(statusEvent({ status: undefined }))).toBe(
			undefined,
		);
	});
});

describe("formatExtensionMessageEvent", () => {
	it("prints a titled message as plain text under an attribution header", () => {
		expect(
			formatExtensionMessageEvent(
				messageEvent({
					kind: "markdown",
					title: "Index Summary",
					content: "Indexed **672** files.\nSymbols: 14,208",
				}),
			),
		).toBe(
			"[extension:indexer] Index Summary\nIndexed **672** files.\nSymbols: 14,208",
		);
	});

	it("prints an untitled message with the bare attribution header", () => {
		expect(
			formatExtensionMessageEvent(
				messageEvent({ kind: "text", content: "Report generated." }),
			),
		).toBe("[extension:indexer]\nReport generated.");
	});

	it("truncates content beyond the line bound", () => {
		const content = Array.from(
			{ length: MAX_CLI_MESSAGE_LINES + 3 },
			(_, index) => `line ${index}`,
		).join("\n");
		const formatted = formatExtensionMessageEvent(
			messageEvent({ kind: "text", content }),
		);
		const lines = formatted.split("\n");
		expect(lines).toHaveLength(MAX_CLI_MESSAGE_LINES + 2);
		expect(lines[0]).toBe("[extension:indexer]");
		expect(lines.at(-1)).toBe("[truncated]");
		expect(lines.at(-2)).toBe(`line ${MAX_CLI_MESSAGE_LINES - 1}`);
	});

	it("truncates content beyond the character bound", () => {
		const content = "a".repeat(MAX_CLI_MESSAGE_CHARS + 10);
		const formatted = formatExtensionMessageEvent(
			messageEvent({ kind: "code", content }),
		);
		expect(formatted).toBe(
			`[extension:indexer]\n${"a".repeat(MAX_CLI_MESSAGE_CHARS)}\n[truncated]`,
		);
	});
});
