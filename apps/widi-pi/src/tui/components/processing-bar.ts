import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { formatRelativeAge, singleLine } from "../format.ts";
import type { AgentViewState, TuiApplicationState } from "../state.ts";
import { colors } from "../theme/colors.ts";
import { activeAgent } from "./common.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
const NARROW_WIDTH = 60;

/**
 * One line under the header while the active agent is running: the user
 * message being processed, the current activity and the elapsed time. All
 * facts come from the existing projection; narrow terminals degrade to
 * spinner + elapsed only.
 */
export class ProcessingBarView implements Component {
	private readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		if (!agent || agent.status !== "running") return [];
		const spinner =
			SPINNER_FRAMES[Math.floor(Date.now() / 160) % SPINNER_FRAMES.length];
		const elapsed = agent.runStartedAt
			? elapsedSince(agent.runStartedAt)
			: undefined;
		if (width < NARROW_WIDTH) {
			const line = [colors.cyan(`${spinner}`), elapsed && colors.dim(elapsed)]
				.filter(Boolean)
				.join(" ");
			return new Text(line, 1, 0).render(width);
		}
		const parts = [colors.cyan(`${spinner} ${currentMessage(agent)}`)];
		const activity = currentActivity(agent);
		if (activity) parts.push(colors.dim(`· ${activity}`));
		if (elapsed) parts.push(colors.dim(`· ${elapsed}`));
		return new Text(
			truncateToWidth(parts.join(" "), width - 2, "…"),
			1,
			0,
		).render(width);
	}
}

function currentMessage(agent: AgentViewState): string {
	for (let index = agent.timeline.length - 1; index >= 0; index--) {
		const item = agent.timeline[index];
		if (item?.type === "user-message" && item.text) {
			return singleLine(item.text, 160);
		}
	}
	if (agent.pendingInput) {
		return singleLine(agent.pendingInput.originalText, 160);
	}
	return "Working…";
}

function currentActivity(agent: AgentViewState): string | undefined {
	let thinking = false;
	for (let index = agent.timeline.length - 1; index >= 0; index--) {
		const item = agent.timeline[index];
		if (item?.type === "tool-execution" && item.status === "running") {
			return item.toolName;
		}
		if (item?.type === "thinking-status" && item.status === "thinking") {
			thinking = true;
		}
	}
	return thinking ? "thinking" : undefined;
}

function elapsedSince(runStartedAt: string): string | undefined {
	const elapsedMs = Date.now() - Date.parse(runStartedAt);
	if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;
	return formatRelativeAge(elapsedMs);
}
