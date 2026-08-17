/**
 * View state, and the URL that names it.
 *
 * Which agent, which branch, which record - that triple is the whole address of
 * a place in a run, so it lives in the hash. A trajectory is a thing people
 * point each other at, and "look at record 214 of the research agent" has to
 * survive being copied out of the address bar.
 *
 * Filters stay out of the hash: they describe how someone is reading, not what
 * they are looking at, and putting them in the link would make every shared
 * address carry a stranger's search box.
 */

import type { RecordKind } from "../model/types.ts";

/** Horizontal projection of the timeline; see the note in `timeline.ts`. */
export type TimelineMode = "sequence" | "elapsed" | "clock";

export interface ViewState {
	agentKey: string;
	branchId: string;
	recordId: string | null;
	query: string;
	hiddenKinds: Set<RecordKind>;
	errorsOnly: boolean;
	timelineScope: "agent" | "all";
	timelineMode: TimelineMode;
	/** Whether the ledger interleaves every agent or lists only the current one. */
	ledgerScope: "agent" | "all";
}

export type Listener = (state: ViewState, previous: ViewState) => void;

export class Store {
	private _state: ViewState;
	private readonly _listeners: Listener[] = [];
	private _applyingHash = false;

	constructor(initial: ViewState) {
		this._state = initial;
	}

	get state(): ViewState {
		return this._state;
	}

	subscribe(listener: Listener): void {
		this._listeners.push(listener);
	}

	patch(change: Partial<ViewState>): void {
		const previous = this._state;
		const next = { ...previous, ...change };
		if (
			next.agentKey === previous.agentKey &&
			next.branchId === previous.branchId &&
			next.recordId === previous.recordId &&
			next.query === previous.query &&
			next.errorsOnly === previous.errorsOnly &&
			next.timelineScope === previous.timelineScope &&
			next.timelineMode === previous.timelineMode &&
			next.ledgerScope === previous.ledgerScope &&
			next.hiddenKinds === previous.hiddenKinds
		) {
			return;
		}
		this._state = next;
		if (!this._applyingHash) writeHash(next);
		for (const listener of this._listeners) listener(next, previous);
	}

	/** Apply an external hash change without writing it back. */
	applyFromHash(change: Partial<ViewState>): void {
		this._applyingHash = true;
		try {
			this.patch(change);
		} finally {
			this._applyingHash = false;
		}
	}
}

export function writeHash(state: ViewState): void {
	const parts = [`a=${encodeURIComponent(state.agentKey)}`, `b=${encodeURIComponent(state.branchId)}`];
	if (state.recordId !== null) parts.push(`r=${encodeURIComponent(state.recordId)}`);
	const hash = `#${parts.join("&")}`;
	if (window.location.hash !== hash) {
		window.history.replaceState(null, "", hash);
	}
}

export function readHash(): { agentKey?: string; branchId?: string; recordId?: string } {
	const hash = window.location.hash.replace(/^#/, "");
	if (hash === "") return {};
	const params = new URLSearchParams(hash);
	const agentKey = params.get("a") ?? undefined;
	const branchId = params.get("b") ?? undefined;
	const recordId = params.get("r") ?? undefined;
	return {
		...(agentKey === undefined ? undefined : { agentKey }),
		...(branchId === undefined ? undefined : { branchId }),
		...(recordId === undefined ? undefined : { recordId }),
	};
}
