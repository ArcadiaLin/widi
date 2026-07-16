import { describe, expect, it } from "vitest";
import { formatExtensionStatusEvent } from "../src/cli-event-format.ts";
import type { OrchestratorEvent } from "../src/core/types.ts";

type ExtensionStatusChangedEvent = Extract<
	OrchestratorEvent,
	{ type: "extension_status_changed" }
>;

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
