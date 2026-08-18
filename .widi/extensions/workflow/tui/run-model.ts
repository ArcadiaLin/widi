import type { WorkflowOutlineNode } from "../flow/outline.ts";
import type {
	WorkflowFinishedPayload,
	WorkflowStartedPayload,
	WorkflowStateSlot,
	WorkflowStatus,
	WorkflowStepPayload,
} from "../protocol.ts";

/**
 * A run as something to look at: the flow's shape, filled in as it happens.
 *
 * Deliberately not a component. Everything here is the part worth arguing about
 * - what grows, what collapses, what is dropped when the terminal runs out of
 * room - and none of it needs a terminal to decide, so none of it needs one to
 * test either.
 *
 * The shape comes from the run's own `started` event rather than from the file:
 * see `flow/outline.ts` for why that distinction matters.
 */

/** Rows the display keeps at all costs, in the order it gives them up. */
export const MAX_BODY_ROWS = 9;

export type RowMark = "pending" | "running" | "retry" | "done" | "failed" | "note";

export interface RunRow {
	readonly depth: number;
	readonly mark: RowMark;
	readonly name: string;
	readonly detail: string;
	/** Right-aligned: the child agent while it runs, what it spent once it is done. */
	readonly tail: string;
	/** The branch that is actually moving. Folding never takes one of these. */
	readonly live: boolean;
}

export interface RunView {
	readonly title: string;
	/** Right-aligned on the title line. */
	readonly meter: string;
	readonly rows: readonly RunRow[];
	readonly footer: string;
	/** The whole run on one line, for the compact mode. */
	readonly compact: string;
}

interface RunNode {
	readonly key: string;
	readonly outline: WorkflowOutlineNode;
	readonly children: RunNode[];
	status: "pending" | "running" | "done" | "failed";
	item: string;
	attempt: number;
	childAgentId: string;
	detail: string;
	delta: string;
	/** Fan-out: how many items it will run. Loop: how many passes it has begun. */
	total: number;
	ms: number;
	startedAt: number;
	sizesAtStart: { readonly [key: string]: number };
	callsAtStart: number;
	spawnsAtStart: number;
	calls: number;
	spawns: number;
}

export class WorkflowRun {
	readonly agentId: string;
	readonly runId: string;
	readonly workflow: string;
	readonly startedAt = Date.now();
	status: "running" | WorkflowStatus = "running";

	private readonly _budgetModelCalls: number;
	private readonly _budgetAgentSpawns: number;
	private readonly _budgetWallClockMs: number;
	private readonly _slots: readonly WorkflowStateSlot[];
	private readonly _outline = new Map<string, WorkflowOutlineNode>();
	private readonly _byParent = new Map<string, WorkflowOutlineNode[]>();
	private readonly _nodes = new Map<string, RunNode>();
	private readonly _roots: RunNode[] = [];
	private readonly _populated = new Set<string>();
	private _sizes: { readonly [key: string]: number } = {};
	private _spend = { modelCalls: 0, agentSpawns: 0, totalTokens: 0, cost: 0 };
	private _headline = "";
	private _elapsedMs = 0;
	private _failure?: RunNode;

	constructor(started: WorkflowStartedPayload) {
		this.agentId = started.agentId;
		this.runId = started.runId;
		this.workflow = started.workflow;
		this._budgetModelCalls = started.budgetModelCalls;
		this._budgetAgentSpawns = started.budgetAgentSpawns;
		this._budgetWallClockMs = started.budgetWallClockMs;
		this._slots = started.state;
		for (const node of started.outline) {
			this._outline.set(node.path, node);
			const parent = templateParent(node.path);
			const siblings = this._byParent.get(parent) ?? [];
			siblings.push(node);
			this._byParent.set(parent, siblings);
		}
		this._populate("", "");
	}

