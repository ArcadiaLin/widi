import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatView } from "../../src/tui/components/chat.ts";
import { createTuiApplicationState, setActiveAgent, type ToolExecutionItem } from "../../src/tui/state.ts";
import { loadThemes, resetThemes, setTheme, type ThemePalette } from "../../src/tui/theme/theme.ts";
import { registerToolPresenter, unregisterToolPresenter } from "../../src/tui/tool-presenter.ts";

const ALT_PALETTE: ThemePalette = {
	accent: "#ff0000",
	ok: "#00ff00",
	warn: "#ffff00",
	error: "#ff00ff",
	info: "#00ffff",
	muted: "#888888",
	faint: "#444444",
	rule: "#00ff00",
	surface: "#101010",
};

function stateWithUserMessage() {
	const state = createTuiApplicationState();
	const agent = setActiveAgent(state, "agent-1");
	agent.timeline.push({
		type: "user-message",
		id: "m1",
		durability: "durable",
		createdAt: "2026-01-01T00:00:00.000Z",
		text: "hello",
	});
	return state;
}

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(lines: readonly string[]): string[] {
	return lines.map((line) => line.replace(ANSI_SEQUENCE, "").trimEnd());
}

describe("ChatView render cache", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "widi-chat-view-"));
		await mkdir(join(agentDir, "themes"), { recursive: true });
		await writeFile(join(agentDir, "themes", "alt.json"), JSON.stringify(ALT_PALETTE));
		loadThemes(agentDir);
	});

	afterEach(async () => {
		resetThemes();
		await rm(agentDir, { recursive: true, force: true });
	});

	it("serves cached lines while the theme is unchanged and repaints on a switch", () => {
		const view = new ChatView(stateWithUserMessage());
		const first = view.render(40);
		const second = view.render(40);
		expect(second).toEqual(first);

		expect(setTheme("alt")).toBe(true);
		const repainted = view.render(40);

		// The user row carries the surface background; the two palettes paint it
		// differently, so a stale cache would fail this byte comparison.
		expect(repainted).not.toEqual(first);
		expect(stripAnsi(repainted)).toEqual(stripAnsi(first));
	});
});

function toolItem(overrides: Partial<ToolExecutionItem>): ToolExecutionItem {
	return {
		type: "tool-execution",
		id: "tool-1",
		toolCallId: "tool-1",
		durability: "durable",
		createdAt: "2026-01-01T00:00:00.000Z",
		toolName: "bash",
		args: { command: "seq 3" },
		status: "completed",
		isError: false,
		...overrides,
	};
}

function stateWithTimeline(items: readonly ToolExecutionItem[], agentId = "agent-1") {
	const state = createTuiApplicationState();
	const agent = setActiveAgent(state, agentId);
	agent.timeline.push(...items);
	return state;
}

describe("ChatView component presenters (parity §4.3-2)", () => {
	afterEach(() => {
		unregisterToolPresenter("bash");
	});

	it("creates one instance per toolCallId, feeds updates, disposes on trim", () => {
		const calls: string[] = [];
		let current: ToolExecutionItem | undefined;
		let currentExpanded = false;
		registerToolPresenter("bash", {
			kind: "component",
			factory: (item, context) => {
				calls.push("factory");
				current = item;
				currentExpanded = context.expanded;
				return {
					render: () => [`row:${current?.args ? JSON.stringify(current.args) : ""}:${currentExpanded}`],
					invalidate: () => {},
					update: (next, nextContext) => {
						calls.push("update");
						current = next;
						currentExpanded = nextContext.expanded;
					},
					dispose: () => {
						calls.push("dispose");
					},
				};
			},
		});
		const item = toolItem({});
		const state = stateWithTimeline([item]);
		const view = new ChatView(state);

		const first = view.render(60);
		expect(calls).toEqual(["factory"]);
		expect(first.some((line) => line.includes('row:{"command":"seq 3"}:false'))).toBe(true);

		// A same-toolCallId replacement (what the projector does on stream
		// transitions) reuses the instance through update(); the per-item flag
		// wins over the global toggle.
		const replacement = toolItem({ args: { command: "seq 9" }, expanded: true });
		state.agents.get("agent-1")?.timeline.splice(0, 1, replacement);
		const second = view.render(60);
		expect(calls).toEqual(["factory", "update"]);
		expect(second.some((line) => line.includes('row:{"command":"seq 9"}:true'))).toBe(true);

		// The row left the timeline (windowing): the instance is disposed.
		state.agents.get("agent-1")?.timeline.splice(0, 1);
		view.render(60);
		expect(calls).toEqual(["factory", "update", "dispose"]);
	});

	it("degrades to the generic lines when the factory or the render throws", () => {
		registerToolPresenter("bash", {
			kind: "component",
			factory: () => {
				throw new Error("factory boom");
			},
		});
		const state = stateWithTimeline([toolItem({})]);
		const view = new ChatView(state);

		const lines = stripAnsi(view.render(60));
		expect(lines.some((line) => line.includes("bash command: seq 3"))).toBe(true);
	});
});
