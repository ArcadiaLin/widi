import {
	type Component,
	Markdown,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { OrchestratorDiagnostic } from "../../core/diagnostics.ts";
import { fixCjkLineStarts } from "../cjk-wrap.ts";
import { boundedText, formatUnknown, singleLine } from "../format.ts";
import type {
	AgentViewState,
	TimelineItem,
	TuiApplicationState,
} from "../state.ts";
import { colors, markdownTheme, severityColor } from "../theme.ts";
import { presentToolExecution } from "../tool-presenter.ts";

export class HeaderView implements Component {
	private readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		const label = agent ? agentLabel(agent) : "starting";
		const model =
			agent?.display.model?.id ?? agent?.snapshot?.model.id ?? "model";
		return new Text(
			`${colors.bold(colors.accent("WIDI"))} ${colors.dim(
				`· ${label} · ${singleLine(model, 120)}`,
			)}`,
			1,
			1,
		).render(width);
	}
}

export class NoticeView implements Component {
	private readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const startup = this.state.globalNotices.filter(
			(notice) => notice.kind === "startup",
		);
		const transient = this.state.globalNotices
			.filter((notice) => notice.kind !== "startup")
			.slice(-4);
		const notices = [...startup, ...transient];
		if (notices.length === 0) return [];
		const lines = notices.map((notice) => {
			if (notice.kind === "startup") {
				return colors.dim(singleLine(notice.text, 400));
			}
			const attribution = [
				notice.agentId && `agent:${notice.agentId}`,
				notice.extensionId && `extension:${notice.extensionId}`,
			]
				.filter(Boolean)
				.join(" · ");
			if (notice.diagnostic) {
				const color = severityColor(notice.diagnostic.severity);
				return color(
					`${diagnosticGlyph(notice.diagnostic)} ${notice.diagnostic.code}: ${singleLine(notice.text)}`,
				);
			}
			return colors.cyan(
				`✱${attribution ? ` ${attribution}` : ""} ${singleLine(notice.text)}`,
			);
		});
		return new Text(lines.join("\n"), 1, 0).render(width);
	}
}

interface CachedItemRender {
	readonly deps: readonly unknown[];
	readonly width: number;
	readonly lines: string[];
}

export class ChatView implements Component {
	private readonly state: TuiApplicationState;
	private readonly itemCache = new Map<string, CachedItemRender>();
	private cachedAgentId?: string;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		if (!agent) {
			return new Text(colors.dim("Preparing the first agent…"), 1, 1).render(
				width,
			);
		}
		if (agent.agentId !== this.cachedAgentId) {
			this.itemCache.clear();
			this.cachedAgentId = agent.agentId;
		}
		if (agent.timeline.length === 0) {
			const message =
				agent.status === "unavailable"
					? "This agent is unavailable. Review its diagnostics below."
					: "Ask WIDI to inspect, explain, or change this workspace.";
			return new Text(colors.dim(message), 1, 1).render(width);
		}

		const liveThinkingIds = new Set<string>();
		for (const item of agent.timeline) {
			if (item.type === "thinking-status" && item.status === "thinking") {
				liveThinkingIds.add(item.id);
			}
		}

		const lines: string[] = [];
		const seen = new Set<string>();
		for (const item of agent.timeline) {
			const key = `${item.type}:${item.id}`;
			seen.add(key);
			const rendered = this.renderItem(item, width, liveThinkingIds, key);
			if (rendered.length === 0) continue;
			if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
			lines.push(...rendered);
		}
		for (const key of this.itemCache.keys()) {
			if (!seen.has(key)) this.itemCache.delete(key);
		}
		return lines;
	}

	/**
	 * Timeline items keep a stable identity, so historical Markdown parsing and
	 * wrapping only reruns when an item's render-relevant facts change.
	 */
	private renderItem(
		item: TimelineItem,
		width: number,
		liveThinkingIds: ReadonlySet<string>,
		key: string,
	): string[] {
		const deps = renderDeps(item, liveThinkingIds);
		const cached = this.itemCache.get(key);
		if (cached && cached.width === width && sameDeps(cached.deps, deps)) {
			return cached.lines;
		}
		const lines = fixCjkLineStarts(
			renderTimelineItem(item, width, liveThinkingIds),
			width,
		);
		this.itemCache.set(key, { deps, width, lines });
		return lines;
	}
}

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
		if (agent?.queue.steer) leftParts.push(`${agent.queue.steer} steer`);
		if (agent?.queue.followUp) {
			leftParts.push(`${agent.queue.followUp} follow-up`);
		}
		if (agent?.unreadCount) leftParts.push(`${agent.unreadCount} unread`);
		leftParts.push("← agents");
		const left = colors.dim(leftParts.join(" · "));
		const thinkingLevel = agent?.display.thinkingLevel;
		const right = thinkingLevel
			? colors.dim(`thinking ${singleLine(thinkingLevel, 40)}`)
			: "";
		return [alignSides(left, right, width)];
	}
}

