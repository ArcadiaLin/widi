import type { ExtensionActivationApi, ExtensionContext } from "../../../../apps/widi/src/core/extension/api.ts";
import { discoverFlows } from "../flow/discover.ts";
import type { Flow } from "../flow/document.ts";
import { buildOutline } from "../flow/outline.ts";
import { readRun, WORKFLOW_EVENT, type WorkflowStatus } from "../protocol.ts";
import { runFlow, type WorkflowProgress, type WorkflowRunResult } from "./engine.ts";
import { RunJournal } from "./journal.ts";

const STATUS_KEY = "run";

/**
 * The half that answers a trigger. One of these exists per agent, so the first
 * thing each handler does is decide whether it is the one being addressed.
 *
 * The catalog is re-read from disk on every request rather than cached: a flow
 * is a file somebody is editing, and an engine that remembered the version it
 * loaded would make every edit look like it did nothing.
 */
export function installWorkflowRunner(api: ExtensionActivationApi): void {
	let active: { readonly flow: string; readonly controller: AbortController } | undefined;

	api.onExtensionEvent(WORKFLOW_EVENT.list, async (envelope, context) => {
		if (envelope.sourceAgentId !== context.agentId) return;
		const catalog = await discoverFlows();
		await context.actions.emitExtensionEvent(WORKFLOW_EVENT.catalog, {
			agentId: context.agentId,
			roots: [...catalog.roots],
			flows: catalog.entries.map((entry) => ({
				name: entry.name,
				path: entry.path,
				description: entry.description ?? "",
				ok: entry.flow !== undefined,
				modelCalls: entry.cost?.modelCalls ?? 0,
				agentSpawns: entry.cost?.agentSpawns ?? 0,
				problems: [...entry.problems],
			})),
		});
	});

	api.onExtensionEvent(WORKFLOW_EVENT.run, async (envelope, context) => {
		// Attribution is the addressing: the TUI half's events carry the visible
		// agent, an RPC client names an agent outright, and exactly one runtime in
		// the process matches either way.
		if (envelope.sourceAgentId !== context.agentId) return;
		const request = readRun(envelope.payload);
		if (request === undefined) return;
		if (active !== undefined) {
			// A refusal is not a run, so it carries no run id: there is nothing for
			// a later event of its own to be told apart from.
			await finish(context, request.workflow, "", "refused", `A ${active.flow} run is already in progress.`, undefined);
			return;
		}

		const catalog = await discoverFlows();
		const entry = catalog.entries.find((candidate) => candidate.name === request.workflow);
		// A flow only runs when its audit passed; the listing still shows the rest.
		const flow = entry?.flow;
		if (flow === undefined) {
			const reason =
				entry === undefined
					? `No flow named '${request.workflow}' in ${catalog.roots.join(" or ")}.`
					: entry.problems.join(" ");
			await finish(context, request.workflow, "", "refused", reason, undefined);
			return;
		}

		const controller = new AbortController();
		active = { flow: flow.name, controller };
		const runId = `${flow.name}-${Date.now().toString(36)}`;
		await context.actions.emitExtensionEvent(WORKFLOW_EVENT.started, {
			agentId: context.agentId,
			runId,
			workflow: flow.name,
			input: request.input,
			worstCaseModelCalls: entry?.cost?.modelCalls ?? 0,
			worstCaseAgentSpawns: entry?.cost?.agentSpawns ?? 0,
			budgetModelCalls: flow.budget.modelCalls,
			budgetAgentSpawns: flow.budget.agentSpawns,
			budgetWallClockMs: flow.budget.wallClockMs,
			// The shape goes out with the run rather than being read back off disk:
			// the file is one somebody is editing, and a view that re-parsed it would
			// draw a flow that is not the one executing.
			outline: [...buildOutline(flow)],
			state: flow.state.map((slot) => ({ key: slot.key, kind: slot.kind })),
		});
		// Deliberately not awaited. Bus dispatch is sequential, so a handler that
		// ran the flow to the end would hold the emitter and every subscriber
		// behind it for the whole run.
		void execute(context, flow, request.input, runId, controller).finally(() => {
			active = undefined;
		});
	});

	api.onExtensionEvent(WORKFLOW_EVENT.cancel, (envelope, context) => {
		if (envelope.sourceAgentId !== context.agentId) return;
		active?.controller.abort();
	});

	// The run outlives the handler that started it and holds that handler's
	// context, so it has to end when the runtime holding it does.
	api.onDispose(() => {
		active?.controller.abort();
	});
}