	apply(step: WorkflowStepPayload): void {
		this._spend = {
			modelCalls: step.modelCalls,
			agentSpawns: step.agentSpawns,
			totalTokens: step.totalTokens,
			cost: step.cost,
		};
		this._sizes = step.state;
		const node = this._ensure(step.path);
		if (node === undefined) return;
		switch (step.phase) {
			case "started":
				node.status = "running";
				node.startedAt = Date.now();
				node.sizesAtStart = step.state;
				node.callsAtStart = step.modelCalls;
				node.spawnsAtStart = step.agentSpawns;
				if (step.item !== "") node.item = step.item;
				return;
			case "progress":
				if (step.attempt > 0) node.attempt = step.attempt;
				if (step.childAgentId !== "") node.childAgentId = step.childAgentId;
				if (step.detail !== "") node.detail = step.detail;
				if (step.total > 0) this._lanes(node, step.total, step.items);
				return;
			case "finished":
				node.status = step.ok ? "done" : "failed";
				node.detail = step.detail;
				node.delta = this._describeDelta(node.sizesAtStart, step.state);
				node.ms = step.ms;
				node.calls = step.modelCalls - node.callsAtStart;
				node.spawns = step.agentSpawns - node.spawnsAtStart;
				node.childAgentId = "";
				if (!step.ok) this._failure ??= node;
				return;
		}
	}

	finish(finished: WorkflowFinishedPayload): void {
		this.status = finished.status;
		this._headline = finished.headline;
		this._elapsedMs = finished.elapsedMs;
		this._spend = {
			modelCalls: finished.modelCalls,
			agentSpawns: finished.agentSpawns,
			totalTokens: finished.totalTokens,
			cost: finished.cost,
		};
	}

	view(now: number, maxRows: number = MAX_BODY_ROWS): RunView {
		return this.status === "running" ? this._running(now, maxRows) : this._closed();
	}

	private _running(now: number, maxRows: number): RunView {
		const rows: RunRow[] = [];
		this._walk(this._roots, 0, now, rows);
		const active = this._active();
		const laid = foldPendingTail(rows);
		return {
			title: this.workflow,
			meter: [
				`${this._spend.modelCalls}/${this._budgetModelCalls} calls`,
				`${this._spend.agentSpawns}/${this._budgetAgentSpawns} agents`,
				elapsed(now - this.startedAt),
			].join("  "),
			rows: fit(laid, maxRows),
			footer: this._stateLine(),
			compact: `${this.workflow}  ${active}  ${this._spend.modelCalls}/${this._budgetModelCalls} calls  ${elapsed(
				now - this.startedAt,
			)}`,
		};
	}

	private _closed(): RunView {
		const rows: RunRow[] = [{ depth: 0, mark: "note", name: this._headline, detail: "", tail: "", live: false }];
		if (this._failure !== undefined && this.status !== "completed") {
			rows.push({
				depth: 0,
				mark: "failed",
				name: this._failure.outline.id,
				detail: this._failure.item === "" ? this._failure.detail : this._failure.item,
				tail: took(this._failure.ms),
				live: false,
			});
		}
		const spent = [
			`${this._spend.modelCalls}/${this._budgetModelCalls} calls`,
			`${this._spend.agentSpawns} agents`,
			`${tokens(this._spend.totalTokens)} tok`,
			`$${this._spend.cost.toFixed(4)}`,
			`${elapsed(this._elapsedMs)} of at most ${elapsed(this._budgetWallClockMs)}`,
		].join(" · ");
		return {
			title: `${this.workflow}  ${this.status}`,
			meter: "",
			rows,
			footer: spent,
			compact: `${this.workflow}  ${this.status}  ${this._headline}`,
		};
	}

	/** What the compact line names: the deepest thing that is moving. */
	private _active(): string {
		let deepest: RunNode | undefined;
		for (const node of this._nodes.values()) {
			if (node.status !== "running") continue;
			if (deepest === undefined || node.outline.depth >= deepest.outline.depth) deepest = node;
		}
		if (deepest === undefined) return "starting";
		return deepest.item === "" ? deepest.outline.id : `${deepest.outline.id} ${deepest.item}`;
	}

