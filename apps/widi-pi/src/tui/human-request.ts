import {
	type Component,
	Input,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type {
	HumanRequestEnvelope,
	HumanResponse,
} from "../core/human-request.ts";
import { boundedText, singleLine } from "./format.ts";
import { colors } from "./theme/colors.ts";
import { selectListTheme } from "./theme/controls.ts";

interface QueuedHumanRequest {
	readonly request: HumanRequestEnvelope;
	readonly signal?: AbortSignal;
	readonly resolve: (response: HumanResponse) => void;
	readonly reject: (error: Error) => void;
	abortListener?: () => void;
	settled: boolean;
}

export class HumanRequestController {
	private readonly tui: TUI;
	private readonly resolveAgentLabel: (agentId: string | undefined) => string;
	private readonly queue: QueuedHumanRequest[] = [];
	private active?: QueuedHumanRequest;
	private overlay?: OverlayHandle;
	private closed = false;

	constructor(options: {
		readonly tui: TUI;
		readonly resolveAgentLabel: (agentId: string | undefined) => string;
	}) {
		this.tui = options.tui;
		this.resolveAgentLabel = options.resolveAgentLabel;
	}

	request(
		request: HumanRequestEnvelope,
		signal?: AbortSignal,
	): Promise<HumanResponse> {
		if (this.closed) {
			return Promise.reject(new Error("TUI human request host is closed."));
		}
		return new Promise((resolve, reject) => {
			const entry: QueuedHumanRequest = {
				request,
				signal,
				resolve,
				reject,
				settled: false,
			};
			if (signal?.aborted) {
				entry.settled = true;
				reject(new Error("Human request was aborted."));
				return;
			}
			if (signal) {
				entry.abortListener = () => this.abort(entry);
				signal.addEventListener("abort", entry.abortListener, {
					once: true,
				});
			}
			this.queue.push(entry);
			this.showNext();
		});
	}

	cancelRequest(requestId: string): void {
		const request =
			this.active?.request.id === requestId
				? this.active
				: this.queue.find((entry) => entry.request.id === requestId);
		if (request) this.abort(request);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.overlay?.hide();
		this.overlay = undefined;
		const pending = [...(this.active ? [this.active] : []), ...this.queue];
		this.active = undefined;
		this.queue.length = 0;
		for (const entry of pending) {
			if (entry.settled) continue;
			entry.settled = true;
			this.detachAbort(entry);
			entry.reject(new Error("TUI is shutting down."));
		}
	}

	private showNext(): void {
		if (this.closed || this.active || this.queue.length === 0) return;
		const entry = this.queue.shift();
		if (!entry || entry.settled) {
			this.showNext();
			return;
		}
		this.active = entry;
		this.showEntry(entry);
	}

	private showEntry(entry: QueuedHumanRequest): void {
		const { request } = entry;
		const agentLabel = this.resolveAgentLabel(request.agentId);
		const title = `${request.title} · agent: ${agentLabel}`;

		if (request.kind === "confirm") {
			this.showSelection(entry, title, [
				{ value: "yes", label: "Yes" },
				{ value: "no", label: "No" },
			]);
			return;
		}
		if (request.kind === "select" || request.kind === "argumentsCompletion") {
			const options = (request.options ?? []).map((option) => ({
				value: option,
				label: singleLine(option, 400),
			}));
			if (request.allowFreeInput) {
				options.push({
					value: "\u0000free-input",
					label: "Type another answer…",
				});
			}
			this.showSelection(entry, title, options);
			return;
		}
		this.showInput(entry, title);
	}

	private showSelection(
		entry: QueuedHumanRequest,
		title: string,
		items: SelectItem[],
	): void {
		if (items.length === 0) {
			this.finish(entry, fallbackResponse(entry.request));
			return;
		}
		const list = new SelectList(
			items,
			Math.min(8, items.length),
			selectListTheme,
		);
		const frame = new HumanRequestFrame({
			title,
			message: entry.request.message,
			content: list,
			hint: "↑↓ select · enter confirm · esc cancel",
		});
		list.onSelect = (item) => {
			if (entry.request.kind === "confirm") {
				this.finish(entry, {
					kind: "confirm",
					confirmed: item.value === "yes",
				});
			} else if (item.value === "\u0000free-input") {
				this.overlay?.hide();
				this.overlay = undefined;
				this.showInput(entry, title);
			} else {
				this.finish(entry, { kind: "select", value: item.value });
			}
		};
		list.onCancel = () => this.finish(entry, fallbackResponse(entry.request));
		this.overlay = this.tui.showOverlay(frame, {
			width: "70%",
			minWidth: 36,
			maxHeight: "70%",
			anchor: "center",
			margin: 1,
		});
	}

	private showInput(entry: QueuedHumanRequest, title: string): void {
		const input = new Input();
		const frame = new HumanRequestFrame({
			title,
			message: entry.request.message,
			content: input,
			placeholder: entry.request.placeholder,
			hint: "enter submit · esc cancel",
		});
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
		this.overlay = this.tui.showOverlay(frame, {
			width: "70%",
			minWidth: 36,
			maxHeight: "70%",
			anchor: "center",
			margin: 1,
		});
	}

	private finish(entry: QueuedHumanRequest, response: HumanResponse): void {
		if (entry.settled) return;
		entry.settled = true;
		this.detachAbort(entry);
		this.overlay?.hide();
		this.overlay = undefined;
		if (this.active === entry) this.active = undefined;
		entry.resolve(response);
		this.showNext();
	}

	private abort(entry: QueuedHumanRequest): void {
		if (entry.settled) return;
		entry.settled = true;
		this.detachAbort(entry);
		const queueIndex = this.queue.indexOf(entry);
		if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
		if (this.active === entry) {
			this.overlay?.hide();
			this.overlay = undefined;
			this.active = undefined;
		}
		entry.reject(new Error("Human request was aborted."));
		this.showNext();
	}

	private detachAbort(entry: QueuedHumanRequest): void {
		if (entry.signal && entry.abortListener) {
			entry.signal.removeEventListener("abort", entry.abortListener);
		}
		entry.abortListener = undefined;
	}
}

class HumanRequestFrame implements Component {
	private readonly title: string;
	private readonly message?: string;
	private readonly content: Component;
	private readonly placeholder?: string;
	private readonly hint: string;
	focused = false;

	constructor(options: {
		readonly title: string;
		readonly message?: string;
		readonly content: Component;
		readonly placeholder?: string;
		readonly hint: string;
	}) {
		this.title = singleLine(options.title, 240);
		this.message = options.message
			? boundedText(options.message, {
					maxLines: 12,
					maxCharacters: 2_000,
				})
			: undefined;
		this.content = options.content;
		this.placeholder = options.placeholder
			? singleLine(options.placeholder, 240)
			: undefined;
		this.hint = singleLine(options.hint, 240);
	}

	handleInput(data: string): void {
		if ("focused" in this.content) {
			(this.content as Component & { focused: boolean }).focused = this.focused;
		}
		this.content.handleInput?.(data);
	}

	invalidate(): void {
		this.content.invalidate();
	}

	render(width: number): string[] {
		if ("focused" in this.content) {
			(this.content as Component & { focused: boolean }).focused = this.focused;
		}
		const innerWidth = Math.max(1, width - 4);
		const title = truncateToWidth(
			` ${this.title} `,
			Math.max(1, width - 4),
			"",
		);
		const titleWidth = visibleWidth(title);
		const top = `┌─${colors.accent(title)}${"─".repeat(
			Math.max(0, width - titleWidth - 3),
		)}┐`;
		const lines = [top];
		const add = (line = "") => {
			const clipped = truncateToWidth(line, innerWidth, "");
			lines.push(
				`│ ${clipped}${" ".repeat(
					Math.max(0, innerWidth - visibleWidth(clipped)),
				)} │`,
			);
		};
		if (this.message) {
			for (const line of this.message.split("\n")) add(line);
			add();
		}
		if (this.placeholder) add(colors.dim(this.placeholder));
		for (const line of this.content.render(innerWidth)) add(line);
		add();
		add(colors.dim(this.hint));
		lines.push(`└${"─".repeat(Math.max(0, width - 2))}┘`);
		return lines;
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
