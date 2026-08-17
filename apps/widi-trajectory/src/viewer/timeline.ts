/**
 * The overview, under three projections of one x axis.
 *
 * Real clock time answers "what was happening at once", and it is the only
 * projection in which a parent sitting idle while three children run is visible
 * at all. It is also the projection in which most of a run disappears: a tool
 * call that took 40ms next to a model request that took 40s is a thousandth of
 * a pixel, so a reader scanning for the shape of a run sees only the model. The
 * other two projections trade the clock away to get those records back:
 *
 * - `sequence` gives every record the same width, so the run reads as the
 *   ordered list of things that happened. Nothing is too short to see. This is
 *   the default because it is the only projection that shows everything.
 * - `elapsed` keeps recorded durations but removes the stretches when nothing
 *   ran, so waiting does not crowd out work.
 * - `clock` is the untouched wall clock.
 *
 * Under `sequence` the order is global across agents, not per lane, so lanes
 * stay comparable: a child's records sit between the parent records they
 * happened between, and concurrency still reads as overlapping lanes.
 *
 * Spans are drawn from recorded times only. A record with no duration is drawn
 * at its minimum width as a mark of when it happened, never stretched to fill
 * the gap after it - an invented duration would be indistinguishable from a
 * measured one.
 *
 * Colour encodes record kind and nothing else, so the same seven colours mean
 * the same seven things in every pane. Agent identity is carried by the lane and
 * its label, which also keeps identity off colour alone.
 */

import type { RecordKind, TrajectoryRecord } from "../model/types.ts";
import { el, replace, svg } from "./dom.ts";
import { formatClock, formatDuration } from "./format.ts";
import { agentLabel, branchEntries, branchOf, type ViewerIndex } from "./model.ts";
import type { Store, TimelineMode } from "./state.ts";

export const KIND_ORDER: readonly RecordKind[] = [
	"user",
	"assistant",
	"thinking",
	"tool",
	"notice",
	"compaction",
	"meta",
];

export const KIND_LABEL: Record<RecordKind, string> = {
	user: "user",
	assistant: "assistant",
	thinking: "thinking",
	tool: "tool",
	notice: "notice",
	compaction: "compaction",
	meta: "meta",
};

export const TIMELINE_MODE_LABEL: Record<TimelineMode, string> = {
	sequence: "steps",
	elapsed: "elapsed",
	clock: "clock",
};

export interface TimeRange {
	readonly start: number;
	readonly end: number;
}

interface Span {
	readonly record: TrajectoryRecord;
	readonly agentKey: string;
	readonly lane: number;
	readonly start: number;
	readonly end: number;
}

interface Lane {
	readonly label: string;
	readonly agentKey?: string;
}

const LANE_HEIGHT = 18;
const LANE_GAP = 4;
const AXIS_HEIGHT = 18;
const LABEL_WIDTH = 132;
const MIN_SPAN_PX = 3;

const AGENT_LANES: readonly { label: string; kinds: readonly RecordKind[] }[] = [
	{ label: "input", kinds: ["user", "notice"] },
	{ label: "model", kinds: ["assistant", "thinking", "compaction"] },
	{ label: "tools", kinds: ["tool"] },
	{ label: "runtime", kinds: ["meta"] },
];

export interface TimelineHost {
	goTo(agentKey: string, recordId?: string): void;
	/** Record ids inside the dragged selection, or null when it is cleared. */
	onFocusChange(focus: ReadonlySet<string> | null): void;
}

/**
 * Remap spans into the active projection.
 *
 * All three projections are the same list under different x, which is what lets
 * a drag, a tick and a bar share one implementation. `sequence` and `elapsed`
 * both need a global ordering, so both sort once over every lane.
 */
function project(spans: readonly Span[], mode: TimelineMode): Span[] {
	if (mode === "clock") return [...spans];
	const order = [...spans].sort((left, right) => left.start - right.start || left.end - right.end);
	if (mode === "sequence") {
		const slot = new Map<Span, number>(order.map((span, index) => [span, index]));
		return spans.map((span) => ({ ...span, start: slot.get(span) ?? 0, end: (slot.get(span) ?? 0) + 1 }));
	}
	const shift = new Map<Span, number>();
	let removed = 0;
	let coveredUntil: number | null = null;
	for (const span of order) {
		if (coveredUntil !== null && span.start > coveredUntil) removed += span.start - coveredUntil;
		shift.set(span, removed);
		coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
	}
	return spans.map((span) => {
		const offset = shift.get(span) ?? 0;
		return { ...span, start: span.start - offset, end: span.end - offset };
	});
}

