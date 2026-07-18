import { type Component, Text } from "@earendil-works/pi-tui";
import { fixCjkLineStarts } from "../cjk-wrap.ts";
import type { TimelineItem, TuiApplicationState } from "../state.ts";
import { colors } from "../theme/colors.ts";
import { activeAgent } from "./common.ts";
import {
	renderDeps,
	renderTimelineItem,
	type TimelineRenderContext,
} from "./timeline-item.ts";

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
		const context: TimelineRenderContext = {
			liveThinkingIds,
			toolOutputExpanded: this.state.toolOutputExpanded,
		};

		const lines: string[] = [];
		const seen = new Set<string>();
		for (const item of agent.timeline) {
			const key = `${item.type}:${item.id}`;
			seen.add(key);
			const rendered = this.renderItem(item, width, context, key);
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
		context: TimelineRenderContext,
		key: string,
	): string[] {
		const deps = renderDeps(item, context);
		const cached = this.itemCache.get(key);
		if (cached && cached.width === width && sameDeps(cached.deps, deps)) {
			return cached.lines;
		}
		const lines = fixCjkLineStarts(
			renderTimelineItem(item, width, context),
			width,
		);
		this.itemCache.set(key, { deps, width, lines });
		return lines;
	}
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}
