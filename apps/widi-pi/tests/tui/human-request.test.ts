import { type Component, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { HumanRequestEnvelope } from "../../src/core/human-request.ts";
import { HumanRequestMenu } from "../../src/tui/human-request.ts";
import { createWidiKeybindings } from "../../src/tui/keybindings.ts";
import {
	createTuiApplicationState,
	setActiveAgent,
} from "../../src/tui/state.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const KEY = {
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	tab: "\t",
	enter: "\r",
	escape: "\x1b",
	space: " ",
} as const;

// The menu resolves navigation/number/space/enter shortcuts through the global
// keybinding manager, which must carry the widi-specific app.request.* bindings.
beforeAll(() => setKeybindings(createWidiKeybindings()));

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

function envelope(
	overrides: Partial<HumanRequestEnvelope> & Pick<HumanRequestEnvelope, "kind">,
): HumanRequestEnvelope {
	return {
		id: "request-1",
		agentId: "main",
		source: { kind: "agent", agentId: "main" },
		title: "Question",
		createdAt: new Date(0).toISOString(),
		...overrides,
	};
}

describe("HumanRequestMenu", () => {
	it("docks a select request with its options and a Submit tab", async () => {
		const { menu, focusLog } = createMenu();
		const response = menu.request(
			envelope({
				kind: "select",
				title: "Select a model",
				options: ["anthropic/claude"],
				allowFreeInput: true,
			}),
		);

		expect(menu.isOpen).toBe(true);
		expect(focusLog.at(-1)).toBe(menu);
		const rendered = plain(menu);
		expect(rendered).toContain("Select a model");
		expect(rendered).toContain("agent: main");
		expect(rendered).toContain("anthropic/claude");
		expect(rendered).toContain("Type another answer");
		expect(rendered).toContain("Submit");
		expect(rendered).toContain("─");

		menu.close();
		await expect(response).rejects.toThrow("TUI is shutting down.");
	});

	it("keeps a single select provisional until the Submit tab commits", async () => {
		const { menu } = createMenu();
		const response = menu.request(
			envelope({
				kind: "select",
				title: "Pick a color",
				options: ["red", "green", "blue"],
			}),
		);
		// Number key picks green but does not resolve; it advances to Submit.
		menu.handleInput("2");
		expect(menu.pendingCount).toBe(1);
		expect(plain(menu)).toContain("green");
		menu.handleInput(KEY.enter);
		await expect(response).resolves.toEqual({ kind: "select", value: "green" });
	});

	it("lets an earlier single-select answer be revised before submit", async () => {
		const { menu } = createMenu();
		const response = menu.request(
			envelope({
				kind: "select",
				title: "Pick a color",
				options: ["red", "green", "blue"],
			}),
		);
		menu.handleInput("2"); // green, now on Submit tab
		menu.handleInput(KEY.left); // back to the question
		menu.handleInput("1"); // revise to red, back on Submit tab
		menu.handleInput(KEY.enter);
		await expect(response).resolves.toEqual({ kind: "select", value: "red" });
	});

	it("toggles multi-select options and commits every choice on Submit", async () => {
		const { menu } = createMenu();
		const response = menu.request(
			envelope({
				kind: "multi-select",
				title: "Pick colors",
				options: [
					{ label: "Red", value: "red", description: "the warm one" },
					{ label: "Green", value: "green" },
					{ label: "Blue", value: "blue" },
				],
			}),
		);
		const rendered = plain(menu);
		expect(rendered).toContain("[ ] Red");
		expect(rendered).toContain("the warm one");
		menu.handleInput("1"); // toggle Red (stays on the question)
		expect(plain(menu)).toContain("[✓] Red");
		menu.handleInput("3"); // toggle Blue
		menu.handleInput(KEY.right); // to Submit tab
		menu.handleInput(KEY.enter);
		await expect(response).resolves.toEqual({
			kind: "multi-select",
			values: ["red", "blue"],
		});
	});

	it("toggles the multi-select cursor row with space", async () => {
		const { menu } = createMenu();
		const response = menu.request(
			envelope({
				kind: "multi-select",
				title: "Pick colors",
				options: ["red", "green", "blue"],
			}),
		);
		menu.handleInput(KEY.down); // cursor on green
		menu.handleInput(KEY.space); // toggle green
		menu.handleInput(KEY.right); // Submit tab
		menu.handleInput(KEY.enter);
		await expect(response).resolves.toEqual({
			kind: "multi-select",
			values: ["green"],
		});
	});

	it("resolves a confirm request through the Submit tab", async () => {
		const { menu } = createMenu();
		const response = menu.request(
			envelope({ kind: "confirm", title: "Deploy?" }),
		);
		menu.handleInput("1"); // Yes → advances to Submit
		menu.handleInput(KEY.enter);
		await expect(response).resolves.toEqual({
			kind: "confirm",
			confirmed: true,
		});
	});

	it("dismisses every deferred request when Cancel/esc is used", async () => {
		const { menu } = createMenu();
		const response = menu.request(
			envelope({
				kind: "select",
				title: "Pick a color",
				options: ["red", "green"],
			}),
		);
		menu.handleInput(KEY.escape);
		expect(menu.pendingCount).toBe(0);
		await expect(response).resolves.toEqual({
			kind: "select",
			value: undefined,
		});
	});

	it("answers a multi-question request as one ordered batch", async () => {
		const { menu } = createMenu();
		const response = menu.request(
			envelope({
				kind: "questions",
				title: "Set up the deploy",
				questions: [
					{ title: "Target", options: ["staging", "prod"] },
					{
						title: "Regions",
						multiSelect: true,
						options: ["us", "eu", "asia"],
					},
				],
			}),
		);
		expect(plain(menu)).toContain("Target");
		menu.handleInput("1"); // Target = staging, advances to Regions
		menu.handleInput("1"); // toggle us
		menu.handleInput("2"); // toggle eu
		menu.handleInput(KEY.right); // Submit tab
		menu.handleInput(KEY.enter);
		await expect(response).resolves.toEqual({
			kind: "questions",
			answers: [
				{ kind: "select", value: "staging" },
				{ kind: "multi-select", values: ["us", "eu"] },
			],
		});
	});

	it("leaves an unanswered batch question as no answer on submit", async () => {
		const { menu } = createMenu();
		const response = menu.request(
			envelope({
				kind: "questions",
				title: "Two questions",
				questions: [
					{ title: "First", options: ["a", "b"] },
					{ title: "Second", options: ["c", "d"] },
				],
			}),
		);
		menu.handleInput("2"); // First = b, advances to Second
		// Skip the second question straight to Submit.
		menu.handleInput(KEY.right);
		menu.handleInput(KEY.enter);
		await expect(response).resolves.toEqual({
			kind: "questions",
			answers: [
				{ kind: "select", value: "b" },
				{ kind: "select", value: undefined },
			],
		});
	});

	it("keeps background requests out of focus and shows a pending hint", async () => {
		const { menu, focusLog } = createMenu();
		const response = menu.request(
			envelope({
				id: "request-1",
				agentId: "reviewer",
				source: { kind: "agent", agentId: "reviewer" },
				kind: "confirm",
				title: "Deploy?",
			}),
		);

		expect(menu.isOpen).toBe(false);
		expect(focusLog).toHaveLength(0);
		expect(plain(menu)).toContain("1 pending request");

		menu.openLatest();
		expect(menu.isOpen).toBe(true);
		expect(plain(menu)).toContain("Deploy?");

		menu.close();
		await expect(response).rejects.toThrow("TUI is shutting down.");
	});

	it("shows a tab strip and Submit across several pending requests", async () => {
		const { menu } = createMenu();
		const first = menu.request(
			envelope({
				id: "request-1",
				kind: "select",
				title: "Select login method",
				options: ["Browser", "Device code"],
			}),
		);
		const second = menu.request(
			envelope({
				id: "request-2",
				agentId: "reviewer",
				source: { kind: "agent", agentId: "reviewer" },
				kind: "select",
				title: "Pick target",
				options: ["staging", "prod"],
			}),
		);

		expect(menu.pendingCount).toBe(2);
		const rendered = plain(menu);
		expect(rendered).toContain("Select login method");
		expect(rendered).toContain("Pick target");
		expect(rendered).toContain("Submit");

		menu.close();
		await expect(first).rejects.toThrow();
		await expect(second).rejects.toThrow();
	});

	it("silently withdraws a cancelled provisional input request", async () => {
		const { menu, focusLog } = createMenu();
		const response = menu.request(
			envelope({
				kind: "input",
				title: "Paste the authorization code",
				provisional: true,
			}),
		);

		expect(menu.isOpen).toBe(true);
		menu.cancelRequest("request-1");
		expect(menu.isOpen).toBe(false);
		expect(menu.pendingCount).toBe(0);
		expect(focusLog.at(-1)).toBeNull();
		await expect(response).rejects.toThrow("Human request was aborted.");
	});
});