	private _stateLine(): string {
		return this._slots
			.map((slot) => {
				const size = this._sizes[slot.key] ?? 0;
				if (size === 0) return `${slot.key} -`;
				return slot.kind === "text" ? `${slot.key} set` : `${slot.key} ${size}`;
			})
			.join("  ");
	}

	/**
	 * Rows for one level. A container is expanded exactly while it is running,
	 * which is what makes a finished branch fold back into one line and the
	 * active one stay whole. Top-level steps nobody has reached yet share a row:
	 * their names are all they have to say.
	 */
	private _walk(nodes: readonly RunNode[], depth: number, now: number, out: RunRow[]): void {
		for (const node of nodes) {
			out.push(this._row(node, depth, now));
			if (node.status === "running" && node.children.length > 0) this._walk(node.children, depth + 1, now, out);
		}
	}

	private _row(node: RunNode, depth: number, now: number): RunRow {
		const running = node.status === "running";
		return {
			depth,
			mark: node.status === "running" && node.attempt > 1 ? "retry" : node.status,
			name: node.outline.id,
			detail: this._detail(node),
			tail: running ? this._liveTail(node, now) : node.status === "pending" ? "" : this._doneTail(node),
			live: running,
		};
	}

	private _detail(node: RunNode): string {
		if (node.status === "pending") return node.item === "" ? bound(node.outline) : node.item;
		if (node.status === "running") {
			if (node.item !== "") return node.attempt > 1 ? `${node.item} - ${node.detail}` : node.item;
			switch (node.outline.kind) {
				case "loop":
					return `pass ${Math.max(1, node.total)} of ${node.outline.maxIterations}`;
				case "fanout":
					return `${node.children.filter((child) => child.status !== "pending").length} of ${
						node.total
					} items, ${Math.min(node.total, node.outline.maxConcurrency)} at once`;
				case "agent":
					if (node.attempt === 0) return "spawning";
					return node.attempt > 1
						? `attempt ${node.attempt} of ${node.outline.maxAttempts} - ${node.detail}`
						: `attempt ${node.attempt} of ${node.outline.maxAttempts}`;
				default:
					return "";
			}
		}
		if (node.item !== "") return node.item;
		// What it changed says more than that it finished, and for a transform it
		// is the only thing there is to say.
		return node.delta === "" ? node.detail : node.delta;
	}

	private _liveTail(node: RunNode, now: number): string {
		const since = elapsed(now - node.startedAt);
		return node.outline.role === "" ? since : `→ ${node.outline.role} · ${since}`;
	}

	private _doneTail(node: RunNode): string {
		const parts: string[] = [];
		// An agent step counts its own attempts. The global counters cannot be
		// differenced for one: inside a fan-out its window overlaps the lanes
		// running beside it, and it would claim their calls as its own.
		const calls = node.outline.kind === "agent" ? node.attempt : node.calls;
		if (calls > 0) parts.push(calls === 1 ? "1 call" : `${calls} calls`);
		if (node.outline.kind !== "agent" && node.spawns > 1) parts.push(`${node.spawns} agents`);
		parts.push(took(node.ms));
		return parts.join(" · ");
	}

	private _describeDelta(
		before: { readonly [key: string]: number },
		after: { readonly [key: string]: number },
	): string {
		const parts: string[] = [];
		for (const slot of this._slots) {
			const change = (after[slot.key] ?? 0) - (before[slot.key] ?? 0);
			if (change === 0) continue;
			if (slot.kind === "text") {
				parts.push(`${slot.key} ${(after[slot.key] ?? 0) > 0 ? "set" : "cleared"}`);
				continue;
			}
			parts.push(`${slot.key} ${change > 0 ? "+" : ""}${change}`);
		}
		return parts.slice(0, 3).join(", ");
	}