export class AgentStripView implements Component {
	private readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agents = orderedVisibleAgents(this.state);
		if (agents.length === 0) return [];
		const active = agents[0];
		if (width < 72 && active) {
			const running = agents.filter(
				(agent) => agent.status === "running",
			).length;
			const attention = agents.filter(
				(agent) => agent.attention !== "none",
			).length;
			const summary = [
				formatAgent(active, true),
				running > 0 && `${running} running`,
				attention > 0 && `${attention} attention`,
			]
				.filter(Boolean)
				.join(colors.dim(" · "));
			return [truncateToWidth(summary, width, "…")];
		}

		const parts: string[] = [];
		let hidden = 0;
		for (const [index, agent] of agents.entries()) {
			const next = formatAgent(agent, index === 0);
			const suffix = index === 0 ? "" : "    ";
			const candidate = `${parts.join("    ")}${parts.length ? "    " : ""}${next}`;
			const reserve = agents.length - index - 1 > 0 ? 6 : 0;
			if (visibleWidth(candidate) + reserve > width) {
				hidden = agents.length - index;
				break;
			}
			parts.push(`${next}${suffix}`.trimEnd());
		}
		let line = parts.join("    ");
		if (hidden > 0) {
			line = `${truncateToWidth(line, Math.max(1, width - 5), "")} ${colors.dim(
				`+${hidden}`,
			)}`;
		}
		return [truncateToWidth(line, width, "")];
	}
}

export function agentLabel(agent: AgentViewState): string {
	return singleLine(
		agent.display.sessionName ??
			agent.snapshot?.profile.reference.label ??
			agent.snapshot?.profile.reference.id ??
			agent.agentId,
		80,
	);
}

