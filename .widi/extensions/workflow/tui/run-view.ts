import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../apps/widi/src/tui/theme/theme.ts";
import { MAX_BODY_ROWS, type RowMark, type RunRow, type WorkflowBoard } from "./run-model.ts";

/**
 * The run, drawn. Everything it decides is a paint decision - a glyph, a
 * column, what a narrow terminal gives up first; what to show and what to fold
 * was decided in `run-model.ts`, where it can be tested without a terminal.
 *
 * It renders nothing at all when the visible agent has no run, so the row it
 * occupies above the editor exists only while there is something in it.
 */

/** Where the detail column starts, so rows line up across nesting levels. */
const DETAIL_COLUMN = 13;
/** Below this the right-hand column is dropped; the name and glyph never are. */
const TAIL_MIN_WIDTH = 60;

const GLYPHS: { readonly [mark in RowMark]: string } = {
	pending: "○",
	running: "●",
	retry: "⟳",
	done: "✓",
	failed: "✗",
	note: " ",
};

export class WorkflowRunView implements Component {
	private readonly _board: WorkflowBoard;
	private readonly _paint: Theme;

	constructor(board: WorkflowBoard, paint: Theme) {
		this._board = board;
		this._paint = paint;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const run = this._board.visible();
		if (run === undefined || width < 20) return [];
		const view = run.view(Date.now(), MAX_BODY_ROWS);
		if (this._board.compact) return [truncateToWidth(this._paint.dim(view.compact), width, "…")];
		const rule = this._paint.border("─".repeat(width));
		const lines = [rule, this._headline(view.title, view.meter, width)];
		for (const row of view.rows) lines.push(this._row(row, width));
		if (view.footer !== "") lines.push(this._fit(` ${this._paint.faint(view.footer)}`, width));
		lines.push(rule);
		return lines;
	}

	private _headline(title: string, meter: string, width: number): string {
		const left = ` ${title}`;
		const room = width - visibleWidth(left) - visibleWidth(meter) - 1;
		if (meter === "" || room < 1) return this._fit(this._paint.title(left), width);
		return `${this._paint.title(left)}${" ".repeat(room)}${this._paint.faint(meter)}`;
	}

	private _row(row: RunRow, width: number): string {
		// A note is not a step: no glyph, no columns, nothing to line it up with.
		if (row.mark === "note") return this._fit(` ${this._paint.faint(row.name)}${row.detail}`, width);
		const indent = " ".repeat(1 + row.depth * 2);
		const head = `${indent}${GLYPHS[row.mark]} ${row.name}`;
		const pad = Math.max(1, DETAIL_COLUMN - visibleWidth(head));
		const tail = width >= TAIL_MIN_WIDTH ? row.tail : "";
		const spent = visibleWidth(head) + pad + (tail === "" ? 0 : visibleWidth(tail) + 2);
		const detail = width - spent - 1 < 4 ? "" : truncateToWidth(row.detail, width - spent - 1, "…");
		const body = detail === "" ? "" : `${" ".repeat(pad)}${this._paint.dim(detail)}`;
		const left = `${indent}${this._glyph(row)} ${this._name(row)}${body}`;
		if (tail === "") return left;
		const gap = width - visibleWidth(head) - (detail === "" ? 0 : pad) - visibleWidth(detail) - visibleWidth(tail) - 1;
		return `${left}${" ".repeat(Math.max(1, gap))}${this._paint.faint(tail)}`;
	}

	private _glyph(row: RunRow): string {
		const glyph = GLYPHS[row.mark];
		switch (row.mark) {
			case "running":
				return this._paint.info(glyph);
			case "retry":
				return this._paint.warn(glyph);
			case "done":
				return this._paint.ok(glyph);
			case "failed":
				return this._paint.error(glyph);
			default:
				return this._paint.faint(glyph);
		}
	}

	private _name(row: RunRow): string {
		if (row.name === "") return "";
		return row.live ? this._paint.bold(row.name) : row.mark === "pending" ? this._paint.faint(row.name) : row.name;
	}

	private _fit(line: string, width: number): string {
		return truncateToWidth(line, Math.max(1, width - 1), "…");
	}
}
