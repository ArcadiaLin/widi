/**
 * Bootstrap and wiring.
 *
 * The panes do not know about each other. Every one of them reads the store and
 * calls back into the one navigator defined here, so "go to record R of agent A"
 * has a single implementation - and a jump from a link chip, from a timeline
 * span, from the rail or from the keyboard all end in the same place, including
 * the history that makes them reversible.
 */

import type { RecordKind, TrajectoryBundle } from "../model/types.ts";
import { renderAgentHeader, renderAgentRail } from "./agent-panel.ts";
import { el, replace } from "./dom.ts";
import { formatCost, formatCount, formatDuration } from "./format.ts";
import { renderInspector } from "./inspector.ts";
import { Ledger } from "./ledger.ts";
import { anchorRecordId, branchOf, buildIndex, type ViewerIndex } from "./model.ts";
import { readHash, Store, type TimelineMode, type ViewState, writeHash } from "./state.ts";
import { KIND_LABEL, KIND_ORDER, TIMELINE_MODE_LABEL, Timeline } from "./timeline.ts";

const TIMELINE_MODES: readonly TimelineMode[] = ["sequence", "elapsed", "clock"];

const DATA_ELEMENT_ID = "widi-trajectory-data";

function readBundle(): TrajectoryBundle {
	const node = document.getElementById(DATA_ELEMENT_ID);
	if (node === null) throw new Error("trajectory data is missing from the page");
	return JSON.parse(node.textContent ?? "{}") as TrajectoryBundle;
}

function initialState(index: ViewerIndex): ViewState {
	const hash = readHash();
	const first = index.agents[0];
	const agentKey =
		hash.agentKey !== undefined && index.agentByKey.has(hash.agentKey) ? hash.agentKey : (first?.key ?? "");
	const agent = index.agentByKey.get(agentKey);
	const branchId =
		hash.branchId !== undefined && agent?.branches.some((branch) => branch.id === hash.branchId)
			? hash.branchId
			: (agent?.currentBranchId ?? "");
	return {
		agentKey,
		branchId,
		recordId: hash.recordId ?? null,
		query: "",
		hiddenKinds: new Set<RecordKind>(),
		errorsOnly: false,
		timelineScope: index.agents.length > 1 ? "all" : "agent",
		timelineMode: "sequence",
		// A multi-agent run is one run; opening it on a single agent's ledger hides
		// that the others exist until the reader goes looking for them.
		ledgerScope: index.agents.length > 1 ? "all" : "agent",
	};
}

function totalsOf(index: ViewerIndex): { records: number; tokens: number; cost: number; span: number } {
	let records = 0;
	let tokens = 0;
	let cost = 0;
	for (const agent of index.agents) {
		records += agent.stats.records;
		tokens += agent.stats.tokens.total;
		cost += agent.stats.tokens.cost;
	}
	return { records, tokens, cost, span: Math.max(0, index.timeEnd - index.timeStart) };
}

