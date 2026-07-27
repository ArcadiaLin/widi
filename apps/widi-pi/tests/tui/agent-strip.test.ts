import { describe, expect, it } from "vitest";
import { AgentStripView } from "../../src/tui/components/agent-strip.ts";
import {
	createTuiApplicationState,
	ensureAgentProjection,
	setActiveAgent,
} from "../../src/tui/state.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function renderPlain(
	state: ReturnType<typeof createTuiApplicationState>,
	width = 160,
): string[] {
	return new AgentStripView(state)
		.render(width)
		.map((line) => line.replace(ANSI_SEQUENCE, ""));
}

describe("AgentStripView tree rendering", () => {
	it("keeps top-level insertion order instead of forcing the active agent first", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "other", "idle");
		setActiveAgent(state, "main").status = "idle";

		const [top] = renderPlain(state);

		expect(top.indexOf("other")).toBeLessThan(top.indexOf("main"));
		expect(top.startsWith("○ other")).toBe(true);
		expect(top).toContain("● main");
	});

	it("hangs children under their parent with aligned tree lines", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		const childA = ensureAgentProjection(state, "child-a", "running");
		childA.spawnedBy = "main";
		const childB = ensureAgentProjection(state, "child-b", "idle");
		childB.spawnedBy = "main";

		const lines = renderPlain(state);

		expect(lines).toHaveLength(3);
		expect(lines[0].startsWith("● main")).toBe(true);
		expect(lines[1].trimStart().startsWith("├── ○ child-a")).toBe(true);
		expect(lines[2].trimStart().startsWith("└── ○ child-b")).toBe(true);
		// The tree lines align with the parent's glyph column in the top row.
		expect(lines[1].indexOf("├")).toBe(lines[0].indexOf("●"));
		expect(lines[2].indexOf("└")).toBe(lines[0].indexOf("●"));
	});

	it("aligns tree lines under a parent that is not the first top-level agent", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "other", "idle");
		setActiveAgent(state, "main").status = "idle";
		const child = ensureAgentProjection(state, "child", "idle");
		child.spawnedBy = "main";

		const lines = renderPlain(state);

		expect(lines).toHaveLength(2);
		expect(lines[1].indexOf("└")).toBe(lines[0].indexOf("●"));
		expect(lines[1].trimStart().startsWith("└── ○ child")).toBe(true);
	});

	it("renders a child whose spawner is gone as top-level", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		const orphan = ensureAgentProjection(state, "orphan", "idle");
		orphan.spawnedBy = "disposed-parent";

		const lines = renderPlain(state);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("main");
		expect(lines[0]).toContain("orphan");
	});

	it("overrides the glyph with ! for attention states", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		const failed = ensureAgentProjection(state, "failed", "unavailable");
		failed.attention = "error";
		const waiting = ensureAgentProjection(state, "waiting", "idle");
		waiting.attention = "human-request";

		const [top] = renderPlain(state);

		expect(top).toContain("! failed");
		expect(top).toContain("! waiting");
		expect(top).toContain("needs input");
		expect(top).not.toContain("○ failed");
		expect(top).not.toContain("○ waiting");
	});

	it("marks the active child with ● inside the tree", () => {
		const state = createTuiApplicationState();
		ensureAgentProjection(state, "main", "idle");
		const child = setActiveAgent(state, "child");
		child.status = "running";
		child.spawnedBy = "main";

		const lines = renderPlain(state);

		expect(lines[0].startsWith("○ main")).toBe(true);
		expect(lines[1].trimStart().startsWith("└── ● child")).toBe(true);
	});

	it("keeps the narrow-width summary fallback", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "running";
		const child = ensureAgentProjection(state, "child", "running");
		child.spawnedBy = "main";

		const lines = renderPlain(state, 60);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("● main");
		expect(lines[0]).toContain("2 running");
	});
});
