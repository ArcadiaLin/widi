import {
	Editor,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { colors } from "./theme/colors.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR matching requires ESC.
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

/** Esc within this window of a completion keystroke cancels the completion. */
const COMPLETION_KEY_SWALLOW_MS = 250;

export class WidiEditor extends Editor {
	onOpenAgents?: () => void;
	onInterrupt?: () => void;
	onExit?: () => void;
	onToggleToolOutput?: () => void;
	onToggleJobs?: () => void;
	onSteer?: () => void;
	onOpenRequests?: () => void;

	private argumentHintProvider?: (text: string) => string | undefined;
	private lastCompletionKeyAt = 0;

	setArgumentHintProvider(
		provider: (text: string) => string | undefined,
	): void {
		this.argumentHintProvider = provider;
	}

	override render(width: number): string[] {
		const text = this.getText();
		// Slash-command context gets the accent border; everything else stays
		// on the subdued rule color. pi-tui paints its horizontal borders with
		// this.borderColor during super.render, and wrapWithSideBorders routes
		// corners and side bars through the same hook below.
		this.borderColor = text.trimStart().startsWith("/")
			? colors.accent
			: colors.rule;
		const rendered = super.render(width);
		if (rendered.length < 3) {
			return wrapWithSideBorders(rendered, (value) => this.borderColor(value));
		}
		this.applyArgumentHint(rendered, width, text);
		// Index 1 is the first content line, right under the top border.
		const prompt = injectPromptSymbol(rendered[1] ?? "");
		if (prompt !== undefined) rendered[1] = prompt;
		return wrapWithSideBorders(rendered, (value) => this.borderColor(value));
	}

	private applyArgumentHint(
		rendered: string[],
		width: number,
		text: string,
	): void {
		if (text.includes("\n") || !/^\/\S+\s*$/.test(text)) return;
		const hint = this.argumentHintProvider?.(text);
		if (!hint) return;
		const index = 1;
		const line = (rendered[index] ?? "").replace(/ +$/u, "");
		const available = width - visibleWidth(line) - 1;
		if (available < 2) return;
		const hintText =
			visibleWidth(hint) > available
				? truncateToWidth(hint, available, "…")
				: hint;
		const padding = " ".repeat(
			Math.max(0, width - visibleWidth(line) - 1 - visibleWidth(hintText)),
		);
		rendered[index] = `${line} ${colors.dim(hintText)}${padding}`;
	}

	override handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "app.tools.expand")) {
			this.onToggleToolOutput?.();
			return;
		}
		if (keybindings.matches(data, "app.jobs.expand")) {
			this.onToggleJobs?.();
			return;
		}
		if (keybindings.matches(data, "app.steer")) {
			this.onSteer?.();
			return;
		}
		if (keybindings.matches(data, "app.request.open")) {
			this.onOpenRequests?.();
			return;
		}
		if (
			keybindings.matches(data, "app.agents.open") &&
			this.getText().length === 0 &&
			!this.isShowingAutocomplete()
		) {
			this.onOpenAgents?.();
			return;
		}
		if (keybindings.matches(data, "app.interrupt")) {
			if (this.isShowingAutocomplete()) {
				this.passToSuper(data);
			} else if (
				Date.now() - this.lastCompletionKeyAt <
				COMPLETION_KEY_SWALLOW_MS
			) {
				// Esc right after a completion keystroke cancels the in-flight
				// completion, not the agent.
			} else {
				this.onInterrupt?.();
			}
			return;
		}
		if (keybindings.matches(data, "app.exit") && this.getText().length === 0) {
			this.onExit?.();
			return;
		}
		this.noteCompletionKey(data);
		this.passToSuper(data);
	}

	/** Timestamp printable keystrokes inside a completion context. */
	private noteCompletionKey(data: string): void {
		if (data.length !== 1 || data.charCodeAt(0) < 32) return;
		const cursor = this.getCursor();
		const before = (this.getLines()[cursor.line] ?? "").slice(0, cursor.col);
		if (/^\/\S*(\s\S*)?$/.test(before) || /(?:^|\s)@\S*$/.test(before)) {
			this.lastCompletionKeyAt = Date.now();
		}
	}

	private passToSuper(data: string): void {
		const wasShowing = this.isShowingAutocomplete();
		super.handleInput(data);
		// The differential renderer leaves the editor "floating" where the
		// taller menu pushed it; force a full redraw when the menu closes.
		if (wasShowing && !this.isShowingAutocomplete()) {
			this.tui.requestRender(true);
		}
	}
}

/**
 * Overlay a terminal-style `> ` prompt symbol on the first content line.
 * Column 0 is reserved for the left vertical border (overlaid later by
 * wrapWithSideBorders); column 1 is a single-space gap, so the `>` token
 * lives at column 2 with column 3 separating it from content. Relies on the
 * editor being configured with `paddingX >= 4` so the line starts with at
 * least four literal spaces. Returns `undefined` if the line is too short or
 * doesn't begin with the expected padding.
 */
function injectPromptSymbol(line: string, symbol = ">"): string | undefined {
	if (line.length < 4) return undefined;
	for (let i = 0; i < 4; i++) {
		if (line[i] !== " ") return undefined;
	}
	return `  ${symbol} ${line.slice(4)}`;
}

/**
 * Post-process pi-tui's editor output to draw a full box around it.
 *
 * pi-tui only renders horizontal top/bottom borders; we wrap them with
 * `╭╮╰╯` corners and add vertical `│` bars on each row's outer columns.
 * Horizontal-border rows (those whose first visible char is `─`, including
 * scroll indicators like `── ↑ N more ──`) are stripped of their existing
 * SGR and repainted as a single box-drawn span. Content rows keep their
 * inner SGR intact; only column 0 and the last column are overlaid, and
 * only if they're literal spaces — that protects the cursor-overflow
 * case where the rightmost column is an SGR-tagged inverse cursor.
 */
function wrapWithSideBorders(
	lines: string[],
	paint: (value: string) => string,
): string[] {
	let seenTop = false;
	return lines.map((line) => {
		const plain = line.replace(ANSI_SGR, "");
		if (plain.length > 0 && plain[0] === "─") {
			const leftCorner = seenTop ? "╰" : "╭";
			const rightCorner = seenTop ? "╯" : "╮";
			seenTop = true;
			if (plain.length === 1) return paint(leftCorner);
			return paint(leftCorner + plain.slice(1, -1) + rightCorner);
		}
		if (line.length === 0) return line;
		const head = line[0] === " " ? paint("│") : line[0];
		if (line.length === 1) return head;
		const tail = line.endsWith(" ") ? paint("│") : (line.at(-1) ?? "");
		return head + line.slice(1, -1) + tail;
	});
}