	/**
	 * A fan-out's lanes, laid out the moment it knows how wide it is. Every lane
	 * gets its body steps as pending rows carrying the item they are about, which
	 * is the difference between four rows saying `answer` and four rows saying
	 * what each is answering.
	 */
	private _lanes(node: RunNode, total: number, items: readonly string[]): void {
		node.total = total;
		for (let lane = 0; lane < total; lane += 1) {
			const prefix = `${node.key}#${lane}`;
			this._populate(prefix, node.outline.path);
			const item = items[lane];
			if (item === undefined || item === "") continue;
			for (const child of this._byParent.get(node.outline.path) ?? []) {
				const created = this._nodes.get(`${prefix}/${child.id}`);
				if (created !== undefined && created.item === "") created.item = item;
			}
		}
	}

	private _populate(prefix: string, templatePath: string): void {
		if (this._populated.has(prefix)) return;
		this._populated.add(prefix);
		for (const child of this._byParent.get(templatePath) ?? []) {
			this._ensure(prefix === "" ? child.id : `${prefix}/${child.id}`);
		}
	}

	private _ensure(path: string): RunNode | undefined {
		const existing = this._nodes.get(path);
		if (existing !== undefined) return existing;
		const outline = this._outline.get(templateOf(path));
		if (outline === undefined) return undefined;
		const slash = path.lastIndexOf("/");
		const prefix = slash < 0 ? "" : path.slice(0, slash);
		const parentKey = prefix.replace(QUALIFIER, "");
		const parent = parentKey === "" ? undefined : this._ensure(parentKey);
		const node: RunNode = {
			key: path,
			outline,
			children: [],
			status: "pending",
			item: "",
			attempt: 0,
			childAgentId: "",
			detail: "",
			delta: "",
			total: 0,
			ms: 0,
			startedAt: Date.now(),
			sizesAtStart: {},
			callsAtStart: 0,
			spawnsAtStart: 0,
			calls: 0,
			spawns: 0,
		};
		this._nodes.set(path, node);
		(parent === undefined ? this._roots : parent.children).push(node);
		// A loop reports the scope it was entered from, not its own pass, so the
		// pass count is read off the qualifier its body carries.
		const qualifier = QUALIFIER.exec(prefix);
		if (parent !== undefined && parent.outline.kind === "loop" && qualifier?.[1] !== undefined) {
			parent.total = Math.max(parent.total, Number(qualifier[1]) + 1);
		}
		// Siblings arrive with it: a step nobody has reached is still part of the
		// shape, and the shape is the thing this view has that a log does not.
		this._populate(prefix, templateOf(parentKey));
		return node;
	}
}

/**
 * Every run the TUI half knows about, keyed by the agent it belongs to.
 *
 * A `tui` half belongs to no agent and hears from all of them at once, so
 * knowing which one is on screen is the whole of how it tells its own traffic
 * apart. Runs on other agents are kept, not drawn: they are a count in the
 * footer and a marker on the strip, which is as much as somebody looking at a
 * different agent asked for.
 */
export class WorkflowBoard {
	/** Compact mode is the board's, not the view's: a widget is rebuilt, this is not. */
	compact = false;
	private readonly _runs = new Map<string, WorkflowRun>();
	private _visible?: string;

	setVisible(agentId: string | undefined): void {
		this._visible = agentId;
	}

	started(payload: WorkflowStartedPayload): void {
		this._runs.set(payload.agentId, new WorkflowRun(payload));
	}

	step(payload: WorkflowStepPayload): void {
		const run = this._runs.get(payload.agentId);
		// A late event from the run before this one would draw into the wrong shape.
		if (run?.runId === payload.runId) run.apply(payload);
	}

	finished(payload: WorkflowFinishedPayload): void {
		const run = this._runs.get(payload.agentId);
		if (run?.runId === payload.runId) run.finish(payload);
	}

	/** The run to draw: the visible agent's, finished ones included. */
	visible(): WorkflowRun | undefined {
		return this._visible === undefined ? undefined : this._runs.get(this._visible);
	}

	/** Runs still going on agents that are not on screen. */
	elsewhere(): number {
		let count = 0;
		for (const [agentId, run] of this._runs) {
			if (agentId !== this._visible && run.status === "running") count += 1;
		}
		return count;
	}
}