export class Timeline {
	private readonly _container: HTMLElement;
	private readonly _index: ViewerIndex;
	private readonly _store: Store;
	private readonly _host: TimelineHost;
	private _domain: TimeRange | null = null;
	private _focus: TimeRange | null = null;
	private _focusMode: TimelineMode | null = null;
	private _width = 800;

	private _drag: { x: number; kind: "select" | "pan"; startDomain: TimeRange } | null = null;

	constructor(container: HTMLElement, index: ViewerIndex, store: Store, host: TimelineHost) {
		this._container = container;
		this._index = index;
		this._store = store;
		this._host = host;
		if (typeof ResizeObserver !== "undefined") {
			const observer = new ResizeObserver(() => {
				const width = this._container.clientWidth;
				if (width > 0 && Math.abs(width - this._width) > 2) {
					this._width = width;
					this.render();
				}
			});
			observer.observe(container);
		}
	}

	get focus(): TimeRange | null {
		return this._focus;
	}

	/** Drop the zoom and the selection; called when the reader changes agent. */
	reset(): void {
		this._domain = null;
		this._focus = null;
		this._focusMode = null;
	}

	clearFocus(): void {
		this._focus = null;
		this._focusMode = null;
		this._host.onFocusChange(null);
		this.render();
	}

	/** A projection change invalidates a selection expressed in the old domain. */
	modeChanged(): void {
		this._domain = null;
		if (this._focus === null || this._focusMode === this._store.state.timelineMode) return;
		this._focus = null;
		this._focusMode = null;
		this._host.onFocusChange(null);
	}

	private _spans(): { spans: Span[]; lanes: Lane[] } {
		const state = this._store.state;
		const spans: Span[] = [];
		if (state.timelineScope === "all") {
			const lanes: Lane[] = [];
			for (const agent of this._index.agents) {
				const branchId = agent.key === state.agentKey ? state.branchId : agent.currentBranchId;
				const branch = branchOf(agent, branchId);
				if (branch === undefined) continue;
				const lane = lanes.length;
				lanes.push({ label: `${"  ".repeat(agent.depth)}${agentLabel(agent)}`, agentKey: agent.key });
				for (const entry of branchEntries(this._index, agent, branch)) {
					spans.push({
						record: entry.record,
						agentKey: agent.key,
						lane,
						start: entry.record.startedAt,
						end: entry.record.endedAt,
					});
				}
			}
			return { spans: project(spans, state.timelineMode), lanes };
		}
		const agent = this._index.agentByKey.get(state.agentKey);
		if (agent === undefined) return { spans, lanes: [] };
		const branch = branchOf(agent, state.branchId);
		if (branch === undefined) return { spans, lanes: [] };
		const laneOf = new Map<RecordKind, number>();
		AGENT_LANES.forEach((lane, laneIndex) => {
			for (const kind of lane.kinds) laneOf.set(kind, laneIndex);
		});
		for (const entry of branchEntries(this._index, agent, branch)) {
			spans.push({
				record: entry.record,
				agentKey: agent.key,
				lane: laneOf.get(entry.record.kind) ?? AGENT_LANES.length - 1,
				start: entry.record.startedAt,
				end: entry.record.endedAt,
			});
		}
		return { spans: project(spans, state.timelineMode), lanes: AGENT_LANES.map((lane) => ({ label: lane.label })) };
	}