function mount(): void {
	const bundle = readBundle();
	const index = buildIndex(bundle);
	const store = new Store(initialState(index));

	const root = document.getElementById("app");
	if (root === null) throw new Error("#app is missing from the page");

	const rail = el("aside", { class: "rail" });
	const agentHeader = el("div", { class: "agent-header" });
	const timelineBox = el("div", { class: "timeline" });
	const ledgerBox = el("div", { class: "ledger" });
	const inspectorBox = el("aside", { class: "inspector" });
	const searchInput = el("input", {
		class: "search",
		attrs: { type: "search", placeholder: "search this agent (/)", "aria-label": "search records" },
		on: { input: (event) => store.patch({ query: (event.target as HTMLInputElement).value }) },
	});

	const history: { agentKey: string; recordId: string | null }[] = [];

	function goTo(agentKey: string, recordId?: string): void {
		const agent = index.agentByKey.get(agentKey);
		if (agent === undefined) return;
		const current = store.state;
		if (current.agentKey !== agentKey || current.recordId !== (recordId ?? null)) {
			history.push({ agentKey: current.agentKey, recordId: current.recordId });
			if (history.length > 100) history.shift();
		}
		if (agentKey !== current.agentKey) timeline.reset();
		store.patch({ agentKey, branchId: agent.currentBranchId, recordId: recordId ?? null });
	}

	function goBack(): void {
		const previous = history.pop();
		if (previous === undefined) return;
		const agent = index.agentByKey.get(previous.agentKey);
		if (agent === undefined) return;
		timeline.reset();
		store.patch({ agentKey: previous.agentKey, branchId: agent.currentBranchId, recordId: previous.recordId });
	}

	const nav = { goTo };
	const ledger = new Ledger(ledgerBox, index, store, nav);
	const timeline = new Timeline(timelineBox, index, store, {
		goTo,
		onFocusChange: (focus: ReadonlySet<string> | null) => ledger.setFocus(focus),
	});

	const kindFilters = el(
		"div",
		{ class: "filters" },
		KIND_ORDER.map((kind) =>
			el("button", {
				class: `filter kind-${kind}`,
				text: KIND_LABEL[kind],
				attrs: { type: "button", "aria-pressed": true },
				on: {
					click: (event) => {
						const hidden = new Set(store.state.hiddenKinds);
						if (hidden.has(kind)) hidden.delete(kind);
						else hidden.add(kind);
						(event.currentTarget as HTMLElement).setAttribute("aria-pressed", String(!hidden.has(kind)));
						store.patch({ hiddenKinds: hidden });
					},
				},
			}),
		),
	);

	const errorsToggle = el("button", {
		class: "filter filter-errors",
		text: "errors only",
		attrs: { type: "button", "aria-pressed": false },
		on: {
			click: (event) => {
				const next = !store.state.errorsOnly;
				(event.currentTarget as HTMLElement).setAttribute("aria-pressed", String(next));
				store.patch({ errorsOnly: next });
			},
		},
	});

	const scopeToggle = el("button", {
		class: "filter filter-scope",
		attrs: { type: "button" },
		on: {
			click: () => {
				const next = store.state.ledgerScope === "all" ? "agent" : "all";
				store.patch({ ledgerScope: next, timelineScope: next });
			},
		},
	});

	const modeButtons = TIMELINE_MODES.map((mode) =>
		el("button", {
			class: "mode",
			text: TIMELINE_MODE_LABEL[mode],
			attrs: { type: "button", "aria-pressed": false, "data-mode": mode },
			on: { click: () => store.patch({ timelineMode: mode }) },
		}),
	);
	const modePicker = el("div", { class: "modes", attrs: { role: "group", "aria-label": "timeline x axis" } }, [
		el("span", { class: "modes-label", text: "x" }),
		...modeButtons,
	]);

	const paintScope = (): void => {
		scopeToggle.textContent = store.state.ledgerScope === "all" ? "scope: all agents" : "scope: this agent";
		scopeToggle.setAttribute("aria-pressed", String(store.state.ledgerScope === "all"));
		modeButtons.forEach((button, at) => {
			button.setAttribute("aria-pressed", String(TIMELINE_MODES[at] === store.state.timelineMode));
		});
	};

	const totals = totalsOf(index);

	replace(root, [
		el("header", { class: "topbar" }, [
			el("div", { class: "topbar-title" }, [
				el("span", { class: "brand", text: "widi trajectory" }),
				el("span", { class: "mono dim", text: bundle.source.cwd }),
			]),
			el("div", { class: "topbar-stats" }, [
				el("span", { text: `${index.agents.length} agents` }),
				el("span", { text: `${totals.records} records` }),
				el("span", { text: `${formatCount(totals.tokens)} tokens` }),
				el("span", { text: formatCost(totals.cost) }),
				el("span", { text: formatDuration(totals.span) }),
			]),
			el("div", { class: "topbar-tools" }, [searchInput, kindFilters, errorsToggle, scopeToggle, modePicker]),
		]),
		bundle.diagnostics.length === 0
			? null
			: el("details", { class: "diagnostics" }, [
					el("summary", { text: `${bundle.diagnostics.length} loader diagnostic(s)` }),
					el(
						"ul",
						{},
						bundle.diagnostics.map((diagnostic) =>
							el("li", {
								class: diagnostic.severity === "error" ? "is-error" : "",
								text: `${diagnostic.code}: ${diagnostic.message}${diagnostic.agentKey === undefined ? "" : ` (${diagnostic.agentKey})`}`,
							}),
						),
					),
				]),
		el("div", { class: "body" }, [
			rail,
			el("main", { class: "main" }, [
				agentHeader,
				timelineBox,
				el("div", { class: "split" }, [ledgerBox, inspectorBox]),
			]),
		]),
	]);

	const renderAll = (): void => {
		renderAgentRail(rail, index, store, nav);
		renderAgentHeader(agentHeader, index, store, nav);
		timeline.render();
		ledger.render();
		renderInspector(inspectorBox, index, store, nav);
		paintScope();
	};

	store.subscribe((state, previous) => {
		const movedAgent = state.agentKey !== previous.agentKey || state.branchId !== previous.branchId;
		if (state.ledgerScope !== previous.ledgerScope) {
			searchInput.value = state.query;
			renderAll();
			return;
		}
		if (movedAgent) {
			searchInput.value = state.query;
			renderAgentRail(rail, index, store, nav);
			renderAgentHeader(agentHeader, index, store, nav);
			timeline.render();
			// The combined ledger already lists the agent moved to; rebuilding it
			// would throw away the reader's scroll position for no new rows.
			if (state.ledgerScope === "all") ledger.markSelection();
			else ledger.render();
			renderInspector(inspectorBox, index, store, nav);
			paintScope();
			return;
		}
		if (state.timelineScope !== previous.timelineScope) {
			timeline.render();
			paintScope();
		}
		if (state.timelineMode !== previous.timelineMode) {
			timeline.modeChanged();
			timeline.render();
			paintScope();
		}
		if (
			state.query !== previous.query ||
			state.errorsOnly !== previous.errorsOnly ||
			state.hiddenKinds !== previous.hiddenKinds
		) {
			ledger.render();
		}
		if (state.recordId !== previous.recordId) {
			ledger.markSelection();
			timeline.render();
			renderInspector(inspectorBox, index, store, nav);
		}
	});

	window.addEventListener("hashchange", () => {
		const hash = readHash();
		if (hash.agentKey === undefined || !index.agentByKey.has(hash.agentKey)) return;
		const agent = index.agentByKey.get(hash.agentKey);
		store.applyFromHash({
			agentKey: hash.agentKey,
			branchId:
				hash.branchId !== undefined && agent?.branches.some((branch) => branch.id === hash.branchId)
					? hash.branchId
					: (agent?.currentBranchId ?? ""),
			recordId: hash.recordId ?? null,
		});
	});

	document.addEventListener("keydown", (event) => {
		const target = event.target as HTMLElement | null;
		const typing =
			target !== null && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA");
		if (event.key === "/" && !typing) {
			event.preventDefault();
			searchInput.focus();
			searchInput.select();
			return;
		}
		if (event.key === "Escape") {
			if (typing) (target as HTMLInputElement).blur();
			else if (timeline.focus !== null) timeline.clearFocus();
			return;
		}
		if (typing) return;
		if (event.key === "ArrowDown" || event.key === "j") {
			event.preventDefault();
			ledger.step(1);
			return;
		}
		if (event.key === "ArrowUp" || event.key === "k") {
			event.preventDefault();
			ledger.step(-1);
			return;
		}
		if (event.key === "[" || event.key === "]") {
			event.preventDefault();
			const at = index.agents.findIndex((agent) => agent.key === store.state.agentKey);
			const next = index.agents[Math.min(index.agents.length - 1, Math.max(0, at + (event.key === "]" ? 1 : -1)))];
			if (next !== undefined) goTo(next.key);
			return;
		}
		if (event.key === "t") {
			const next = store.state.ledgerScope === "all" ? "agent" : "all";
			store.patch({ ledgerScope: next, timelineScope: next });
			return;
		}
		if (event.key === "x") {
			const at = TIMELINE_MODES.indexOf(store.state.timelineMode);
			store.patch({ timelineMode: TIMELINE_MODES[(at + 1) % TIMELINE_MODES.length] });
			return;
		}
		if (event.key === "b" || event.key === "Backspace") {
			event.preventDefault();
			goBack();
			return;
		}
		if (event.key === "f") {
			const record =
				store.state.recordId === null
					? undefined
					: index.recordsByAgent.get(store.state.agentKey)?.get(store.state.recordId);
			const link = record?.link;
			const followed = link?.targets.find((candidate) => candidate.agentKey !== null)?.agentKey;
			if (record !== undefined && link !== undefined && followed != null) {
				goTo(followed, anchorRecordId(index, followed, link.kind, link.direction, record.startedAt));
			}
		}
	});

	// A record named by the hash may sit on a branch other than the current one;
	// showing it means switching to the branch that has it.
	const selected = store.state.recordId;
	if (selected !== null) {
		const agent = index.agentByKey.get(store.state.agentKey);
		const branch = agent === undefined ? undefined : branchOf(agent, store.state.branchId);
		if (agent !== undefined && branch !== undefined && !branch.rows.some((row) => row.recordId === selected)) {
			const owning = agent.branches.find((candidate) => candidate.rows.some((row) => row.recordId === selected));
			if (owning !== undefined) store.patch({ branchId: owning.id });
		}
	}

	renderAll();
	writeHash(store.state);
}

mount();
