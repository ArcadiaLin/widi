import type { CompletionMenu } from "./completion-menu.ts";
import { agentLabel } from "./components/common.ts";
import { singleLine } from "./format.ts";
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
				label: agentLabel(agent),
				description: describeAgent(agent),
			})),
			initialIndex: activeIndex >= 0 ? activeIndex : undefined,
			hint: "↑↓ select · enter switch · esc close · type to filter",
			onSelect: (item) => this.onSelectAgent(item.value),
		});
	}

	close(): void {
		this.menu.close();
	}
}

function describeAgent(agent: AgentViewState): string {
	const model =
		agent.display.model?.id ?? agent.snapshot?.model.id ?? "unknown";
	const facts = [agent.status, singleLine(model, 120)];
	if (agent.unreadCount) facts.push(`${agent.unreadCount} unread`);
	if (agent.attention !== "none") facts.push(agent.attention);
	return facts.join(" · ");
}
