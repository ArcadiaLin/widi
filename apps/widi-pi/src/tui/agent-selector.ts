import { agentIdentityLabel } from "./agent-identity.ts";
import type { CompletionMenu } from "./completion-menu.ts";
import { formatRelativeAge, singleLine } from "./format.ts";
import type { AgentViewState, TuiApplicationState } from "./state.ts";

export class AgentSelectorController {
	private readonly menu: CompletionMenu;
	private readonly state: TuiApplicationState;
	private readonly onSelectAgent: (agentId: string) => void;

	constructor(
		menu: CompletionMenu,
		state: TuiApplicationState,
		onSelectAgent: (agentId: string) => void,
	) {
		this.menu = menu;
		this.state = state;
		this.onSelectAgent = onSelectAgent;
	}

	get isOpen(): boolean {
		return this.menu.isOpen;
	}

	open(): void {
		if (this.menu.isOpen) return;
		const agents = [...this.state.agents.values()].filter(
			(agent) => agent.status !== "disposed",
		);
		if (agents.length === 0) return;
		const activeIndex = agents.findIndex(
			(agent) => agent.agentId === this.state.activeAgentId,
		);
		this.menu.open({
			title: "Select agent",
			items: agents.map((agent) => ({
				value: agent.agentId,
				label: agentIdentityLabel(this.state, agent),
				description: [
					describeAgent(agent, agent.agentId === this.state.activeAgentId),
					`id ${singleLine(agent.agentId, agent.agentId.length)}`,
				].join(" · "),
			})),
			initialIndex: activeIndex >= 0 ? activeIndex : undefined,
			operation: {
				description: "Switch the active runtime agent.",
				confirmVerb: "switch",
			},
			onSelect: (item) => this.onSelectAgent(item.value),
		});
	}

	close(): void {
		this.menu.close();
	}
}

function describeAgent(agent: AgentViewState, active: boolean): string {
	const model =
		agent.display.model?.id ?? agent.snapshot?.model.id ?? "unknown";
	const facts = [statusFact(agent), singleLine(model, 120)];
	if (active) facts.push("current");
	if (agent.unreadCount) facts.push(`${agent.unreadCount} unread`);
	const reason = attentionReason(agent);
	if (reason) facts.push(reason);
	return facts.join(" · ");
}

function statusFact(agent: AgentViewState): string {
	if (agent.status === "running" && agent.runStartedAt) {
		const elapsedMs = Date.now() - Date.parse(agent.runStartedAt);
		if (Number.isFinite(elapsedMs)) {
			return `running ${formatRelativeAge(elapsedMs)}`;
		}
	}
	return agent.status;
}

/** Human-readable attention reason instead of the bare enum value. */
function attentionReason(agent: AgentViewState): string | undefined {
	switch (agent.attention) {
		case "human-request":
			return "needs input";
		case "error":
			return agent.status === "unavailable" ? undefined : "error reported";
		case "warning":
			return "warning reported";
		case "completed":
			return "finished in background";
		default:
			return undefined;
	}
}
