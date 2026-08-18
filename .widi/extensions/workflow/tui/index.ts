import type { WidiTuiExtensionApi } from "../../../../apps/widi/src/tui/extension-host/index.ts";
import { discoverFlows } from "../flow/discover.ts";
import { readFinished, readStarted, readStep, WORKFLOW_EVENT, type WorkflowFinishedPayload } from "../protocol.ts";
import { WorkflowLauncher } from "./launcher.ts";
import { WorkflowBoard } from "./run-model.ts";
import { WorkflowRunView } from "./run-view.ts";
import { WorkflowWatch } from "./watch.ts";

/**
 * The TUI half: three ways in, a view of what is happening, and no engine.
 *
 * It cannot run anything itself - it belongs to no agent - so every command
 * puts an event on the bus and waits. An RPC client sends the same events and
 * is no less of a driver for having no terminal.
 *
 * The catalog it reads directly, because discovery is file reading and both
 * halves share that code. The bus has a listing of its own for clients that
 * would otherwise have to reimplement the parser and the audit to get it.
 */
export function activateWorkflowTui(api: WidiTuiExtensionApi): void {
	const watch = new WorkflowWatch(api);
	installRunView(api);

	// "materialize", so a flow has an agent to run on even from a cold start. It
	// spawns a staged session and sends nothing, so nothing is spent to get here.
	api.registerCommand({
		kind: "action",
		agentPolicy: "materialize",
		name: "workflow",
		description: "Run a flow from the workflow directory on the current agent.",
		argumentHint: "<flow> <input>",
		requiresArgument: true,
		complete: async () =>
			(await discoverFlows()).entries.map((entry) => ({
				value: entry.name,
				description:
					entry.flow === undefined ? `unusable: ${entry.problems[0] ?? "failed its audit"}` : entry.description,
			})),
		/**
		 * A flow name on its own is not an argument the engine can resolve - it is
		 * half of one. Anything short of a known name followed by an input opens
		 * the launcher, which asks for the half that is missing; the default
		 * matcher would have opened it on the whole string as a filter instead,
		 * and `/workflow survey how does X work` would have matched nothing.
		 */
		resolveArgument: (_context, argument, candidates) => {
			const separator = argument.search(/\s/);
			const name = separator < 0 ? argument : argument.slice(0, separator);
			const input = separator < 0 ? "" : argument.slice(separator + 1).trim();
			const known = candidates.find((candidate) => candidate.value.toLowerCase() === name.toLowerCase());
			if (known === undefined || input === "") return { kind: "open-selector", query: argument };
			return { kind: "resolved", value: `${known.value} ${input}` };
		},
		selector: async (request) => new WorkflowLauncher(request, api.theme, (await discoverFlows()).entries),
		execute: async (_context, argument) => {
			const trimmed = argument.trim();
			const separator = trimmed.search(/\s/);
			if (separator < 0) throw new Error(`Say what to run it on: /workflow ${trimmed || "<flow>"} <input>`);
			const name = trimmed.slice(0, separator);
			const input = trimmed.slice(separator + 1).trim();
			if (input.length === 0) throw new Error(`Say what to run it on: /workflow ${name} <input>`);

			const finished = watch.watch(name);
			// Armed before the trigger, and kept handled even if the trigger throws:
			// the watch's own timeout would otherwise reject into nobody.
			finished.catch(() => undefined);
			await api.emitExtensionEvent(WORKFLOW_EVENT.run, { workflow: name, input });
			return describe(await finished);
		},
	});

	api.registerCommand({
		kind: "action",
		agentPolicy: "runtime",
		name: "workflows",
		description: "List the flows found in the workflow directories.",
		execute: async () => {
			const catalog = await discoverFlows();
			if (catalog.entries.length === 0) return `No flows in ${catalog.roots.join(" or ")}.`;
			return catalog.entries
				.map((entry) => {
					const price = `${entry.cost?.modelCalls ?? 0} model calls, ${entry.cost?.agentSpawns ?? 0} agents`;
					const verdict = entry.flow === undefined ? `REFUSED: ${entry.problems.join(" ")}` : `worst case ${price}`;
					return `${entry.name}  ${verdict}\n  ${entry.path}`;
				})
				.join("\n");
		},
	});

	api.registerCommand({
		kind: "action",
		agentPolicy: "active",
		name: "workflow-stop",
		description: "Stop the flow running on the current agent.",
		execute: async () => {
			await api.emitExtensionEvent(WORKFLOW_EVENT.cancel);
			return "asked the run to stop";
		},
	});
}

/**
 * The live view of a run, above the editor.
 *
 * One board for every agent, one widget for the visible one. The extension API
 * publishes widgets globally, so which agent is on screen is this half's own
 * filter - and `onVisibleAgentChanged` is what makes the bus usable from here at
 * all: every runtime emits, and only one of them is the one being looked at.
 */
function installRunView(api: WidiTuiExtensionApi): void {
	const board = new WorkflowBoard();
	const strip = api.capability("agentStrip");
	const footer = api.capability("footer");
	board.setVisible(strip?.visibleAgentId());
	if (strip !== undefined) {
		const detach = strip.onVisibleAgentChanged((agentId) => board.setVisible(agentId));
		api.onDispose(detach);
	}

	const elsewhere = (): void => {
		const count = board.elsewhere();
		if (count === 0) footer?.remove("runs");
		else footer?.set("runs", count === 1 ? "1 flow running" : `${count} flows running`);
	};

	api.onExtensionEvent(WORKFLOW_EVENT.started, (event) => {
		const started = readStarted(event.payload);
		if (started !== undefined) board.started(started);
		elsewhere();
	});
	api.onExtensionEvent(WORKFLOW_EVENT.step, (event) => {
		const step = readStep(event.payload);
		if (step !== undefined) board.step(step);
	});
	api.onExtensionEvent(WORKFLOW_EVENT.finished, (event) => {
		const finished = readFinished(event.payload);
		if (finished !== undefined) board.finished(finished);
		elsewhere();
	});

	api.setWidget("run", () => new WorkflowRunView(board, api.theme), { placement: "aboveEditor" });
	api.registerShortcut("compact", {
		defaultKeys: "alt+w",
		description: "Collapse the workflow run view to one line, or open it again",
		handler: () => {
			board.compact = !board.compact;
		},
	});
}

function describe(finished: WorkflowFinishedPayload): string {
	if (finished.status === "refused") return `refused: ${finished.headline}`;
	const spent = `${finished.modelCalls} model calls, ${finished.totalTokens} tokens, ${elapsed(finished.elapsedMs)}`;
	return `${finished.status}: ${finished.headline} (${spent})`;
}

function elapsed(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}
