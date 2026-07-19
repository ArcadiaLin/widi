import {
	type Component,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { singleLine } from "../format.ts";
import type { TuiApplicationState } from "../state.ts";
import { colors } from "../theme/colors.ts";
import { activeAgent } from "./common.ts";

export class FooterView implements Component {
	private readonly state: TuiApplicationState;
	private readonly cwd: string;

	constructor(state: TuiApplicationState, cwd: string) {
		this.state = state;
		this.cwd = cwd;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		const leftParts = [shortCwd(this.cwd)];
		if (agent?.queue.steer.length) {
			leftParts.push(`${agent.queue.steer.length} steer`);
		}
		if (agent?.queue.followUp.length) {
			leftParts.push(`${agent.queue.followUp.length} follow-up`);
		}
		if (agent?.unreadCount) leftParts.push(`${agent.unreadCount} unread`);
		leftParts.push("← agents");
		if (agent?.status === "running") {
			const steerKey = getKeybindings().getKeys("app.steer")[0];
			if (steerKey) leftParts.push(`${steerKey} steer`);
		}
		const left = colors.dim(leftParts.join(" · "));
		const thinkingLevel =
			agent?.display.thinkingLevel ??
			(!agent ? this.state.pendingAgent?.display.thinkingLevel : undefined);
		const right = thinkingLevel
			? colors.dim(`thinking ${singleLine(thinkingLevel, 40)}`)
			: "";
		return [alignSides(left, right, width)];
	}
}

function alignSides(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (rightWidth === 0) return truncateToWidth(left, width, "…");
	if (leftWidth + rightWidth + 2 <= width) {
		return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
	}
	return truncateToWidth(`${left}  ${right}`, width, "…");
}

/** Abbreviate a cwd to `~/p/widi-pi` style: home prefix plus one-letter parents. */
function shortCwd(cwd: string): string {
	const home = process.env.HOME;
	const relative =
		home && cwd.startsWith(home) ? `~${cwd.slice(home.length) || "/"}` : cwd;
	const segments = relative.split("/").filter((segment) => segment !== "");
	if (segments.length <= 2) return relative || "/";
	const abbreviated = segments.map((segment, index) => {
		if (index === segments.length - 1 || segment === "~") return segment;
		return segment.startsWith(".") ? segment.slice(0, 2) : segment.slice(0, 1);
	});
	return `${relative.startsWith("/") ? "/" : ""}${abbreviated.join("/")}`;
}