	private _fullDomain(spans: readonly Span[]): TimeRange {
		let start = Number.POSITIVE_INFINITY;
		let end = Number.NEGATIVE_INFINITY;
		for (const span of spans) {
			if (span.start > 0 || this._store.state.timelineMode === "sequence") start = Math.min(start, span.start);
			end = Math.max(end, span.end);
		}
		if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
			const base = Number.isFinite(start) ? start : Date.now();
			return { start: base, end: base + 1000 };
		}
		return { start, end };
	}

	private _publishFocus(spans: readonly Span[]): void {
		const focus = this._focus;
		if (focus === null) {
			this._host.onFocusChange(null);
			return;
		}
		this._focusMode = this._store.state.timelineMode;
		const ids = new Set<string>();
		for (const span of spans) {
			if (span.start <= focus.end && span.end >= focus.start) ids.add(span.record.id);
		}
		this._host.onFocusChange(ids);
	}

	render(): void {
		const { spans, lanes } = this._spans();
		const mode = this._store.state.timelineMode;
		const full = this._fullDomain(spans);
		const domain = this._domain ?? full;
		const width = Math.max(320, this._container.clientWidth || this._width);
		this._width = width;
		const plotWidth = Math.max(80, width - LABEL_WIDTH - 12);
		const height = lanes.length * (LANE_HEIGHT + LANE_GAP) + AXIS_HEIGHT + 6;
		const scale = (at: number): number => ((at - domain.start) / (domain.end - domain.start)) * plotWidth;
		const unscale = (x: number): number => domain.start + (x / plotWidth) * (domain.end - domain.start);

		const children: SVGElement[] = [];
		lanes.forEach((lane, laneIndex) => {
			const y = laneIndex * (LANE_HEIGHT + LANE_GAP);
			children.push(svg("rect", { class: "tl-lane-bg", x: 0, y, width, height: LANE_HEIGHT }));
			const label = svg("text", { class: "tl-lane-label", x: 4, y: y + LANE_HEIGHT - 5 });
			label.textContent = lane.label;
			children.push(label);
		});

		if (this._focus !== null) {
			const x0 = LABEL_WIDTH + scale(this._focus.start);
			const x1 = LABEL_WIDTH + scale(this._focus.end);
			children.push(
				svg("rect", {
					class: "tl-focus",
					x: Math.min(x0, x1),
					y: 0,
					width: Math.max(2, Math.abs(x1 - x0)),
					height: lanes.length * (LANE_HEIGHT + LANE_GAP),
				}),
			);
		}

		const selectedId = this._store.state.recordId;
		for (const span of spans) {
			const x = LABEL_WIDTH + scale(span.start);
			const rawWidth = scale(span.end) - scale(span.start);
			if (x + rawWidth < LABEL_WIDTH - 4 || x > width + 4) continue;
			const barWidth = Math.max(MIN_SPAN_PX, mode === "sequence" ? rawWidth - 1 : rawWidth);
			const y = span.lane * (LANE_HEIGHT + LANE_GAP) + 3;
			const selected = span.record.id === selectedId && span.agentKey === this._store.state.agentKey;
			const rect = svg("rect", {
				class: `tl-span kind-${span.record.kind}${span.record.isError === true ? " is-error" : ""}${selected ? " is-selected" : ""}`,
				x,
				y,
				width: barWidth,
				height: LANE_HEIGHT - 6,
				rx: 2,
			});
			const title = svg("title");
			const clock = span.record.startedAt > 0 ? `${formatClock(span.record.startedAt)} · ` : "";
			title.textContent = `${KIND_LABEL[span.record.kind]} · ${span.record.title}\n${clock}${formatDuration(span.record.endedAt - span.record.startedAt)}\n${span.record.summary}`;
			rect.appendChild(title);
			rect.addEventListener("click", (event) => {
				event.stopPropagation();
				this._host.goTo(span.agentKey, span.record.id);
			});
			children.push(rect);
		}

		const axisY = lanes.length * (LANE_HEIGHT + LANE_GAP) + 12;
		for (const tick of ticksFor(domain, mode)) {
			const x = LABEL_WIDTH + scale(tick.at);
			if (x < LABEL_WIDTH || x > width) continue;
			children.push(svg("line", { class: "tl-tick", x1: x, y1: 0, x2: x, y2: axisY - 10 }));
			const text = svg("text", { class: "tl-axis-label", x: x + 3, y: axisY });
			text.textContent = tick.label;
			children.push(text);
		}

		const root = svg("svg", { class: "tl-svg", width, height, viewBox: `0 0 ${width} ${height}` }, children);

		root.addEventListener(
			"wheel",
			(event) => {
				const wheel = event as WheelEvent;
				wheel.preventDefault();
				const rect = root.getBoundingClientRect();
				const at = unscale(Math.max(0, wheel.clientX - rect.left - LABEL_WIDTH));
				const factor = wheel.deltaY > 0 ? 1.25 : 0.8;
				const nextStart = at - (at - domain.start) * factor;
				const nextEnd = at + (domain.end - at) * factor;
				this._domain =
					nextEnd - nextStart >= full.end - full.start
						? null
						: { start: Math.max(full.start - 1, nextStart), end: Math.min(full.end + 1, nextEnd) };
				this.render();
			},
			{ passive: false },
		);

		root.addEventListener("pointerdown", (event) => {
			const pointer = event as PointerEvent;
			if (pointer.button !== 0) return;
			const rect = root.getBoundingClientRect();
			const x = pointer.clientX - rect.left - LABEL_WIDTH;
			if (x < 0) return;
			this._drag = { x, kind: pointer.shiftKey ? "pan" : "select", startDomain: domain };
			root.setPointerCapture(pointer.pointerId);
		});

		root.addEventListener("pointermove", (event) => {
			const drag = this._drag;
			if (drag === null) return;
			const pointer = event as PointerEvent;
			const rect = root.getBoundingClientRect();
			const x = pointer.clientX - rect.left - LABEL_WIDTH;
			if (drag.kind === "pan") {
				const shift = ((drag.x - x) / plotWidth) * (drag.startDomain.end - drag.startDomain.start);
				this._domain = { start: drag.startDomain.start + shift, end: drag.startDomain.end + shift };
				this.render();
				return;
			}
			if (Math.abs(x - drag.x) < 3) return;
			this._focus = { start: unscale(Math.min(drag.x, x)), end: unscale(Math.max(drag.x, x)) };
			this.render();
		});

		const endDrag = (): void => {
			if (this._drag !== null && this._drag.kind === "select") this._publishFocus(spans);
			this._drag = null;
		};
		root.addEventListener("pointerup", endDrag);
		root.addEventListener("pointercancel", endDrag);
		root.addEventListener("dblclick", () => {
			this._domain = null;
			this._focus = null;
			this._focusMode = null;
			this._host.onFocusChange(null);
			this.render();
		});

		replace(this._container, [
			el("div", { class: "tl-head" }, [
				el("span", {
					class: "tl-title",
					text: this._store.state.timelineScope === "all" ? "all agents" : "this agent",
				}),
				el("span", { class: "tl-mode-note", text: MODE_NOTE[mode] }),
				el("span", {
					class: "tl-hint",
					text: "drag to focus · shift-drag to pan · wheel to zoom · double-click to reset",
				}),
			]),
			root as unknown as HTMLElement,
			renderLegend(),
		]);
	}
}

