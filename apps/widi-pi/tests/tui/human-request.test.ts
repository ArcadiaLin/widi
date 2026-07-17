import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { HumanRequestController } from "../../src/tui/human-request.ts";

describe("HumanRequestController", () => {
	it("presents argument completion candidates with a free-input fallback", async () => {
		const overlays: Component[] = [];
		const tui = {
			showOverlay(component: Component) {
				overlays.push(component);
				return { hide() {} };
			},
		} as unknown as TUI;
		const controller = new HumanRequestController({
			tui,
			resolveAgentLabel: () => "main",
		});
		const response = controller.request({
			id: "request-1",
			agentId: "main",
			source: { kind: "agent", agentId: "main" },
			kind: "argumentsCompletion",
			title: "Complete /model arguments",
			options: ["anthropic/claude"],
			allowFreeInput: true,
			createdAt: new Date(0).toISOString(),
		});

		expect(overlays).toHaveLength(1);
		const rendered = overlays[0]?.render(80).join("\n") ?? "";
		expect(rendered).toContain("anthropic/claude");
		expect(rendered).toContain("Type another answer");

		controller.close();
		await expect(response).rejects.toThrow("TUI is shutting down.");
	});
});
