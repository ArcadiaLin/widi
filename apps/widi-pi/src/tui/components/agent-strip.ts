import {
	type Component,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { agentIdentityLabel } from "../agent-identity.ts";
import { buildAgentTree, flattenAgentTree } from "../agent-tree.ts";
import type { AgentViewState, TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";

const TREE_INDENT = 4;

export class AgentStripView implements Component {
	private readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const tree = buildAgentTree(this.state);
		if (tree.topLevel.length === 0) return [];

		if (width < 72) {
			const agents = flattenAgentTree(tree).map((entry) => entry.agent);
			const activeAgent = this.state.activeAgentId
				? this.state.agents.get(this.state.activeAgentId)
				: undefined;
			const focused =
				activeAgent && activeAgent.status !== "disposed"
					? activeAgent
					: tree.topLevel[0];
			const running = agents.filter(
				(agent) => agent.status === "running",
			).length;
			const attention = agents.filter(
				(agent) => agent.attention !== "none",
			).length;
			const backgroundJobs = agents.reduce(
				(sum, agent) => sum + agent.backgroundJobCount,
				0,
			);
			const summary = [
				formatAgent(
					this.state,
					focused,
					focused.agentId === this.state.activeAgentId,
				),
				running > 0 && `${running} running`,
				attention > 0 && `${attention} attention`,
				backgroundJobs > 0 && `${backgroundJobs} bg`,
			]
				.filter(Boolean)
				.join(theme.dim(" · "));
			return [truncateToWidth(summary, width, "…")];
		}

		// Top row: top-level agents side by side in insertion order; the active
		// agent is marked by its glyph, not by sorting first. `columns` records
		// each agent's start column so child tree lines can align under it.
		const parts: string[] = [];
		const columns = new Map<string, number>();
		let lineWidth = 0;
		let hidden = 0;
		for (const [index, agent] of tree.topLevel.entries()) {
			const next = formatAgent(
				this.state,
				agent,
				agent.agentId === this.state.activeAgentId,
			);
			const start = parts.length === 0 ? 0 : lineWidth + 4;
			const end = start + visibleWidth(next);
			const reserve = tree.topLevel.length - index - 1 > 0 ? 6 : 0;
			if (end + reserve > width) {
				hidden = tree.topLevel.length - index;
				break;
			}
			columns.set(agent.agentId, start);
			parts.push(next);
			lineWidth = end;
		}
		let line = parts.join("    ");
		if (hidden > 0) {
			line = `${truncateToWidth(line, Math.max(1, width - 5), "")} ${theme.dim(
				`+${hidden}`,
			)}`;
		}
		const lines = [truncateToWidth(line, width, "")];

		// Child rows: each top-level agent's subtree hangs below the row,
		// tree lines aligned to the parent's column (deeper generations get a
		// fixed extra indent per level).
		let currentTopColumn: number | undefined;
		for (const entry of flattenAgentTree(tree)) {
			if (entry.depth === 0) {
				currentTopColumn = columns.get(entry.agent.agentId);
				continue;
			}
			// The subtree of a top-level agent hidden behind "+N" is not drawn.
			if (currentTopColumn === undefined) continue;
			const indent = currentTopColumn + (entry.depth - 1) * TREE_INDENT;
			const branch = theme.dim(entry.last ? "└──" : "├──");
			const text = `${" ".repeat(indent)}${branch} ${formatAgent(
				this.state,
				entry.agent,
				entry.agent.agentId === this.state.activeAgentId,
			)}`;
			lines.push(truncateToWidth(text, width, "…"));
		}
		return lines;
	}
}

function formatAgent(
	state: TuiApplicationState,
	agent: AgentViewState,
	active: boolean,
): string {
	const label = agentIdentityLabel(state, agent);
	const base =
		agent.attention === "human-request"
			? "needs input"
			: agent.unreadCount > 0
				? `${agent.status} · ${agent.unreadCount} unread`
				: agent.status;
	const detail =
		agent.backgroundJobCount > 0
			? `${base} · ${agent.backgroundJobCount} bg`
			: base;
	return `${agentGlyph(agent, active)} ${active ? theme.bold(label) : label} ${theme.dim(detail)}`;
}

function agentGlyph(agent: AgentViewState, active: boolean): string {
	if (agent.status === "unavailable" || agent.attention === "error") {
		return theme.error("!");
	}
	if (agent.attention === "human-request" || agent.attention === "warning") {
		return theme.warn("!");
	}
	const paint = agent.status === "running" ? theme.info : theme.ok;
	return paint(active ? "●" : "○");
}
