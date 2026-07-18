import { type Component, Text } from "@earendil-works/pi-tui";
import { singleLine } from "../format.ts";
import type { TuiApplicationState } from "../state.ts";
import { colors } from "../theme/colors.ts";
import { activeAgent } from "./common.ts";

const MAX_VISIBLE_MESSAGES = 4;

/**
 * Queued follow-up messages of the active agent, shown above the editor.
 * The queue itself lives in core; this view only mirrors the texts carried
 * by queue_update events, so the footer counts and this list share one
 * source of truth.
 */
export class QueuedInputView implements Component {
	private readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		if (!agent) return [];
		const queued = agent.queue.followUp;
		if (queued.length === 0) return [];
		const lines = [
			colors.dim("queued · follow-up (sent when the current run ends)"),
		];
		for (const text of queued.slice(-MAX_VISIBLE_MESSAGES)) {
			lines.push(`${colors.dim("❯")} ${colors.dim(singleLine(text, 400))}`);
		}
		if (queued.length > MAX_VISIBLE_MESSAGES) {
			lines.push(colors.dim(`… +${queued.length - MAX_VISIBLE_MESSAGES} more`));
		}
		return new Text(lines.join("\n"), 1, 0).render(width);
	}
}
