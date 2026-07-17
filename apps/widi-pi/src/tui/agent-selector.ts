import {
	type Component,
	type OverlayHandle,
	SelectList,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { agentLabel } from "./components/views.ts";
import { singleLine } from "./format.ts";
import type { AgentViewState, TuiApplicationState } from "./state.ts";
import { colors, selectListTheme } from "./theme.ts";

export class AgentSelectorController {
	private overlay?: OverlayHandle;
	private readonly tui: TUI;
	private readonly state: TuiApplicationState;
	private readonly onSelectAgent: (agentId: string) => void;

	constructor(
		tui: TUI,
		state: TuiApplicationState,
		onSelectAgent: (agentId: string) => void,
	) {
		this.tui = tui;
		this.state = state;
		this.onSelectAgent = onSelectAgent;
	}

	get isOpen(): boolean {
		return this.overlay !== undefined;
	}

	open(): void {
		if (this.overlay) return;
		const agents = [...this.state.agents.values()].filter(
			(agent) => agent.status !== "disposed",
		);
		if (agents.length === 0) return;
		const list = new SelectList(
			agents.map((agent) => ({
				value: agent.agentId,
				label: agentLabel(agent),
				description: describeAgent(agent),
			})),
			Math.min(10, agents.length),
			selectListTheme,
			{ minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 32 },
		);
		const activeIndex = agents.findIndex(
			(agent) => agent.agentId === this.state.activeAgentId,
		);
		if (activeIndex >= 0) list.setSelectedIndex(activeIndex);
		const frame = new AgentSelectorFrame(list);
		const close = () => {
			this.overlay?.hide();
			this.overlay = undefined;
			this.state.mode = "editor";
		};
		list.onCancel = close;
		list.onSelect = (item) => {
			close();
			this.onSelectAgent(item.value);
		};
		this.state.mode = "agent-selector";
		this.overlay = this.tui.showOverlay(frame, {
			width: "72%",
			minWidth: 38,
			maxHeight: "70%",
			anchor: "center",
			margin: 1,
		});
	}

	close(): void {
		this.overlay?.hide();
		this.overlay = undefined;
		if (this.state.mode === "agent-selector") this.state.mode = "editor";
	}
}

class AgentSelectorFrame implements Component {
	focused = false;
	private readonly list: SelectList;

	constructor(list: SelectList) {
		this.list = list;
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		const title = colors.accent("Select agent");
		const lines = [
			truncateToWidth(title, width, ""),
			"",
			...this.list.render(width),
			"",
			truncateToWidth(
				colors.dim("↑↓ select · enter switch · esc close"),
				width,
				"",
			),
		];
		return lines;
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
