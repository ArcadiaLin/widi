import { type Component, isFocusable } from "@earendil-works/pi-tui";
import type { OrchestratorDiagnostic } from "../../core/diagnostics.ts";
import type { TuiApplicationState } from "../state.ts";

/**
 * Named positions in the application layout (parity §4.2). "chat" and "editor"
 * go beyond the plan's eight extension-facing slots so the whole mounted
 * sequence lives in one ordered registry; the fixed anchors stay registered
 * entries like everything else.
 */
export type LayoutSlot =
	| "header"
	| "notices"
	| "chat"
	| "status"
	| "aboveEditor"
	| "jobsPanel"
	| "editor"
	| "belowEditor"
	| "footer"
	| "agentStrip";

export interface LayoutSlotEntry {
	/** Unique within the registry; the handle for unregister(). */
	readonly key: string;
	readonly slot: LayoutSlot;
	readonly factory: () => Component;
	/**
	 * Parity §4.2 also defines an "agent" scope (render only while that agent
	 * is visible). No consumer exists yet, so only "global" is implemented;
	 * per-agent visibility is expressible through visible? in the meantime.
	 */
	readonly scope: "global";
	/** Per-render visibility gate; entries without it self-gate in render(). */
	visible?(state: TuiApplicationState): boolean;
}

/**
 * Ordered registry of layout entries. Registration order is render order:
 * mount() adds the instantiated components to the host top to bottom exactly
 * as registered, so the registry is a drop-in replacement for the hardcoded
 * addChild sequence it replaces. Built-in views register through the same
 * path extension widgets will use.
 */
export class LayoutSlots {
	private readonly registrations: LayoutSlotEntry[] = [];

	/**
	 * Add an entry at runtime. A taken key is a conflict: the registration is
	 * refused and reported, never a silent override (same rule as the command
	 * engine). The caller surfaces the returned diagnostic.
	 */
	register(entry: LayoutSlotEntry): OrchestratorDiagnostic | undefined {
		if (this.registrations.some((existing) => existing.key === entry.key)) {
			return {
				severity: "warning",
				code: "layout.slot_conflict",
				message: `Layout entry "${entry.key}" is already registered; the new registration was refused.`,
			};
		}
		this.registrations.push(entry);
		return undefined;
	}

	/** Remove an entry by key; returns whether one was registered. */
	unregister(key: string): boolean {
		const index = this.registrations.findIndex((entry) => entry.key === key);
		if (index < 0) return false;
		this.registrations.splice(index, 1);
		return true;
	}

	/** Ordered snapshot of the registered entries. */
	entries(): readonly LayoutSlotEntry[] {
		return [...this.registrations];
	}

	/**
	 * Instantiate every entry in order and mount it into the host. An entry
	 * with a visible? predicate is wrapped in a gate that re-evaluates the
	 * predicate on every render, so state-driven visibility needs no event
	 * subscription of its own.
	 */
	mount(host: { addChild(component: Component): void }, state: TuiApplicationState): void {
		for (const entry of this.registrations) {
			const component = entry.factory();
			host.addChild(entry.visible ? new SlotVisibilityGate(component, entry.visible, state) : component);
		}
	}
}

/**
 * Re-evaluates an entry's visible? predicate per render around a stable child
 * identity. A hidden gated component must not be a focus target: the gate
 * still forwards input and focus to the child, so hiding a focused component
 * is the registrant's bug to avoid.
 */
class SlotVisibilityGate implements Component {
	private readonly inner: Component;
	private readonly visible: (state: TuiApplicationState) => boolean;
	private readonly state: TuiApplicationState;

	constructor(inner: Component, visible: (state: TuiApplicationState) => boolean, state: TuiApplicationState) {
		this.inner = inner;
		this.visible = visible;
		this.state = state;
	}

	get focused(): boolean {
		return isFocusable(this.inner) ? this.inner.focused : false;
	}

	set focused(value: boolean) {
		if (isFocusable(this.inner)) this.inner.focused = value;
	}

	handleInput(data: string): void {
		this.inner.handleInput?.(data);
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	render(width: number): string[] {
		return this.visible(this.state) ? this.inner.render(width) : [];
	}
}
