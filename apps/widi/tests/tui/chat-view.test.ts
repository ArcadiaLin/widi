import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatView } from "../../src/tui/components/chat.ts";
import { createTuiApplicationState, setActiveAgent } from "../../src/tui/state.ts";
import { loadThemes, resetThemes, setTheme, type ThemePalette } from "../../src/tui/theme/theme.ts";

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
