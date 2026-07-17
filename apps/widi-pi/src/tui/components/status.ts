import { type Component, Text } from "@earendil-works/pi-tui";
import { singleLine } from "../format.ts";
import type { TuiApplicationState } from "../state.ts";
import { colors } from "../theme/colors.ts";
import { activeAgent } from "./common.ts";

export class StatusView implements Component {
	private readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		if (!agent) return [];
		const statuses = [...agent.extensionStatuses.values()];
		if (statuses.length === 0) return [];
		const lines = statuses.slice(0, 4).map((entry) => {
			const progress = entry.status.progress;
			let progressText = "";
			if (progress?.total !== undefined) {
				progressText = ` ${progressBar(progress.completed, progress.total, 10)} ${progress.completed}/${progress.total}`;
			} else if (progress) {
				const spinner = ["⠋", "⠙", "⠹", "⠸"][Math.floor(Date.now() / 160) % 4];
				progressText = ` ${spinner} ${progress.completed}/?`;
			}
			return `${colors.cyan("✻")} ${colors.dim(
				entry.extensionId,
			)} ${singleLine(entry.status.text, 400)}${progressText}`;
		});
		if (statuses.length > 4) {
			lines.push(colors.dim(`+${statuses.length - 4} more extension statuses`));
		}
		return new Text(lines.join("\n"), 1, 0).render(width);
	}
}

function progressBar(completed: number, total: number, width: number): string {
	if (total <= 0) return "░".repeat(width);
	const filled = Math.max(
		0,
		Math.min(width, Math.round((completed / total) * width)),
	);
	return `${colors.green("█".repeat(filled))}${colors.dim(
		"░".repeat(width - filled),
	)}`;
}
