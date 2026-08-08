import { type Component, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import { singleLine } from "../format.ts";
import type { SessionEntryTreeRow } from "../session-tree.ts";
import { theme } from "../theme/theme.ts";
import { type SelectorHintContext, selectorKeyHints } from "./hints.ts";

const MAX_VISIBLE_ROWS = 10;

export interface TreeSelectorRequest {
	readonly title: string;
	/** Preorder rows of the visible agent's session tree (buildSessionEntryRows). */
	readonly rows: readonly SessionEntryTreeRow[];
	/** Row under the cursor when the selector opens; defaults to the current row. */
	readonly initialEntryId?: string;
	onSelect(entryId: string): void;
	onCancel?(): void;
	/**
	 * Hides the host overlay and restores focus. Runs before onSelect/onCancel
	 * so a callback is free to open another selector.
	 */
	onClose(): void;
}

/**
 * /tree's graph navigator: the branch structure of the visible agent's session
 * drawn like the agent strip (├──/└── indentation), with a cursor over the
 * user-message rows. Confirm navigates the session to the row's entry, cancel
 * dismisses. Chrome matches the ListSelector family: rules above and below, a
 * title, and a key-hint footer. Mounting is the caller's job; the application
 * shows it through the overlay stack and wires onClose to hide that overlay.
 */
export class TreeSelector implements Component {
	focused = false;
	private readonly request: TreeSelectorRequest;
	private cursor: number;
	private closed = false;

	constructor(request: TreeSelectorRequest) {
		this.request = request;
		const rows = request.rows;
		let cursor = rows.findIndex((row) => row.entryId === request.initialEntryId);
		if (cursor < 0) cursor = rows.findIndex((row) => row.current);
		if (cursor < 0) cursor = rows.length - 1;
		this.cursor = Math.max(0, cursor);
	}

	get hintContext(): SelectorHintContext | undefined {
		if (this.closed) return undefined;
		return { title: this.request.title, confirmVerb: "switch", itemCount: this.request.rows.length };
	}

	/** Entry id under the cursor, undefined when the tree has no rows. */
	get cursorEntryId(): string | undefined {
		return this.request.rows[this.cursor]?.entryId;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			const row = this.request.rows[this.cursor];
			if (!row) return;
			this.closed = true;
			this.request.onClose();
			this.request.onSelect(row.entryId);
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.closed = true;
			this.request.onClose();
			this.request.onCancel?.();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.closed) return [];
		const rule = theme.border("─".repeat(Math.max(1, width)));
		const lines = [
			rule,
			"",
			truncateToWidth(theme.title(singleLine(this.request.title, 200)), Math.max(1, width - 2), "…"),
			"",
		];
		const rows = this.request.rows;
		if (rows.length === 0) {
			lines.push(theme.dim("No user messages in this session tree."));
		} else {
			const window = this.visibleWindow(rows.length);
			if (window.start > 0) lines.push(theme.dim(`… ${window.start} more above`));
			for (let index = window.start; index < window.end; index++) {
				const row = rows[index];
				if (row) lines.push(this.renderRow(row, index === this.cursor, width));
			}
			if (window.end < rows.length) lines.push(theme.dim(`… ${rows.length - window.end} more below`));
		}
		lines.push("", theme.dim(selectorKeyHints({ confirmLabel: "switch" })), rule);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private move(delta: number): void {
		const count = this.request.rows.length;
		if (count === 0) return;
		this.cursor = Math.min(count - 1, Math.max(0, this.cursor + delta));
	}

	/** Window that always contains the cursor, hugging the top until it scrolls off. */
	private visibleWindow(count: number): { start: number; end: number } {
		let start = Math.max(0, this.cursor - MAX_VISIBLE_ROWS + 1);
		start = Math.min(start, Math.max(0, count - MAX_VISIBLE_ROWS));
		return { start, end: Math.min(count, start + MAX_VISIBLE_ROWS) };
	}

	private renderRow(row: SessionEntryTreeRow, selected: boolean, width: number): string {
		// Same tree-line family as the agent strip: 4-column generations, ├──/└──.
		const prefix = row.depth === 0 ? "" : `${"    ".repeat(row.depth - 1)}${row.last ? "└── " : "├── "}`;
		const glyph = row.current ? theme.info("●") : theme.dim("○");
		const headline = singleLine(row.headline, 80);
		const age = formatEntryAge(row.timestamp);
		const content = `${theme.dim(prefix)}${glyph} ${row.current ? theme.bold(headline) : headline}${
			age ? ` ${theme.dim(age)}` : ""
		}`;
		const line = selected ? theme.inverse(content) : content;
		return truncateToWidth(line, Math.max(1, width), "…");
	}
}

/** Relative age of an entry timestamp: seconds, minutes, hours, then days. */
function formatEntryAge(timestamp: string): string {
	const time = Date.parse(timestamp);
	if (Number.isNaN(time)) return "";
	const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}
