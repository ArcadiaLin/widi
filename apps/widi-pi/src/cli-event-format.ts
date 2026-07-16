import type { OrchestratorEvent } from "./core/types.ts";

type ExtensionStatusChangedEvent = Extract<
	OrchestratorEvent,
	{ type: "extension_status_changed" }
>;

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
