import type { OrchestratorEvent } from "./core/types.ts";

type ExtensionStatusChangedEvent = Extract<
	OrchestratorEvent,
	{ type: "extension_status_changed" }
>;

type ExtensionNotificationEvent = Extract<
	OrchestratorEvent,
	{ type: "extension_notification" }
>;

type ExtensionMessagePublishedEvent = Extract<
	OrchestratorEvent,
	{ type: "extension_message_published" }
>;

export const MAX_CLI_MESSAGE_LINES = 12;
export const MAX_CLI_MESSAGE_CHARS = 2_000;
export const MAX_CLI_NOTIFICATION_CHARS = 240;

export function formatExtensionNotificationEvent(
	event: ExtensionNotificationEvent,
): string {
	const folded = event.text.trim().replace(/\s+/g, " ");
	const characters = [...folded];
	const text =
		characters.length > MAX_CLI_NOTIFICATION_CHARS
			? `${characters.slice(0, MAX_CLI_NOTIFICATION_CHARS).join("")}…`
			: folded;
	return `[extension:${event.extensionId}] notice: ${text}`;
}

export function formatExtensionStatusEvent(
	event: ExtensionStatusChangedEvent,
): string | undefined {
	const status = event.status;
	if (!status) return undefined;
	const progress = status.progress;
	const progressText = progress
		? progress.total === undefined
			? ` (${progress.completed}/?)`
			: ` (${progress.completed}/${progress.total})`
		: "";
	return `[extension:${event.extensionId}] status ${event.key}: ${status.text}${progressText}`;
}

// Deterministic plain-text degradation: markdown/code content is printed
// as-is, bounded by MAX_CLI_MESSAGE_LINES and MAX_CLI_MESSAGE_CHARS.
export function formatExtensionMessageEvent(
	event: ExtensionMessagePublishedEvent,
): string {
	const prefix = `[extension:${event.extensionId}]`;
	const header = event.message.title
		? `${prefix} ${event.message.title}`
		: prefix;
	let content = event.message.content;
	let truncated = false;
	if (content.length > MAX_CLI_MESSAGE_CHARS) {
		content = content.slice(0, MAX_CLI_MESSAGE_CHARS);
		truncated = true;
	}
	const lines = content.split("\n");
	if (lines.length > MAX_CLI_MESSAGE_LINES) {
		lines.length = MAX_CLI_MESSAGE_LINES;
		truncated = true;
	}
	if (truncated) {
		lines.push("[truncated]");
	}
	return [header, ...lines].join("\n");
}
