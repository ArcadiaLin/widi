import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { WidiEditor } from "../../src/tui/editor.ts";
import { createWidiKeybindings } from "../../src/tui/keybindings.ts";
import { theme } from "../../src/tui/theme/theme.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (line: string) => line.replace(ANSI_SEQUENCE, "");

/** Expected SGR truecolor open sequence for a palette hex value. */
function paletteSgr(hex: string): string {
	const value = Number.parseInt(hex.slice(1), 16);
	return `38;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`;
}

function createEditor() {
	const tui = {
		terminal: { rows: 40, cols: 80 },
		requestRender: () => {},
	} as unknown as TUI;
	return new WidiEditor(tui, theme.editorTheme, { paddingX: 4 });
}

beforeAll(() => {
	setKeybindings(createWidiKeybindings());
});

describe("WidiEditor chrome", () => {
	it("draws a rounded box with a > prompt on the first content line", () => {
		const editor = createEditor();
		editor.setText("hello");
		const lines = editor.render(60).map(strip);
		expect(lines[0]).toMatch(/^╭─+╮$/u);
		expect(lines.at(-1)).toMatch(/^╰─+╯$/u);
		expect(lines[1]).toMatch(/^│ > hello\s+│$/u);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(60);
		}
	});

	it("keeps the box when the editor is empty", () => {
		const editor = createEditor();
		const lines = editor.render(40).map(strip);
		expect(lines[0]).toMatch(/^╭─+╮$/u);
		expect(lines.at(-1)).toMatch(/^╰─+╯$/u);
		// The inverse-video cursor occupies one cell after the prompt.
		expect(lines[1]).toMatch(/^│ > /u);
		expect(lines[1]).toMatch(/│$/u);
	});

	it("paints the border with the accent color in slash-command context", () => {
		const editor = createEditor();
		editor.setText("/model");
		const top = editor.render(60)[0] ?? "";
		expect(top).toContain(paletteSgr(theme.palette.accent));
		expect(top).not.toContain(paletteSgr(theme.palette.rule));
	});

	it("uses the subdued rule color for plain text", () => {
		const editor = createEditor();
		editor.setText("hello");
		const top = editor.render(60)[0] ?? "";
		expect(top).toContain(paletteSgr(theme.palette.rule));
	});
});