async function execute(
	context: ExtensionContext,
	flow: Flow,
	input: string,
	runId: string,
	controller: AbortController,
): Promise<void> {
	try {
		// The journal writes files, so it needs the same trust as `exec` does.
		const journal = RunJournal.of(flow, context.actions.isProjectTrusted());
		await journal?.write("run", {
			runId,
			workflow: flow.name,
			version: flow.version,
			input,
			budgetModelCalls: flow.budget.modelCalls,
		});
		const result = await runFlow(flow, input, {
			actions: context.actions,
			signal: controller.signal,
			runId,
			...(journal === undefined ? undefined : { journal }),
			onProgress: async (progress) => await report(context, flow, runId, progress),
		});
		await journal?.write("result", {
			runId,
			status: result.status,
			headline: result.headline,
			modelCalls: result.spend.modelCalls,
			agentSpawns: result.spend.agentSpawns,
			totalTokens: result.spend.totalTokens,
			cost: result.spend.cost,
			elapsedMs: result.elapsedMs,
			state: result.state,
		});
		await context.actions.clearStatus(STATUS_KEY);
		await publish(context, flow, result, journal?.path);
		await finish(context, flow.name, runId, result.status, result.headline, result);
	} catch (error) {
		// Whatever went wrong, something has to answer: a client waiting on
		// `workflow:finished` has no other way to learn the run is over.
		await context.actions.clearStatus(STATUS_KEY);
		await finish(
			context,
			flow.name,
			runId,
			"failed",
			error instanceof Error ? error.message : String(error),
			undefined,
		);
	}
}

async function report(context: ExtensionContext, flow: Flow, runId: string, progress: WorkflowProgress): Promise<void> {
	if (progress.phase === "started") {
		// A marker on the agent itself rather than a line in the footer: the TUI
		// half draws the visible agent's run in full, and what is left for this to
		// say is that some *other* agent is running one at all.
		await context.actions.setStatus(STATUS_KEY, {
			text: `${flow.name}: ${progress.step}${progress.item.length > 0 ? ` - ${progress.item}` : ""}`,
			progress: { completed: progress.spend.modelCalls, total: flow.budget.modelCalls },
			region: "agent-strip",
			icon: "▸",
			tone: "info",
		});
	}
	await context.actions.emitExtensionEvent(WORKFLOW_EVENT.step, {
		agentId: context.agentId,
		runId,
		workflow: flow.name,
		path: progress.path,
		step: progress.step,
		kind: progress.kind,
		phase: progress.phase,
		iteration: progress.iteration,
		item: progress.item,
		attempt: progress.attempt,
		childAgentId: progress.childAgentId,
		total: progress.total,
		items: [...progress.items],
		ok: progress.ok,
		detail: progress.detail,
		ms: progress.ms,
		modelCalls: progress.spend.modelCalls,
		agentSpawns: progress.spend.agentSpawns,
		totalTokens: progress.spend.totalTokens,
		cost: progress.spend.cost,
		state: progress.state,
	});
}

/**
 * What the run leaves behind in the terminal: the report the flow declared, and
 * the ledger it was counted from. Neither is a session entry - a flow's records
 * belong in its own journal, not replayed into a model's context on every
 * resume and forked into every child session.
 */
async function publish(
	context: ExtensionContext,
	flow: Flow,
	result: WorkflowRunResult,
	journalPath: string | undefined,
): Promise<void> {
	const spent = [
		`${result.spend.modelCalls} of at most ${flow.budget.modelCalls} model calls`,
		`${result.spend.agentSpawns} agents`,
		`${result.spend.totalTokens} tokens`,
		`${result.spend.cost.toFixed(4)} cost`,
		`${(result.elapsedMs / 1000).toFixed(1)}s of at most ${flow.budget.wallClockMs / 1000}s`,
		...(journalPath === undefined ? [] : [`journal ${journalPath}`]),
	].join(", ");
	await context.actions.publishMessage({
		kind: "markdown",
		title: `${flow.name} - ${result.status}: ${result.headline}`,
		content: `${result.body}\n\n---\n\n${spent}`,
	});
	await context.actions.publishMessage({
		kind: "table",
		title: `${flow.name} steps`,
		columns: [
			{ label: "step" },
			{ label: "kind" },
			{ label: "pass" },
			{ label: "item" },
			{ label: "detail" },
			{ label: "ms", align: "right" },
		],
		rows: result.steps.map((record) => [
			record.step,
			record.kind,
			String(record.iteration),
			record.item,
			record.detail,
			String(record.ms),
		]),
	});
}

async function finish(
	context: ExtensionContext,
	workflow: string,
	runId: string,
	status: WorkflowStatus,
	headline: string,
	result: WorkflowRunResult | undefined,
): Promise<void> {
	await context.actions.emitExtensionEvent(WORKFLOW_EVENT.finished, {
		agentId: context.agentId,
		runId,
		workflow,
		status,
		headline,
		modelCalls: result?.spend.modelCalls ?? 0,
		agentSpawns: result?.spend.agentSpawns ?? 0,
		totalTokens: result?.spend.totalTokens ?? 0,
		cost: result?.spend.cost ?? 0,
		elapsedMs: result?.elapsedMs ?? 0,
	});
}
