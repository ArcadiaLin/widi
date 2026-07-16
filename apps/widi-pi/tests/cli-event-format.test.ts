import { describe, expect, it } from "vitest";
import {
	formatExtensionMessageEvent,
	formatExtensionNotificationEvent,
	formatExtensionStatusEvent,
	MAX_CLI_MESSAGE_CHARS,
	MAX_CLI_MESSAGE_LINES,
	MAX_CLI_NOTIFICATION_CHARS,
} from "../src/cli-event-format.ts";
import type { OrchestratorEvent } from "../src/core/types.ts";

type ExtensionNotificationEvent = Extract<
	OrchestratorEvent,
	{ type: "extension_notification" }
>;

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

function notificationEvent(text: string): ExtensionNotificationEvent {
	return {
		type: "extension_notification",
		presentationId: "presentation-1",
		agentId: "agent-1",
		extensionId: "audit",
		text,
		createdAt: "2026-07-16T00:00:00.000Z",
	};
}

describe("formatExtensionNotificationEvent", () => {
	it("formats an attributed info-only notice", () => {
		expect(
			formatExtensionNotificationEvent(
				notificationEvent("Report generated in 2.1s"),
			),
		).toBe("[extension:audit] notice: Report generated in 2.1s");
	});

	it("folds whitespace into one line", () => {
		expect(
			formatExtensionNotificationEvent(
				notificationEvent("Report\n generated\t in  2.1s"),
			),
		).toBe("[extension:audit] notice: Report generated in 2.1s");
	});

	it("truncates long notices to a bounded single line", () => {
		expect(
			formatExtensionNotificationEvent(
				notificationEvent("x".repeat(MAX_CLI_NOTIFICATION_CHARS + 10)),
			),
		).toBe(
			`[extension:audit] notice: ${"x".repeat(MAX_CLI_NOTIFICATION_CHARS)}…`,
		);
	});

	it("counts Unicode code points without splitting surrogate pairs", () => {
		const text = `${"x".repeat(MAX_CLI_NOTIFICATION_CHARS - 1)}🙂`;
		expect(formatExtensionNotificationEvent(notificationEvent(text))).toBe(
			`[extension:audit] notice: ${text}`,
		);
	});
});

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