const QUALIFIER = /#(\d+)$/;

/** `findLastIndex` under another name: the lib this compiles against has none. */
function lastIndexWhere<T>(list: readonly T[], matches: (entry: T) => boolean): number {
	for (let index = list.length - 1; index >= 0; index -= 1) {
		const entry = list[index];
		if (entry !== undefined && matches(entry)) return index;
	}
	return -1;
}

function templateOf(path: string): string {
	return path.replace(/#\d+/g, "");
}

function templateParent(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

function bound(outline: WorkflowOutlineNode): string {
	switch (outline.kind) {
		case "agent":
			return `agent, up to ${outline.maxAttempts} attempts`;
		case "loop":
			return `loop, up to ${outline.maxIterations} passes`;
		case "fanout":
			return `over ${outline.over}, up to ${outline.maxItems}`;
		default:
			return outline.kind;
	}
}

/**
 * Top-level steps nobody has reached yet share one row - but only once the tree
 * has opened up somewhere, because until then their names are the whole picture
 * and there is room for them.
 */
function foldPendingTail(rows: readonly RunRow[]): readonly RunRow[] {
	if (!rows.some((row) => row.depth > 0)) return rows;
	const last = lastIndexWhere(rows, (row) => row.depth > 0 || row.mark !== "pending");
	const rest = rows.slice(last + 1);
	if (rest.length < 2) return rows;
	return [
		...rows.slice(0, last + 1),
		{
			depth: 0,
			mark: "pending",
			name: rest.map((row) => row.name).join(", "),
			detail: "",
			tail: `${rest.length} steps pending`,
			live: false,
		},
	];
}

/**
 * Fold rows until they fit, always at the expense of a run that is not moving.
 *
 * The greedy part matters: it takes the longest stretch of settled rows first,
 * wherever it sits, so what disappears is the part with the least left to say.
 * A live row is never in such a stretch, which is what keeps the branch that is
 * actually running whole down to the last possible row.
 */
function fit(rows: readonly RunRow[], max: number): readonly RunRow[] {
	if (rows.length <= max) return rows;
	const folded = [...rows];
	while (folded.length > max) {
		const run = longestSettledRun(folded);
		if (run === undefined) break;
		folded.splice(run.start, run.length, settled(folded.slice(run.start, run.start + run.length)));
	}
	if (folded.length <= max) return folded;
	// Nothing settled is left to give up, so the tail wins: that is where a
	// running branch and its leaves are.
	return [more(folded.length - max + 1), ...folded.slice(folded.length - max + 1)];
}

/** The longest stretch of adjacent rows that are neither running nor already a fold. */
function longestSettledRun(rows: readonly RunRow[]): { start: number; length: number } | undefined {
	let best: { start: number; length: number } | undefined;
	let start = -1;
	for (let index = 0; index <= rows.length; index += 1) {
		const row = rows[index];
		const settled = row !== undefined && !row.live && row.mark !== "note";
		if (settled) {
			if (start < 0) start = index;
			continue;
		}
		if (start >= 0) {
			const length = index - start;
			if (length >= 2 && (best === undefined || length > best.length)) best = { start, length };
			start = -1;
		}
	}
	return best;
}

function settled(rows: readonly RunRow[]): RunRow {
	const done = rows.every((row) => row.mark === "done");
	const pending = rows.every((row) => row.mark === "pending");
	const word = done ? "done" : pending ? "pending" : "folded away";
	return { depth: 0, mark: "note", name: `… ${rows.length} steps ${word}`, detail: "", tail: "", live: false };
}

function more(count: number): RunRow {
	return { depth: 0, mark: "note", name: `… +${count} more`, detail: "", tail: "", live: false };
}

function elapsed(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	if (seconds < 600) return `${Math.round(seconds)}s`;
	return `${Math.round(seconds / 60)}m`;
}

function took(ms: number): string {
	return elapsed(ms);
}

function tokens(total: number): string {
	return total < 1000 ? `${total}` : `${(total / 1000).toFixed(1)}k`;
}
