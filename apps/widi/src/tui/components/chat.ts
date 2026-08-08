import { type Component, Text } from "@earendil-works/pi-tui";
import { fixCjkLineStarts } from "../cjk-wrap.ts";
import type { TimelineItem, ToolExecutionItem, TuiApplicationState } from "../state.ts";
import { theme, themeGeneration } from "../theme/theme.ts";
import { lookupToolPresenter, presentToolExecution, type ToolRowComponent } from "../tool-presenter.ts";
import { activeAgent } from "./common.ts";
import { renderDeps, renderTimelineItem, type TimelineRenderContext } from "./timeline-item.ts";

interface CachedItemRender {
	readonly deps: readonly unknown[];
	readonly width: number;
	readonly lines: string[];
}

/**
 * One live component-presenter row (parity §4.3-2, component form). The
 * instance outlives individual renders: a changed item is fed through
 * update() instead of rebuilding the component, while the rendered lines
 * still ride the same deps cache as every other item.
 */
interface ToolRowEntry {
	readonly component: ToolRowComponent;
	item: ToolExecutionItem;
	expanded: boolean;
	cached?: CachedItemRender;
}

export class ChatView implements Component {
	private readonly state: TuiApplicationState;
	private readonly itemCache = new Map<string, CachedItemRender>();
	/** Component-presenter instances by toolCallId. */
	private readonly toolRows = new Map<string, ToolRowEntry>();
	private cachedAgentId?: string;
	private cachedThemeGeneration?: number;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		// renderDeps cannot see a theme switch (the paints change underneath an
		// unchanged item), so the generation guards the whole cache instead.
		const generation = themeGeneration();
		if (generation !== this.cachedThemeGeneration) {
			this.itemCache.clear();
			this.clearToolRowCaches();
			this.cachedThemeGeneration = generation;
		}
		const agent = activeAgent(this.state);
		const pending = this.state.pendingAgent;
		if (!agent && !pending) {
			return new Text(theme.dim("Preparing the first agent…"), 1, 1).render(width);
		}
		const timeline = agent?.timeline ?? pending?.timeline ?? [];
		const viewId = agent?.agentId ?? "pending";
		if (viewId !== this.cachedAgentId) {
			this.itemCache.clear();
			this.disposeToolRows();
			this.cachedAgentId = viewId;
		}

		const liveThinkingIds = new Set<string>();
		const livePreparingAssistantIds = new Set<string>();
		const seenToolCallIds = new Set<string>();
		for (const item of timeline) {
			if (item.type === "thinking-status" && item.status === "thinking") {
				liveThinkingIds.add(item.id);
			} else if (item.type === "tool-execution") {
				if (item.status === "preparing" && item.sourceAssistantId) {
					livePreparingAssistantIds.add(item.sourceAssistantId);
				}
				seenToolCallIds.add(item.toolCallId);
			}
		}
		// Windowing (or any trim) dropped the row: dispose the live instance.
		// This runs before the empty-timeline early return on purpose.
		for (const [toolCallId, entry] of this.toolRows) {
			if (!seenToolCallIds.has(toolCallId)) {
				entry.component.dispose?.();
				this.toolRows.delete(toolCallId);
			}
		}
		if (timeline.length === 0) {
			return new Text(theme.dim("Ask WIDI to inspect, explain, or change this workspace."), 1, 1).render(width);
		}
		const context: TimelineRenderContext = {
			liveThinkingIds,
			livePreparingAssistantIds,
			toolOutputExpanded: this.state.toolOutputExpanded,
		};

		const lines: string[] = [];
		const seen = new Set<string>();
		for (const item of timeline) {
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
	private renderItem(item: TimelineItem, width: number, context: TimelineRenderContext, key: string): string[] {
		if (item.type === "tool-execution") {
			const presenter = lookupToolPresenter(item.toolName);
			if (presenter?.kind === "component") {
				return this.renderToolRow(item, presenter.factory, width, context, key);
			}
		}
		const deps = renderDeps(item, context);
		const cached = this.itemCache.get(key);
		if (cached && cached.width === width && sameDeps(cached.deps, deps)) {
			return cached.lines;
		}
		const lines = fixCjkLineStarts(renderTimelineItem(item, width, context), width);
		this.itemCache.set(key, { deps, width, lines });
		return lines;
	}

	/**
	 * The component presenter path: one instance per toolCallId, updated in
	 * place as the item changes, rendered through the same deps cache as the
	 * pure items. A factory or render that throws degrades to the generic
	 * lines fallback for that frame.
	 */
	private renderToolRow(
		item: ToolExecutionItem,
		factory: (item: ToolExecutionItem, context: { expanded: boolean }) => ToolRowComponent,
		width: number,
		context: TimelineRenderContext,
		key: string,
	): string[] {
		const expanded = item.expanded ?? context.toolOutputExpanded;
		let entry = this.toolRows.get(item.toolCallId);
		if (!entry) {
			let component: ToolRowComponent;
			try {
				component = factory(item, { expanded });
			} catch {
				return this.renderToolRowFallback(item, width, expanded, context, key);
			}
			entry = { component, item, expanded };
			this.toolRows.set(item.toolCallId, entry);
		} else if (entry.item !== item || entry.expanded !== expanded) {
			entry.component.update?.(item, { expanded });
			entry.item = item;
			entry.expanded = expanded;
		}

		const deps = renderDeps(item, context);
		const cached = entry.cached;
		if (cached && cached.width === width && sameDeps(cached.deps, deps)) {
			return cached.lines;
		}
		let lines: string[];
		try {
			lines = entry.component.render(width);
		} catch {
			return this.renderToolRowFallback(item, width, expanded, context, key);
		}
		entry.cached = { deps, width, lines: fixCjkLineStarts(lines, width) };
		return entry.cached.lines;
	}

	/** The generic lines rendering, cached like any pure item. */
	private renderToolRowFallback(
		item: ToolExecutionItem,
		width: number,
		expanded: boolean,
		context: TimelineRenderContext,
		key: string,
	): string[] {
		const deps = renderDeps(item, context);
		const cached = this.itemCache.get(key);
		if (cached && cached.width === width && sameDeps(cached.deps, deps)) {
			return cached.lines;
		}
		const lines = fixCjkLineStarts(presentToolExecution(item, width, { expanded }), width);
		this.itemCache.set(key, { deps, width, lines });
		return lines;
	}

	/** Drop the line caches but keep the live component instances. */
	private clearToolRowCaches(): void {
		for (const entry of this.toolRows.values()) entry.cached = undefined;
	}

	private disposeToolRows(): void {
		for (const entry of this.toolRows.values()) entry.component.dispose?.();
		this.toolRows.clear();
	}
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}
