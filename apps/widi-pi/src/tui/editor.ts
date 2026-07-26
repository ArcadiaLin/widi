import {
	Editor,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { colors } from "./theme/colors.ts";

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
		const rendered = super.render(width);
		const text = this.getText();
		if (
			rendered.length < 3 ||
			text.includes("\n") ||
			!/^\/\S+\s*$/.test(text)
		) {
			return rendered;
		}
		const hint = this.argumentHintProvider?.(text);
		if (!hint) return rendered;
		// Index 1 is the first content line, right under the top border.
		const index = 1;
		const line = (rendered[index] ?? "").replace(/ +$/u, "");
		const available = width - visibleWidth(line) - 1;
		if (available < 2) return rendered;
		const hintText =
			visibleWidth(hint) > available
				? truncateToWidth(hint, available, "…")
				: hint;
		const padding = " ".repeat(
			Math.max(0, width - visibleWidth(line) - 1 - visibleWidth(hintText)),
		);
		rendered[index] = `${line} ${colors.dim(hintText)}${padding}`;
		return rendered;
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