const MODE_NOTE: Record<TimelineMode, string> = {
	sequence: "one slot per record, in order",
	elapsed: "recorded durations, waiting removed",
	clock: "real time",
};

function renderLegend(): HTMLElement {
	return el(
		"div",
		{ class: "tl-legend" },
		KIND_ORDER.map((kind) =>
			el("span", { class: "legend-item" }, [
				el("span", { class: `legend-swatch kind-${kind}` }),
				el("span", { text: KIND_LABEL[kind] }),
			]),
		).concat([
			el("span", { class: "legend-item" }, [
				el("span", { class: "legend-swatch is-error" }),
				el("span", { text: "error" }),
			]),
		]),
	);
}

/** At most eight round tick positions, labelled for the active projection. */
function ticksFor(domain: TimeRange, mode: TimelineMode): { at: number; label: string }[] {
	const span = domain.end - domain.start;
	if (span <= 0) return [{ at: domain.start, label: "" }];
	const steps =
		mode === "sequence"
			? [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
			: [
					100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000,
					7_200_000, 21_600_000, 86_400_000,
				];
	const target = span / 6;
	const step = steps.find((candidate) => candidate >= target) ?? steps[steps.length - 1];
	const ticks: { at: number; label: string }[] = [];
	for (let at = Math.ceil(domain.start / step) * step; at <= domain.end; at += step) {
		if (mode === "sequence") ticks.push({ at, label: `#${at}` });
		else if (mode === "clock") ticks.push({ at, label: formatClock(at) });
		else ticks.push({ at, label: `+${formatDuration(at - domain.start)}` });
	}
	return ticks;
}
