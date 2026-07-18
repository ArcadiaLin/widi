import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { HumanRequestMenu } from "../../src/tui/human-request.ts";
import {
	createTuiApplicationState,
	setActiveAgent,
} from "../../src/tui/state.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function createMenu() {
	const state = createTuiApplicationState();
	setActiveAgent(state, "main");
	const focusLog: Array<Component | null> = [];
	const menu = new HumanRequestMenu({
		host: {
			setFocus(component) {
				focusLog.push(component);
			},
			requestRender() {},
		},
		state,
		resolveAgentLabel: (agentId) => agentId ?? "unknown",
		restoreFocus: () => focusLog.push(null),
	});
	return { state, menu, focusLog };
}

function plain(menu: HumanRequestMenu, width = 80): string {
	return menu.render(width).join("\n").replace(ANSI_SEQUENCE, "");
}

describe("HumanRequestMenu", () => {
	it("docks an active-agent select request with its options", async () => {
		const { menu, focusLog } = createMenu();
		const response = menu.request({
			id: "request-1",
			agentId: "main",
			source: { kind: "agent", agentId: "main" },
			kind: "select",
			title: "Select a model",
			options: ["anthropic/claude"],
			allowFreeInput: true,
			createdAt: new Date(0).toISOString(),
		});

		expect(menu.isOpen).toBe(true);
		expect(focusLog.at(-1)).toBe(menu);
		const rendered = plain(menu);
		expect(rendered).toContain("Select a model");
		expect(rendered).toContain("agent: main");
		expect(rendered).toContain("anthropic/claude");
		expect(rendered).toContain("Type another answer");

		menu.close();
		await expect(response).rejects.toThrow("TUI is shutting down.");
	});

	it("keeps background requests out of focus and shows a pending hint", async () => {
		const { menu, focusLog } = createMenu();
		const response = menu.request({
			id: "request-1",
			agentId: "reviewer",
			source: { kind: "agent", agentId: "reviewer" },
			kind: "confirm",
			title: "Deploy?",
			createdAt: new Date(0).toISOString(),
		});

		expect(menu.isOpen).toBe(false);
		expect(focusLog).toHaveLength(0);
		expect(plain(menu)).toContain("1 pending request");

		menu.openLatest();
		expect(menu.isOpen).toBe(true);
		expect(plain(menu)).toContain("Deploy?");

		menu.close();
		await expect(response).rejects.toThrow("TUI is shutting down.");
	});

	it("shows a tab row while multiple requests wait", async () => {
		const { menu } = createMenu();
		const first = menu.request({
			id: "request-1",
			agentId: "main",
			source: { kind: "agent", agentId: "main" },
			kind: "select",
			title: "Select login method",
			options: ["Browser (OAuth)", "Device code"],
			createdAt: new Date(0).toISOString(),
		});
		const second = menu.request({
			id: "request-2",
			agentId: "reviewer",
			source: { kind: "agent", agentId: "reviewer" },
			kind: "confirm",
			title: "Deploy?",
			createdAt: new Date(0).toISOString(),
		});

		expect(menu.pendingCount).toBe(2);
		const rendered = plain(menu);
		expect(rendered).toContain("● main · select");
		expect(rendered).toContain("○ reviewer · confirm");
		expect(rendered).toContain("←→ switch request");

		menu.close();
		await expect(first).rejects.toThrow();
		await expect(second).rejects.toThrow();
	});

	it("silently withdraws a cancelled provisional request", async () => {
		const { menu, focusLog } = createMenu();
		const response = menu.request({
			id: "request-1",
			agentId: "main",
			source: { kind: "agent", agentId: "main" },
			kind: "input",
			title: "Paste the authorization code",
			provisional: true,
			createdAt: new Date(0).toISOString(),
		});

		expect(menu.isOpen).toBe(true);
		menu.cancelRequest("request-1");
		expect(menu.isOpen).toBe(false);
		expect(menu.pendingCount).toBe(0);
		expect(focusLog.at(-1)).toBeNull();
		await expect(response).rejects.toThrow("Human request was aborted.");
	});
});
