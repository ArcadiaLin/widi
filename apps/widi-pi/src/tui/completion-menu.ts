import {
	type Component,
	fuzzyFilter,
	type SelectItem,
	SelectList,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { Command } from "../core/command.ts";
import { singleLine } from "./format.ts";
import type { TuiApplicationState } from "./state.ts";
import { colors } from "./theme/colors.ts";
import { selectListTheme } from "./theme/controls.ts";

const MAX_VISIBLE_ITEMS = 8;
const DEFAULT_HINT = "↑↓ select · enter confirm · esc cancel · type to filter";

export interface CompletionMenuRequest {
	readonly title: string;
	readonly items: readonly SelectItem[];
	readonly hint?: string;
	/** Index selected when the menu opens (before any filtering). */
	readonly initialIndex?: number;
	onSelect(item: SelectItem): void;
	onCancel?(): void;
}

/** The slice of TUI the menu needs; kept minimal so tests can fake it. */
export interface CompletionMenuHost {
	setFocus(component: Component | null): void;
	requestRender(): void;
}

/**
 * Inline completion menu docked above the editor. It renders in the normal
 * component flow (pushing the transcript up instead of overlaying it) and
 * takes keyboard focus while open: printable characters build a fuzzy
 * filter, everything else drives the embedded SelectList.
 */
export class CompletionMenu implements Component {
	focused = false;
	private readonly host: CompletionMenuHost;
	private readonly state: TuiApplicationState;
	private readonly restoreFocus: () => void;
	private request?: CompletionMenuRequest;
	private list?: SelectList;
	private filter = "";

	constructor(
		host: CompletionMenuHost,
		state: TuiApplicationState,
		restoreFocus: () => void,
	) {
		this.host = host;
		this.state = state;
		this.restoreFocus = restoreFocus;
	}

	get isOpen(): boolean {
		return this.request !== undefined;
	}

	open(request: CompletionMenuRequest): void {
		this.request = request;
		this.filter = "";
		this.rebuildList();
		if (request.initialIndex !== undefined) {
			this.list?.setSelectedIndex(request.initialIndex);
		}
		this.state.mode = "completion-menu";
		this.host.setFocus(this);
		this.host.requestRender();
	}

	close(): void {
		if (!this.request) return;
		this.request = undefined;
		this.list = undefined;
		this.filter = "";
		if (this.state.mode === "completion-menu") this.state.mode = "editor";
		this.restoreFocus();
		this.host.requestRender();
	}

	handleInput(data: string): void {
		if (!this.request) return;
		if (data === "\u007f" || data === "\b") {
			if (this.filter.length > 0) {
				this.filter = this.filter.slice(0, -1);
				this.rebuildList();
			}
			this.host.requestRender();
			return;
		}
		if (isPrintable(data)) {
			this.filter += data;
			this.rebuildList();
			this.host.requestRender();
			return;
		}
		// Arrow keys, enter, and escape belong to the list; escape lands in its
		// onCancel and enter in its onSelect.
		this.list?.handleInput(data);
		this.host.requestRender();
	}

	invalidate(): void {
		this.list?.invalidate();
	}

	render(width: number): string[] {
		const request = this.request;
		if (!request || !this.list) return [];
		const lines = [
			"",
			truncateToWidth(
				colors.accent(singleLine(request.title, 200)),
				Math.max(1, width - 2),
				"…",
			),
		];
		if (this.filter) {
			lines.push(colors.dim(`filter: ${singleLine(this.filter, 120)}`));
		}
		lines.push(...this.list.render(width));
		lines.push(
			colors.dim(
				truncateToWidth(
					singleLine(request.hint ?? DEFAULT_HINT, 200),
					Math.max(1, width - 2),
					"…",
				),
			),
		);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private rebuildList(): void {
		const request = this.request;
		if (!request) return;
		const items = this.filter
			? fuzzyFilter(
					[...request.items],
					this.filter,
					(item) => `${item.label} ${item.value}`,
				)
			: [...request.items];
		const list = new SelectList(
			items,
			Math.max(1, Math.min(MAX_VISIBLE_ITEMS, items.length)),
			selectListTheme,
			{ minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 40 },
		);
		list.onSelect = (item) => {
			const select = this.request?.onSelect;
			this.close();
			select?.(item);
		};
		list.onCancel = () => {
			const cancel = this.request?.onCancel;
			this.close();
			cancel?.();
		};
		this.list = list;
	}
}

/**
 * A submitted line that names a selector command without an argument, e.g.
 * `/model`. Only commands that can produce candidates qualify; submitting
 * one opens the completion menu instead of executing the bare command.
 */
export function matchBareSelectorCommand(
	text: string,
	commands: readonly Command[],
): Command | undefined {
	const trimmed = text.trim();
	return commands.find(
		(command) =>
			command.placement === "line" &&
			command.available !== false &&
			command.arguments?.complete !== undefined &&
			`${command.trigger}${command.name}` === trimmed,
	);
}

function isPrintable(data: string): boolean {
	if (data.length === 0) return false;
	// Reject anything containing control characters (escape sequences, enter,
	// tab); multi-character pastes of plain text are allowed.
	for (const char of data) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 32 || code === 127) return false;
	}
	return true;
}
