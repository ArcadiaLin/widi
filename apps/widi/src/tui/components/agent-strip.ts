import {
	type Component,
	getKeybindings,
	type KeybindingsManager,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { agentIdentityLabel } from "../agent-identity.ts";
import { type AgentTree, type AgentTreeEntry, buildAgentTree, flattenAgentTree } from "../agent-tree.ts";
import type { AgentViewState, TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";
import { extensionStatusesInRegion, maintenanceLabel, tonePaint } from "./common.ts";

const TREE_INDENT = 4;
/** Visible width of `├── ` / `└── `. */
const TREE_PREFIX_WIDTH = 4;
const COLUMN_GAP = 4;
/** Smallest top-row label: glyph, a space, and an ellipsis. */
const MIN_LABEL_WIDTH = 3;

export interface AgentPanelHost {
	setFocus(component: Component | null): void;
	requestRender(): void;
}

export type AgentPanelNavigation = "up" | "down" | "left" | "right";

const NOOP_HOST: AgentPanelHost = { setFocus: () => {}, requestRender: () => {} };

/**
 * Bottom agent panel. Unfocused it is a read-only strip: top-level agents sit
 * side by side on the first row with their subtrees hanging below, labels are
 * truncated per agent to fit the terminal width, and agents that still do not
 * fit are counted on the left edge (`+N`). Focused (down arrow from an empty
 * editor) it becomes the agent switcher: a cursor moves over the same
 * position layout with the arrow keys, the visible window always holds as
 * many agents as possible while keeping the cursor on screen (`‹N`/`N›`
 * count the hidden sides), enter switches, and escape or up from the top row
 * returns to the editor.
 */
export class AgentStripView implements Component {
	focused = false;
	private readonly state: TuiApplicationState;
	private readonly host: AgentPanelHost;
	private readonly onSelectAgent: (agentId: string) => void;
	private readonly onClose: () => void;
	private cursorAgentId?: string;

	constructor(
		state: TuiApplicationState,
		host: AgentPanelHost = NOOP_HOST,
		onSelectAgent: (agentId: string) => void = () => {},
		onClose: () => void = () => {},
	) {
		this.state = state;
		this.host = host;
		this.onSelectAgent = onSelectAgent;
		this.onClose = onClose;
	}

	/** Agent id under the cursor while the panel is focused. */
	get cursor(): string | undefined {
		return this.cursorAgentId;
	}

	invalidate(): void {}

	/** Focus the panel with the cursor on the active agent. No-op without agents. */
	open(): void {
		const tree = buildAgentTree(this.state);
		const entries = flattenAgentTree(tree);
		this.cursorAgentId = undefined;
		if (!this.ensureCursor(entries) || !this.cursorAgentId) return;
		this.state.mode = "agent-panel";
		this.host.setFocus(this);
		this.host.requestRender();
	}

	close(): void {
		if (!this.focused && this.state.mode !== "agent-panel") return;
		if (this.state.mode === "agent-panel") this.state.mode = "editor";
		this.onClose();
	}

	handleInput(data: string): void {
		if (!this.focused) return;
		const tree = buildAgentTree(this.state);
		const entries = flattenAgentTree(tree);
		if (!this.ensureCursor(entries) || !this.cursorAgentId) {
			this.close();
			return;
		}
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.onSelectAgent(this.cursorAgentId);
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.close();
			return;
		}
		const navigation = matchNavigation(keybindings, data);
		if (!navigation) return;
		const next = moveAgentCursor(tree, this.cursorAgentId, navigation);
		if (next === undefined) {
			// Up from the top row: the panel sits below the editor, so the
			// position-consistent way out is back up into it.
			this.close();
			return;
		}
		this.cursorAgentId = next;
		this.host.requestRender();
	}

	render(width: number): string[] {
		const tree = buildAgentTree(this.state);
		const entries = flattenAgentTree(tree);
		if (entries.length === 0) {
			// Nothing left to navigate; hand focus back instead of trapping the
			// user. Deferred because render itself must stay side-effect free.
			if (this.focused) queueMicrotask(() => this.close());
			return [];
		}
		this.ensureCursor(entries);
		const top = this.layoutTopRow(tree, width);
		const lines = [top.line];

		// Child rows: every visible top-level agent's subtree hangs directly
		// beneath it, row-aligned across columns — line N holds the N-th subtree
		// row of every column at once, so a taller sibling column never pushes
		// another column's tree away from its parent.
		const columns = tree.topLevel
			.filter((agent) => top.columns.has(agent.agentId))
			.map((agent) => ({
				start: top.columns.get(agent.agentId) ?? 0,
				rows: flattenAgentTree({ topLevel: [agent], childrenOf: tree.childrenOf })
					.filter((entry) => entry.depth > 0)
					.map((entry) => {
						const selected = this.focused && entry.agent.agentId === this.cursorAgentId;
						const agentContent = formatAgent(
							this.state,
							entry.agent,
							entry.agent.agentId === this.state.activeAgentId,
							selected,
						);
						return {
							depth: entry.depth,
							selected,
							agentContent,
							content: `${theme.dim(entry.last ? "└──" : "├──")} ${agentContent}`,
						};
					}),
			}));
		const height = Math.max(0, ...columns.map((column) => column.rows.length));
		for (let row = 0; row < height; row++) {
			let line = "";
			for (const [index, column] of columns.entries()) {
				const entry = column.rows[row];
				if (!entry) continue;
				// The segment ends where the next column with a row at this height
				// begins, so a long label never overprints a neighbor's tree.
				let limit = width;
				for (let next = index + 1; next < columns.length; next++) {
					if (columns[next].rows[row]) {
						limit = columns[next].start;
						break;
					}
				}
				const desiredIndent = column.start + (entry.depth - 1) * TREE_INDENT;
				// Deep indentation can consume a narrow column completely. Keep
				// the selected agent visible by dropping its tree prefix and using
				// the whole column segment as a compact fallback.
				const compactSelected = entry.selected && limit - desiredIndent < TREE_PREFIX_WIDTH + MIN_LABEL_WIDTH;
				const indent = compactSelected ? column.start : desiredIndent;
				if (indent >= limit) continue;
				const padding = indent - visibleWidth(line);
				if (padding < 0) continue;
				line += `${" ".repeat(padding)}${truncateToWidth(
					compactSelected ? entry.agentContent : entry.content,
					Math.max(1, limit - indent),
					"…",
				)}`;
			}
			lines.push(truncateToWidth(line, width, "…"));
		}
		return lines;
	}

	/**
	 * Keep the cursor on an existing entry: after a dispose the cursor falls
	 * back to the active agent, then to the first visible one. Returns false
	 * when no agents remain.
	 */
	private ensureCursor(entries: readonly AgentTreeEntry[]): boolean {
		if (entries.length === 0) {
			this.cursorAgentId = undefined;
			return false;
		}
		if (entries.some((entry) => entry.agent.agentId === this.cursorAgentId)) {
			return true;
		}
		const active = this.state.activeAgentId;
		this.cursorAgentId = entries.some((entry) => entry.agent.agentId === active) ? active : entries[0].agent.agentId;
		return true;
	}

	private layoutTopRow(tree: AgentTree, width: number): { line: string; columns: Map<string, number> } {
		const topLevel = tree.topLevel;
		const labels = topLevel.map((agent) =>
			formatAgent(
				this.state,
				agent,
				agent.agentId === this.state.activeAgentId,
				this.focused && agent.agentId === this.cursorAgentId,
			),
		);
		const cursorTop = this.focused ? topLevelColumnIndex(tree, this.cursorAgentId) : -1;
		// The window is recomputed per render: anchored as far left as possible
		// while containing the cursor, so widening the terminal or moving the
		// cursor back left always reveals more agents instead of sticking to a
		// previously scrolled position.
		let start = 0;
		while (start < topLevel.length) {
			// Each window position retries the full tail: the fit must contain the
			// cursor, not just whatever happened to remain from the last attempt.
			let end = topLevel.length;
			while (end > start) {
				const layout = this.tryFitTopRow(topLevel, labels, start, end, width);
				if (layout) {
					if (!this.focused || (cursorTop >= start && cursorTop < end)) {
						return layout;
					}
					// The cursor fell off the right edge: slide the window right.
					break;
				}
				end--;
			}
			start++;
		}
		// Degenerate width: the cursor (or first) agent alone, hard-truncated.
		const index = cursorTop >= 0 ? cursorTop : 0;
		const line = truncateToWidth(labels[index] ?? "", Math.max(1, width), "…");
		return { line, columns: new Map([[topLevel[index].agentId, 0]]) };
	}

	/**
	 * Lay out top-level agents [start, end) within the width, shrinking the
	 * longest label one column at a time so as many agents as possible stay
	 * visible. Returns undefined when even the minimum-width labels overflow.
	 */
	private tryFitTopRow(
		topLevel: readonly AgentViewState[],
		labels: readonly string[],
		start: number,
		end: number,
		width: number,
	): { line: string; columns: Map<string, number> } | undefined {
		const rightHidden = topLevel.length - end;
		const leftIndicator =
			start > 0 ? theme.dim(`‹${start} `) : !this.focused && rightHidden > 0 ? theme.dim(`+${rightHidden} `) : "";
		const rightIndicator = this.focused && rightHidden > 0 ? theme.dim(` ${rightHidden}›`) : "";
		const available = width - visibleWidth(leftIndicator) - visibleWidth(rightIndicator);
		const widths = labels.slice(start, end).map((label) => visibleWidth(label));
		const truncated = labels.slice(start, end);
		const gaps = (truncated.length - 1) * COLUMN_GAP;
		const total = () => widths.reduce((sum, value) => sum + value, 0) + gaps;
		while (total() > available) {
			let longest = 0;
			for (const [index, value] of widths.entries()) {
				if (value > widths[longest]) longest = index;
			}
			if (widths[longest] <= MIN_LABEL_WIDTH) return undefined;
			widths[longest]--;
			truncated[longest] = truncateToWidth(labels[start + longest], widths[longest], "…");
		}
		const columns = new Map<string, number>();
		let column = visibleWidth(leftIndicator);
		for (const [index, value] of widths.entries()) {
			columns.set(topLevel[start + index].agentId, column);
			column += value + COLUMN_GAP;
		}
		const line = `${leftIndicator}${truncated.join(" ".repeat(COLUMN_GAP))}${rightIndicator}`;
		return { line: truncateToWidth(line, width, ""), columns };
	}
}

/**
 * Position-based cursor movement over the flattened tree. Returns the next
 * cursor agent id, the current id when the move hits an edge, or undefined
 * when "up" leaves the panel from the top row. Horizontal moves hop between
 * top-level columns; a cursor sitting in a subtree first returns to its
 * column's top row.
 */
export function moveAgentCursor(
	tree: AgentTree,
	cursorId: string,
	navigation: AgentPanelNavigation,
): string | undefined {
	const entries = flattenAgentTree(tree);
	const index = entries.findIndex((entry) => entry.agent.agentId === cursorId);
	if (index < 0) return entries[0]?.agent.agentId;
	const entry = entries[index];
	switch (navigation) {
		case "up":
			return entry.depth === 0 ? undefined : entries[index - 1].agent.agentId;
		case "down": {
			// Preorder flattening keeps a column's subtree contiguous: the next
			// entry belongs to this column exactly when it is not top-level.
			const next = entries[index + 1];
			return next && next.depth > 0 ? next.agent.agentId : cursorId;
		}
		case "left":
		case "right": {
			const column = topLevelColumnIndex(tree, cursorId);
			const target = column + (navigation === "left" ? -1 : 1);
			const agent = tree.topLevel[target];
			return agent ? agent.agentId : cursorId;
		}
	}
}

/**
 * Index of the top-level column an agent belongs to: itself when it is
 * top-level, its nearest ancestor above it in the flattened tree otherwise.
 * -1 when the agent is not in the tree.
 */
function topLevelColumnIndex(tree: AgentTree, agentId: string | undefined): number {
	const entries = flattenAgentTree(tree);
	const index = entries.findIndex((entry) => entry.agent.agentId === agentId);
	if (index < 0) return -1;
	for (let cursor = index; cursor >= 0; cursor--) {
		if (entries[cursor].depth === 0) {
			return tree.topLevel.findIndex((agent) => agent.agentId === entries[cursor].agent.agentId);
		}
	}
	return -1;
}

function matchNavigation(keybindings: KeybindingsManager, data: string): AgentPanelNavigation | undefined {
	if (keybindings.matches(data, "tui.select.up")) return "up";
	if (keybindings.matches(data, "tui.select.down")) return "down";
	if (keybindings.matches(data, "app.agents.previous")) return "left";
	if (keybindings.matches(data, "app.agents.next")) return "right";
	return undefined;
}

function formatAgent(state: TuiApplicationState, agent: AgentViewState, active: boolean, selected = false): string {
	const label = agentIdentityLabel(state, agent);
	const statusText =
		agent.status === "running" && agent.maintenance ? maintenanceLabel(agent.maintenance).toLowerCase() : agent.status;
	const base =
		agent.attention === "human-request"
			? "needs input"
			: agent.unreadCount > 0
				? `${statusText} · ${agent.unreadCount} unread`
				: statusText;
	const detail = agent.backgroundJobCount > 0 ? `${base} · ${agent.backgroundJobCount} bg` : base;
	// Agent-strip statuses mark the agent item itself: just the icon, painted
	// with its tone, one per publishing extension status.
	const markers = extensionStatusesInRegion(agent, "agent-strip").map((entry) =>
		tonePaint(entry.status.tone)(entry.status.icon ?? "✻"),
	);
	const text = `${agentGlyph(agent, active)} ${active ? theme.bold(label) : label} ${theme.dim(detail)}${
		markers.length > 0 ? ` ${markers.join(" ")}` : ""
	}`;
	return selected ? theme.inverse(text) : text;
}

function agentGlyph(agent: AgentViewState, active: boolean): string {
	if (agent.attention === "error") {
		return theme.error("!");
	}
	if (agent.attention === "human-request" || agent.attention === "warning") {
		return theme.warn("!");
	}
	const paint = agent.status === "running" ? theme.info : theme.ok;
	return paint(active ? "●" : "○");
}