function renderDeps(
	item: TimelineItem,
	liveThinkingIds: ReadonlySet<string>,
): readonly unknown[] {
	switch (item.type) {
		case "user-message":
			return [item.text];
		case "assistant-message":
			return [
				item.text,
				item.streaming,
				liveThinkingIds.has(`${item.id}:thinking`),
			];
		case "tool-execution":
			return [
				item.status,
				item.isError,
				item.toolName,
				item.args,
				item.partialResult,
				item.result,
			];
		case "thinking-status":
			return [item.status];
		case "command-result":
			return [item.status, item.command, item.result, item.diagnostic];
		default:
			return [];
	}
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

function renderTimelineItem(
	item: TimelineItem,
	width: number,
	liveThinkingIds: ReadonlySet<string>,
): string[] {
	switch (item.type) {
		case "user-message":
			return new Text(
				`${colors.bold("❯")} ${boundedText(item.text)}`,
				1,
				0,
			).render(width);
		case "assistant-message": {
			const text = item.text.trim();
			if (!text) {
				// A live thinking-status item already shows the indicator; render
				// nothing here so "Thinking…" never appears twice.
				if (item.streaming && !liveThinkingIds.has(`${item.id}:thinking`)) {
					return new Text(colors.dim("✻ Thinking…"), 1, 0).render(width);
				}
				return [];
			}
			return new Markdown(
				boundedText(text, { maxLines: 200, maxCharacters: 30_000 }),
				1,
				0,
				markdownTheme,
			).render(width);
		}
		case "thinking-status":
			return item.status === "thinking"
				? new Text(colors.dim("✻ Thinking…"), 1, 0).render(width)
				: [];
		case "tool-execution":
			return new Text(
				presentToolExecution(item, Math.max(8, width - 2)).join("\n"),
				1,
				0,
			).render(width);
		case "diagnostic": {
			const color = severityColor(item.diagnostic.severity);
			return new Text(
				`${color(
					`${diagnosticGlyph(item.diagnostic)} ${item.diagnostic.code}`,
				)}\n${boundedText(item.diagnostic.message)}`,
				1,
				0,
			).render(width);
		}
		case "command-result":
			if (item.status === "detected" || item.status === "accepted") return [];
			// Core publishes the same command failure as a canonical diagnostic
			// immediately after command_failed/rejected. The diagnostic item is
			// the single user-visible failure presentation.
			if (item.diagnostic) return [];
			if (item.result === undefined) return [];
			return new Text(
				`${colors.dim(`/${item.command?.name ?? "command"}`)}\n${formatUnknown(
					item.result,
				)}`,
				1,
				0,
			).render(width);
		case "extension-output":
			return new Text(
				`${colors.dim(`[${item.extensionId}]`)} ${boundedText(item.text, {
					maxLines: 16,
					maxCharacters: 4_000,
				})}`,
				1,
				0,
			).render(width);
		case "extension-message": {
			const title = item.message.title
				? colors.accent(singleLine(item.message.title, 400))
				: colors.dim(`[${item.extensionId}]`);
			const meta = colors.dim(
				`persistent · ${item.extensionId} · ${item.message.kind}`,
			);
			return new Text(
				`${title}  ${meta}\n\n${boundedText(item.message.content, {
					maxLines: 24,
					maxCharacters: 8_000,
				})}`,
				1,
				0,
			).render(width);
		}
		case "human-request-trace": {
			const answer =
				item.answer.kind === "confirm"
					? item.answer.confirmed
						? "Yes"
						: "No"
					: item.answer.kind === "selected-option"
						? item.answer.value
						: "Answered";
			return new Text(
				colors.dim(`❯ ${singleLine(item.title, 400)} → `) +
					singleLine(answer, 400),
				1,
				0,
			).render(width);
		}
		case "application-notice":
			return new Text(
				colors.dim(
					`✱ ${boundedText(item.text, { maxLines: 4, maxCharacters: 600 })}`,
				),
				1,
				0,
			).render(width);
		case "session-marker":
			return new Text(
				colors.dim(
					`── ${item.marker === "compaction" ? "Compacted session" : "Branch summary"} ──\n${boundedText(
						item.summary,
						{
							maxLines: 12,
							maxCharacters: 3_000,
						},
					)}`,
				),
				1,
				0,
			).render(width);
	}
}

function activeAgent(state: TuiApplicationState): AgentViewState | undefined {
	return state.activeAgentId
		? state.agents.get(state.activeAgentId)
		: undefined;
}

function orderedVisibleAgents(state: TuiApplicationState): AgentViewState[] {
	return [...state.agents.values()]
		.filter((agent) => agent.status !== "disposed")
		.sort((left, right) => {
			if (left.agentId === state.activeAgentId) return -1;
			if (right.agentId === state.activeAgentId) return 1;
			return attentionRank(right.attention) - attentionRank(left.attention);
		});
}

function formatAgent(agent: AgentViewState, active: boolean): string {
	const glyph =
		agent.status === "unavailable" || agent.attention === "error"
			? colors.red("!")
			: agent.attention === "human-request" || agent.attention === "warning"
				? colors.yellow("!")
				: agent.status === "running"
					? colors.cyan("●")
					: colors.green("●");
	const label = active ? colors.bold(agentLabel(agent)) : agentLabel(agent);
	const detail =
		agent.attention === "human-request"
			? "needs input"
			: agent.unreadCount > 0
				? `${agent.status} · ${agent.unreadCount} unread`
				: agent.status;
	return `${glyph} ${label} ${colors.dim(detail)}`;
}

function attentionRank(attention: AgentViewState["attention"]): number {
	return {
		none: 0,
		completed: 1,
		warning: 2,
		"human-request": 3,
		error: 4,
	}[attention];
}

function diagnosticGlyph(diagnostic: OrchestratorDiagnostic): string {
	switch (diagnostic.severity) {
		case "error":
			return "✕";
		case "warning":
			return "▲";
		default:
			return "●";
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
