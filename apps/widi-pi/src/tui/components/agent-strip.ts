import {
	type Component,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { agentIdentityLabel } from "../agent-identity.ts";
import type { AgentViewState, TuiApplicationState } from "../state.ts";
import { colors } from "../theme/colors.ts";

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
				formatAgent(this.state, active, true),
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
			const next = formatAgent(this.state, agent, index === 0);
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

function orderedVisibleAgents(state: TuiApplicationState): AgentViewState[] {
	return [...state.agents.values()]
		.filter((agent) => agent.status !== "disposed")
		.sort((left, right) => {
			if (left.agentId === state.activeAgentId) return -1;
			if (right.agentId === state.activeAgentId) return 1;
			return attentionRank(right.attention) - attentionRank(left.attention);
		});
}

function formatAgent(
	state: TuiApplicationState,
	agent: AgentViewState,
	active: boolean,
): string {
	const glyph =
		agent.status === "unavailable" || agent.attention === "error"
			? colors.error("!")
			: agent.attention === "human-request" || agent.attention === "warning"
				? colors.warn("!")
				: agent.status === "running"
					? colors.info("●")
					: colors.ok("●");
	const label = agentIdentityLabel(state, agent);
	const detail =
		agent.attention === "human-request"
			? "needs input"
			: agent.unreadCount > 0
				? `${agent.status} · ${agent.unreadCount} unread`
				: agent.status;
	return `${glyph} ${active ? colors.bold(label) : label} ${colors.dim(detail)}`;
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
