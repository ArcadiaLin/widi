import type { WorkflowOutlineNode } from "./flow/outline.ts";

/**
 * The whole contract between the two halves, and between the extension and any
 * client driving it from outside. Every payload is a type alias rather than an
 * interface so it stays assignable to the bus's `JsonValue`, and every one has
 * a reader beside it that answers `undefined` for a shape it cannot use.
 */

export const WORKFLOW_EXTENSION_ID = "workflow";

export const WORKFLOW_EVENT = {
	/** In: run a flow by name on the agent the envelope is attributed to. */
	run: "workflow:run",
	/** In, no payload: stop whatever that agent is running. */
	cancel: "workflow:cancel",
	/** In, no payload: what flows are installed, and do they pass their audit. */
	list: "workflow:list",
	/** Out: the answer to `list`, re-read from disk rather than remembered. */
	catalog: "workflow:catalog",
	/** Out: the flow passed its audit, here is its shape, and the run has begun. */
	started: "workflow:started",
	/** Out: one step entered, changed, or left. */
	step: "workflow:step",
	/** Out: how it ended, including a refusal to start at all. */
	finished: "workflow:finished",
} as const;

export type WorkflowRunPayload = { readonly workflow: string; readonly input: string };

export type WorkflowCatalogEntry = {
	readonly name: string;
	readonly path: string;
	readonly description: string;
	readonly ok: boolean;
	readonly modelCalls: number;
	readonly agentSpawns: number;
	readonly problems: readonly string[];
};

export type WorkflowCatalogPayload = {
	readonly agentId: string;
	readonly roots: readonly string[];
	readonly flows: readonly WorkflowCatalogEntry[];
};

/** A declared state slot: the view needs the kind to know what a size of 0 means. */
export type WorkflowStateSlot = { readonly key: string; readonly kind: string };

export type WorkflowStartedPayload = {
	readonly agentId: string;
	/** Distinguishes this run's events from those of the one before it. */
	readonly runId: string;
	readonly workflow: string;
	readonly input: string;
	readonly worstCaseModelCalls: number;
	readonly worstCaseAgentSpawns: number;
	readonly budgetModelCalls: number;
	readonly budgetAgentSpawns: number;
	readonly budgetWallClockMs: number;
	readonly outline: readonly WorkflowOutlineNode[];
	readonly state: readonly WorkflowStateSlot[];
};

/** `progress` is a change inside a step: a new attempt, or a fan-out's width. */
export type WorkflowStepPhase = "started" | "progress" | "finished";

/** `item` is "" outside a fan-out: the bus carries JSON, which has no undefined. */
export type WorkflowStepPayload = {
	readonly agentId: string;
	readonly runId: string;
	readonly workflow: string;
	/**
	 * Unique per execution: `rounds#0/probe#2/answer`. A loop pass and a fan-out
	 * lane both repeat a step id, and a view keyed on the id alone would draw
	 * them as one row. Strip the `#n` qualifiers to get the outline path.
	 */
	readonly path: string;
	readonly step: string;
	readonly kind: string;
	readonly phase: WorkflowStepPhase;
	readonly iteration: number;
	readonly item: string;
	/** Which attempt is running; 0 before the first one starts. */
	readonly attempt: number;
	/** The child agent being asked; "" when there is not one. */
	readonly childAgentId: string;
	/** Fan-out only: how many items it will really run. 0 elsewhere. */
	readonly total: number;
	/**
	 * Fan-out only, on `progress`: the items themselves, in lane order. It is what
	 * lets a view name the lanes that have not started yet - the difference
	 * between four rows saying `answer` and four rows saying what they are about.
	 */
	readonly items: readonly string[];
	/** `finished` only: whether the step produced what it promised. */
	readonly ok: boolean;
	/** The step's own word on what just happened; "" when it has none. */
	readonly detail: string;
	/** `finished` only. */
	readonly ms: number;
	readonly modelCalls: number;
	readonly agentSpawns: number;
	readonly totalTokens: number;
	readonly cost: number;
	/** Size of every declared slot as of this event. */
	readonly state: { readonly [key: string]: number };
};

export type WorkflowStatus = "completed" | "failed" | "cancelled" | "refused";

export type WorkflowFinishedPayload = {
	readonly agentId: string;
	readonly runId: string;
	readonly workflow: string;
	readonly status: WorkflowStatus;
	readonly headline: string;
	readonly modelCalls: number;
	readonly agentSpawns: number;
	readonly totalTokens: number;
	readonly cost: number;
	readonly elapsedMs: number;
};

type UnknownRecord = { readonly [key: string]: unknown };

function record(payload: unknown): UnknownRecord | undefined {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload)
		? (payload as UnknownRecord)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A string field that is allowed to be empty, which most of the step fields are. */
