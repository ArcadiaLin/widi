import { execFile } from "node:child_process";
import {
	type Component,
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
	private readonly git: GitBranchCache;

	constructor(state: TuiApplicationState, cwd: string, onRefresh?: () => void) {
		this.state = state;
		this.cwd = cwd;
		this.git = new GitBranchCache(cwd, onRefresh ?? (() => {}));
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		const leftParts = [shortCwd(this.cwd)];
		const branch = this.git.current();
		if (branch) leftParts.push(`⎇ ${branch}`);
		if (agent?.queue.steer.length) {
			leftParts.push(`${agent.queue.steer.length} steer`);
		}
		if (agent?.queue.followUp.length) {
			leftParts.push(`${agent.queue.followUp.length} follow-up`);
		}
		if (agent?.unreadCount) leftParts.push(`${agent.unreadCount} unread`);
		const left = colors.dim(leftParts.join(" · "));
		const thinkingLevel =
			agent?.display.thinkingLevel ??
			(!agent ? this.state.pendingAgent?.display.thinkingLevel : undefined);
		const rightParts: string[] = [];
		if (thinkingLevel) {
			rightParts.push(`thinking ${singleLine(thinkingLevel, 40)}`);
		}
		const context = contextReadout(this.state);
		if (context) rightParts.push(context);
		const right = colors.dim(rightParts.join(" · "));
		return [alignSides(left, right, width)];
	}
}

/** `context: N% (12.3k/200k)` from the latest assistant-turn usage. */
function contextReadout(state: TuiApplicationState): string | undefined {
	const agent = activeAgent(state);
	if (!agent) return undefined;
	const tokens = agent.display.contextTokens;
	const contextWindow =
		agent.display.model?.contextWindow ?? agent.snapshot?.model.contextWindow;
	if (tokens === undefined || !contextWindow || contextWindow <= 0) {
		return undefined;
	}
	const percent = Math.round((tokens / contextWindow) * 100);
	return `context: ${percent}% (${formatTokenCount(tokens)}/${formatTokenCount(contextWindow)})`;
}

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
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

const GIT_REFRESH_MS = 5_000;

/**
 * Throttled, non-blocking git branch lookup. `current()` returns the cached
 * value and kicks off a refresh at most every GIT_REFRESH_MS; when a refresh
 * resolves to a different branch, onChange fires so the host can re-render.
 */
class GitBranchCache {
	private readonly cwd: string;
	private readonly onChange: () => void;
	private branch?: string;
	private lastRefreshAt = 0;
	private inFlight = false;

	constructor(cwd: string, onChange: () => void) {
		this.cwd = cwd;
		this.onChange = onChange;
	}

	current(): string | undefined {
		const now = Date.now();
		if (!this.inFlight && now - this.lastRefreshAt >= GIT_REFRESH_MS) {
			this.inFlight = true;
			this.lastRefreshAt = now;
			void this.refresh();
		}
		return this.branch;
	}

	private async refresh(): Promise<void> {
		try {
			const branch = await queryGitBranch(this.cwd);
			if (branch !== this.branch) {
				this.branch = branch;
				this.onChange();
			}
		} finally {
			this.inFlight = false;
		}
	}
}

function queryGitBranch(cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", cwd, "branch", "--show-current"],
			(error, stdout) => {
				if (!error && stdout.trim()) {
					resolve(stdout.trim());
					return;
				}
				// Detached HEAD or an unborn branch: fall back to the short commit.
				execFile(
					"git",
					["-C", cwd, "rev-parse", "--short", "HEAD"],
					(revError, revStdout) => {
						resolve(revError ? undefined : revStdout.trim() || undefined);
					},
				);
			},
		);
	});
}
