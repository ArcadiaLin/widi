import {
	type Component,
	fuzzyFilter,
	getKeybindings,
	type SelectItem,
	SelectList,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { formatOperationHintKey } from "../components/operation-hint.ts";
import { singleLine } from "../format.ts";
import { theme } from "../theme/theme.ts";

const MAX_VISIBLE_ITEMS = 8;

export interface ListSelectorOperation {
	readonly description?: string;
	readonly confirmVerb: "apply" | "switch";
}

export interface ListSelectorHintContext {
	readonly title: string;
	readonly description?: string;
	readonly confirmVerb: "apply" | "switch";
	readonly itemCount: number;
}

export interface ListSelectorRequest {
	readonly title: string;
	readonly items: readonly SelectItem[];
	readonly operation?: ListSelectorOperation;
	/** Index selected when the selector opens (before any filtering). */
	readonly initialIndex?: number;
	/** Pre-filled filter text (a query the submit path already tried). */
	readonly initialFilter?: string;
	onSelect(item: SelectItem): void;
	onCancel?(): void;
	/**
	 * Hides the host overlay and restores focus. Runs before onSelect/onCancel
	 * so a callback is free to open another selector.
	 */
	onClose(): void;
}

/**
 * Shared overlay selector for picking one candidate out of a list, styled
 * after pi's ExtensionSelectorComponent: horizontal rules above and below, an
 * optional filter line, the SelectList cursor, and a key-hint footer.
 * Printable characters build a fuzzy filter, everything else drives the
 * embedded SelectList. Mounting is the caller's job: the application shows it
 * through `tui.showOverlay` and wires `onClose` to hide that overlay.
 */
export class ListSelector implements Component {
	focused = false;
	private readonly request: ListSelectorRequest;
	private list: SelectList;
	private filter: string;
	private filteredItemCount = 0;
	private closed = false;

	constructor(request: ListSelectorRequest) {
		this.request = request;
		this.filter = request.initialFilter ?? "";
		this.list = this.buildList();
		if (request.initialIndex !== undefined) this.list.setSelectedIndex(request.initialIndex);
	}

	get hintContext(): ListSelectorHintContext | undefined {
		if (this.closed) return undefined;
		const operation = this.request.operation;
		if (!operation) return undefined;
		return {
			title: this.request.title,
			description: operation.description,
			confirmVerb: operation.confirmVerb,
			itemCount: this.filteredItemCount,
		};
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const keybindings = getKeybindings();
		const selectionActions = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
		if (selectionActions.some((action) => keybindings.matches(data, action))) {
			this.list.handleInput(data);
			return;
		}
		if (data === "\u007f" || data === "\b") {
			if (this.filter.length > 0) {
				this.filter = this.filter.slice(0, -1);
				this.list = this.buildList();
			}
			return;
		}
		if (isPrintable(data)) {
			this.filter += data;
			this.list = this.buildList();
			return;
		}
		// Arrow keys, enter, and escape belong to the list; escape lands in its
		// onCancel and enter in its onSelect.
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		if (this.closed) return [];
		const rule = theme.border("─".repeat(Math.max(1, width)));
		const lines = [
			rule,
			"",
			truncateToWidth(theme.title(singleLine(this.request.title, 200)), Math.max(1, width - 2), "…"),
		];
		if (this.filter) {
			lines.push(
				theme.dim(`filter: ${singleLine(this.filter, 120)} (${this.filteredItemCount}/${this.request.items.length})`),
			);
		}
		lines.push("", ...this.list.render(width), "", theme.dim(keyHints()), rule);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private buildList(): SelectList {
		const items = this.filter
			? fuzzyFilter([...this.request.items], this.filter, (item) => `${item.label} ${item.value}`)
			: [...this.request.items];
		this.filteredItemCount = items.length;
		const list = new SelectList(items, Math.max(1, Math.min(MAX_VISIBLE_ITEMS, items.length)), theme.selectListTheme, {
			minPrimaryColumnWidth: 16,
			maxPrimaryColumnWidth: 40,
		});
		list.onSelect = (item) => {
			if (this.closed) return;
			this.closed = true;
			this.request.onClose();
			this.request.onSelect(item);
		};
		list.onCancel = () => {
			if (this.closed) return;
			this.closed = true;
			this.request.onClose();
			this.request.onCancel?.();
		};
		return list;
	}
}

function keyHints(): string {
	const keybindings = getKeybindings();
	const key = (action: Parameters<typeof keybindings.getKeys>[0]): string | undefined => {
		const keyId = keybindings.getKeys(action)[0];
		return keyId ? formatOperationHintKey(keyId) : undefined;
	};
	const keyAction = (action: Parameters<typeof keybindings.getKeys>[0], label: string): string | undefined => {
		const keyId = key(action);
		return keyId ? `${keyId} ${label}` : undefined;
	};
	const navigate = [key("tui.select.up"), key("tui.select.down")]
		.filter((candidate): candidate is string => candidate !== undefined)
		.join("/");
	const parts = [
		navigate ? `${navigate} navigate` : undefined,
		"type to filter",
		keyAction("tui.select.confirm", "select"),
		keyAction("tui.select.cancel", "cancel"),
	];
	return parts.filter((part): part is string => part !== undefined).join("  ");
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