function optional(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function lines(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function sizes(value: unknown): { readonly [key: string]: number } {
	const fields = record(value);
	if (fields === undefined) return {};
	const found: { [key: string]: number } = {};
	for (const [key, size] of Object.entries(fields)) {
		const parsed = count(size);
		if (parsed !== undefined) found[key] = parsed;
	}
	return found;
}

function outline(value: unknown): readonly WorkflowOutlineNode[] {
	if (!Array.isArray(value)) return [];
	const nodes: WorkflowOutlineNode[] = [];
	for (const entry of value) {
		const fields = record(entry);
		const path = text(fields?.path);
		const id = text(fields?.id);
		const kind = text(fields?.kind);
		const depth = count(fields?.depth);
		if (path === undefined || id === undefined || kind === undefined || depth === undefined) continue;
		nodes.push({
			path,
			id,
			kind,
			depth,
			maxAttempts: count(fields?.maxAttempts) ?? 0,
			maxIterations: count(fields?.maxIterations) ?? 0,
			maxItems: count(fields?.maxItems) ?? 0,
			maxConcurrency: count(fields?.maxConcurrency) ?? 0,
			over: optional(fields?.over),
			role: optional(fields?.role),
		});
	}
	return nodes;
}

function slots(value: unknown): readonly WorkflowStateSlot[] {
	if (!Array.isArray(value)) return [];
	const found: WorkflowStateSlot[] = [];
	for (const entry of value) {
		const fields = record(entry);
		const key = text(fields?.key);
		if (key !== undefined) found.push({ key, kind: optional(fields?.kind) });
	}
	return found;
}

export function readRun(payload: unknown): WorkflowRunPayload | undefined {
	const fields = record(payload);
	const workflow = text(fields?.workflow);
	const input = text(fields?.input);
	return workflow === undefined || input === undefined ? undefined : { workflow, input };
}

export function readCatalog(payload: unknown): WorkflowCatalogPayload | undefined {
	const fields = record(payload);
	const agentId = text(fields?.agentId);
	if (agentId === undefined || !Array.isArray(fields?.flows)) return undefined;
	const flows: WorkflowCatalogEntry[] = [];
	for (const entry of fields.flows) {
		const flow = record(entry);
		const name = text(flow?.name);
		const path = text(flow?.path);
		if (name === undefined || path === undefined) return undefined;
		flows.push({
			name,
			path,
			description: optional(flow?.description),
			ok: flow?.ok === true,
			modelCalls: count(flow?.modelCalls) ?? 0,
			agentSpawns: count(flow?.agentSpawns) ?? 0,
			problems: lines(flow?.problems),
		});
	}
	return { agentId, roots: lines(fields.roots), flows };
}

export function readStarted(payload: unknown): WorkflowStartedPayload | undefined {
	const fields = record(payload);
	const agentId = text(fields?.agentId);
	const runId = text(fields?.runId);
	const workflow = text(fields?.workflow);
	const worstCaseModelCalls = count(fields?.worstCaseModelCalls);
	const worstCaseAgentSpawns = count(fields?.worstCaseAgentSpawns);
	const budgetModelCalls = count(fields?.budgetModelCalls);
	if (agentId === undefined || runId === undefined || workflow === undefined) return undefined;
	if (worstCaseModelCalls === undefined || worstCaseAgentSpawns === undefined || budgetModelCalls === undefined) {
		return undefined;
	}
	return {
		agentId,
		runId,
		workflow,
		input: optional(fields?.input),
		worstCaseModelCalls,
		worstCaseAgentSpawns,
		budgetModelCalls,
		budgetAgentSpawns: count(fields?.budgetAgentSpawns) ?? 0,
		budgetWallClockMs: count(fields?.budgetWallClockMs) ?? 0,
		outline: outline(fields?.outline),
		state: slots(fields?.state),
	};
}

const PHASES: readonly WorkflowStepPhase[] = ["started", "progress", "finished"];

export function readStep(payload: unknown): WorkflowStepPayload | undefined {
	const fields = record(payload);
	const agentId = text(fields?.agentId);
	const runId = text(fields?.runId);
	const workflow = text(fields?.workflow);
	const path = text(fields?.path);
	const step = text(fields?.step);
	const kind = text(fields?.kind);
	const phase = PHASES.find((candidate) => candidate === fields?.phase);
	const iteration = count(fields?.iteration);
	const modelCalls = count(fields?.modelCalls);
	if (agentId === undefined || runId === undefined || workflow === undefined) return undefined;
	if (path === undefined || step === undefined || kind === undefined || phase === undefined) return undefined;
	if (iteration === undefined || modelCalls === undefined || typeof fields?.item !== "string") return undefined;
	return {
		agentId,
		runId,
		workflow,
		path,
		step,
		kind,
		phase,
		iteration,
		item: fields.item,
		attempt: count(fields?.attempt) ?? 0,
		childAgentId: optional(fields?.childAgentId),
		total: count(fields?.total) ?? 0,
		items: lines(fields?.items),
		ok: fields?.ok === true,
		detail: optional(fields?.detail),
		ms: count(fields?.ms) ?? 0,
		modelCalls,
		agentSpawns: count(fields?.agentSpawns) ?? 0,
		totalTokens: count(fields?.totalTokens) ?? 0,
		cost: count(fields?.cost) ?? 0,
		state: sizes(fields?.state),
	};
}

const STATUSES: readonly WorkflowStatus[] = ["completed", "failed", "cancelled", "refused"];

export function readFinished(payload: unknown): WorkflowFinishedPayload | undefined {
	const fields = record(payload);
	const agentId = text(fields?.agentId);
	const workflow = text(fields?.workflow);
	const headline = text(fields?.headline);
	const status = STATUSES.find((candidate) => candidate === fields?.status);
	const modelCalls = count(fields?.modelCalls);
	const agentSpawns = count(fields?.agentSpawns);
	const totalTokens = count(fields?.totalTokens);
	const cost = count(fields?.cost);
	const elapsedMs = count(fields?.elapsedMs);
	if (agentId === undefined || workflow === undefined || headline === undefined || status === undefined)
		return undefined;
	if (modelCalls === undefined || agentSpawns === undefined || elapsedMs === undefined) return undefined;
	if (totalTokens === undefined || cost === undefined) return undefined;
	return {
		agentId,
		// A refusal has no run behind it, so it carries no id; the view keys those
		// on the flow name instead.
		runId: optional(fields?.runId),
		workflow,
		status,
		headline,
		modelCalls,
		agentSpawns,
		totalTokens,
		cost,
		elapsedMs,
	};
}
