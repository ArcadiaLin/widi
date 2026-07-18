import {
	type Component,
	getKeybindings,
	Input,
	SelectList,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type {
	HumanRequestEnvelope,
	HumanResponse,
} from "../core/human-request.ts";
import { boundedText, singleLine } from "./format.ts";
import type { TuiApplicationState } from "./state.ts";
import { colors } from "./theme/colors.ts";
import { selectListTheme } from "./theme/controls.ts";

const FREE_INPUT_VALUE = "\x00free-input";
const MAX_VISIBLE_OPTIONS = 8;

interface PendingEntry {
	readonly request: HumanRequestEnvelope;
	readonly signal?: AbortSignal;
	readonly resolve: (response: HumanResponse) => void;
	readonly reject: (error: Error) => void;
	abortListener?: () => void;
	settled: boolean;
	/** select requests with allowFreeInput switch from list to input. */
	view: "list" | "input";
	list?: SelectList;
	input?: Input;
}

/** The slice of TUI the menu needs; kept minimal so tests can fake it. */
export interface HumanRequestMenuHost {
	setFocus(component: Component | null): void;
	requestRender(): void;
}

/**
 * Docked human-request host: every pending request is a completion-menu
 * instance above the editor, in the normal component flow. Requests for the
 * active agent open the menu and take focus; background requests only add a
 * pending hint (or a tab entry while the menu is open) and are reachable via
 * app.request.open. Consecutive requests of a multi-step flow reuse the same
 * docked slot; focus briefly returns to the editor when one step resolves
 * before the next arrives. The fatal error overlay is the only remaining
 * overlay user.
 */
export class HumanRequestMenu implements Component {
	focused = false;
	private readonly host: HumanRequestMenuHost;
	private readonly state: TuiApplicationState;
	private readonly resolveAgentLabel: (agentId: string | undefined) => string;
	private readonly restoreFocus: () => void;
	private readonly entries: PendingEntry[] = [];
	private focusedIndex = 0;
	private opened = false;
	private closed = false;

	constructor(options: {
		readonly host: HumanRequestMenuHost;
		readonly state: TuiApplicationState;
		readonly resolveAgentLabel: (agentId: string | undefined) => string;
		readonly restoreFocus: () => void;
	}) {
		this.host = options.host;
		this.state = options.state;
		this.resolveAgentLabel = options.resolveAgentLabel;
		this.restoreFocus = options.restoreFocus;
	}

	get isOpen(): boolean {
		return this.opened && this.entries.length > 0;
	}

	get pendingCount(): number {
		return this.entries.length;
	}

	request(
		request: HumanRequestEnvelope,
		signal?: AbortSignal,
	): Promise<HumanResponse> {
		if (this.closed) {
			return Promise.reject(new Error("TUI human request host is closed."));
		}
		return new Promise((resolve, reject) => {
			const entry: PendingEntry = {
				request,
				signal,
				resolve,
				reject,
				settled: false,
				view:
					request.kind === "input" || request.kind === "custom"
						? "input"
						: "list",
			};
			if (signal?.aborted) {
				entry.settled = true;
				reject(new Error("Human request was aborted."));
				return;
			}
			if (signal) {
				entry.abortListener = () => this.abort(entry);
				signal.addEventListener("abort", entry.abortListener, { once: true });
			}
			this.buildContent(entry);
			this.entries.push(entry);
			const foreground =
				request.agentId === undefined ||
				request.agentId === this.state.activeAgentId;
			if (this.opened) {
				this.host.requestRender();
			} else if (foreground) {
				this.openAt(this.entries.length - 1);
			} else {
				// Background request: raise no focus; the pending hint line and the
				// agent strip attention are the only visible signals.
				this.host.requestRender();
			}
		});
	}

	/** app.request.open: jump to the most recent pending request. */
	openLatest(): void {
		if (this.entries.length === 0) return;
		this.openAt(this.entries.length - 1);
	}

	cancelRequest(requestId: string): void {
		const entry = this.entries.find(
			(candidate) => candidate.request.id === requestId,
		);
		if (entry) this.abort(entry);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		const pending = [...this.entries];
		this.entries.length = 0;
		this.opened = false;
		for (const entry of pending) {
			if (entry.settled) continue;
			entry.settled = true;
			this.detachAbort(entry);
			entry.reject(new Error("TUI is shutting down."));
		}
	}

	handleInput(data: string): void {
		const entry = this.entries[this.focusedIndex];
		if (!entry) return;
		const keybindings = getKeybindings();
		// Request switching only while the current content is a list; an input
		// row keeps left/right for cursor movement.
		if (this.entries.length > 1 && entry.view === "list") {
			if (keybindings.matches(data, "app.request.previous")) {
				this.focusedIndex =
					(this.focusedIndex + this.entries.length - 1) % this.entries.length;
				this.host.requestRender();
				return;
			}
			if (keybindings.matches(data, "app.request.next")) {
				this.focusedIndex = (this.focusedIndex + 1) % this.entries.length;
				this.host.requestRender();
				return;
			}
		}
		const content = entry.view === "input" ? entry.input : entry.list;
		if (content instanceof Input) content.focused = this.focused;
		content?.handleInput(data);
		this.host.requestRender();
	}

	invalidate(): void {
		for (const entry of this.entries) {
			entry.list?.invalidate();
			entry.input?.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.entries.length === 0) return [];
		if (!this.opened) return this.renderPendingHint(width);
		const entry = this.entries[this.focusedIndex];
		if (!entry) return [];
		const lines: string[] = [""];
		if (this.entries.length > 1) lines.push(this.renderTabRow(width));
		const agentLabel = this.resolveAgentLabel(entry.request.agentId);
		const provisional = entry.request.provisional ? " · provisional" : "";
		lines.push(
			truncateToWidth(
				`${colors.accent(singleLine(entry.request.title, 200))}${colors.dim(
					` · agent: ${agentLabel} · ${entry.request.kind}${provisional}`,
				)}`,
				Math.max(1, width - 2),
				"…",
			),
		);
		if (entry.request.message) {
			for (const line of boundedText(entry.request.message, {
				maxLines: 12,
				maxCharacters: 2_000,
			}).split("\n")) {
				lines.push(truncateToWidth(line, Math.max(1, width - 2), "…"));
			}
		}
		if (entry.view === "input") {
			if (entry.request.placeholder && !entry.input?.getValue()) {
				lines.push(colors.dim(singleLine(entry.request.placeholder, 200)));
			}
			const input = entry.input;
			if (input) {
				input.focused = this.focused;
				lines.push(...input.render(Math.max(8, width - 2)));
			}
			lines.push(colors.dim(this.hintLine("enter submit · esc dismiss")));
		} else {
			const list = entry.list;
			if (list) lines.push(...list.render(width));
			lines.push(
				colors.dim(this.hintLine("↑↓ select · enter confirm · esc dismiss")),
			);
		}
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private hintLine(base: string): string {
		return this.entries.length > 1 ? `${base} · ←→ switch request` : base;
	}

	private renderTabRow(width: number): string {
		const parts = this.entries.map((entry, index) => {
			const label = `${this.resolveAgentLabel(entry.request.agentId)} · ${entry.request.kind}`;
			return index === this.focusedIndex
				? colors.accent(`● ${singleLine(label, 60)}`)
				: colors.dim(`○ ${singleLine(label, 60)}`);
		});
		const row = parts.join(colors.dim("  ·  "));
		return visibleWidth(row) > width
			? truncateToWidth(row, Math.max(1, width - 1), "…")
			: row;
	}

	private renderPendingHint(width: number): string[] {
		const keys = getKeybindings().getKeys("app.request.open");
		const count = this.entries.length;
		const hint = `${count} pending request${count > 1 ? "s" : ""}${
			keys[0] ? ` · ${keys[0]} to answer` : ""
		}`;
		return [truncateToWidth(colors.yellow(`! ${hint}`), width, "…")];
	}

	private openAt(index: number): void {
		if (this.closed || this.entries.length === 0) return;
		this.focusedIndex = Math.max(0, Math.min(index, this.entries.length - 1));
		this.opened = true;
		this.state.mode = "human-request";
		this.host.setFocus(this);
		this.host.requestRender();
	}

	private closeMenu(): void {
		this.opened = false;
		if (this.state.mode === "human-request") this.state.mode = "editor";
		this.restoreFocus();
		this.host.requestRender();
	}

	private buildContent(entry: PendingEntry): void {
		const { request } = entry;
		if (request.kind === "confirm") {
			const list = new SelectList(
				[
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				],
				2,
				selectListTheme,
			);
			list.onSelect = (item) => {
				this.finish(entry, {
					kind: "confirm",
					confirmed: item.value === "yes",
				});
			};
			list.onCancel = () => this.finish(entry, fallbackResponse(request));
			entry.list = list;
			return;
		}
		if (request.kind === "select") {
			const items = (request.options ?? []).map((option) => ({
				value: option,
				label: singleLine(option, 400),
			}));
			if (request.allowFreeInput) {
				items.push({ value: FREE_INPUT_VALUE, label: "Type another answer…" });
			}
			if (items.length === 0) {
				// Nothing to choose from: fall back to a plain input row.
				entry.view = "input";
				entry.input = this.buildInput(entry);
				return;
			}
			const list = new SelectList(
				items,
				Math.min(MAX_VISIBLE_OPTIONS, items.length),
				selectListTheme,
			);
			list.onSelect = (item) => {
				if (item.value === FREE_INPUT_VALUE) {
					entry.view = "input";
					entry.input = this.buildInput(entry);
					this.host.requestRender();
					return;
				}
				this.finish(entry, { kind: "select", value: item.value });
			};
			list.onCancel = () => this.finish(entry, fallbackResponse(request));
			entry.list = list;
			return;
		}
		entry.input = this.buildInput(entry);
	}

	private buildInput(entry: PendingEntry): Input {
		const input = new Input();
		input.onSubmit = (value) => {
			const answer = value.trim() || undefined;
			switch (entry.request.kind) {
				case "select":
					this.finish(entry, { kind: "select", value: answer });
					break;
				case "custom":
					this.finish(entry, { kind: "custom", value: answer });
					break;
				default:
					this.finish(entry, { kind: "input", value: answer });
					break;
			}
		};
		input.onEscape = () => this.finish(entry, fallbackResponse(entry.request));
		return input;
	}

	private finish(entry: PendingEntry, response: HumanResponse): void {
		if (entry.settled) return;
		entry.settled = true;
		this.detachAbort(entry);
		this.removeEntry(entry);
		entry.resolve(response);
	}

	private abort(entry: PendingEntry): void {
		if (entry.settled) return;
		entry.settled = true;
		this.detachAbort(entry);
		this.removeEntry(entry);
		entry.reject(new Error("Human request was aborted."));
	}

	private removeEntry(entry: PendingEntry): void {
		const index = this.entries.indexOf(entry);
		if (index >= 0) this.entries.splice(index, 1);
		if (this.entries.length === 0) {
			if (this.opened) this.closeMenu();
			else this.host.requestRender();
			return;
		}
		if (index >= 0 && index < this.focusedIndex) this.focusedIndex--;
		if (this.focusedIndex >= this.entries.length) {
			this.focusedIndex = this.entries.length - 1;
		}
		this.host.requestRender();
	}

	private detachAbort(entry: PendingEntry): void {
		if (entry.signal && entry.abortListener) {
			entry.signal.removeEventListener("abort", entry.abortListener);
		}
		entry.abortListener = undefined;
	}
}

function fallbackResponse(request: HumanRequestEnvelope): HumanResponse {
	switch (request.kind) {
		case "confirm":
			return { kind: "confirm", confirmed: false };
		case "select":
			return { kind: "select", value: undefined };
		case "custom":
			return { kind: "custom", value: undefined };
		default:
			return { kind: "input", value: undefined };
	}
}
