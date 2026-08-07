import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type LayoutSlotEntry, LayoutSlots } from "../../src/tui/layout/slots.ts";
import { createTuiApplicationState } from "../../src/tui/state.ts";

function stubComponent(lines: string[] = ["line"]): Component {
	return { render: () => lines, invalidate: () => {} };
}

function entry(key: string, overrides: Partial<LayoutSlotEntry> = {}): LayoutSlotEntry {
	return { key, slot: "aboveEditor", scope: "global", factory: () => stubComponent([key]), ...overrides };
}

describe("LayoutSlots", () => {
	it("keeps entries in registration order", () => {
		const slots = new LayoutSlots();
		slots.register(entry("first"));
		slots.register(entry("second"));
		slots.register(entry("third"));

		expect(slots.entries().map((registered) => registered.key)).toEqual(["first", "second", "third"]);
	});

	it("refuses a duplicate key with a diagnostic and keeps the first entry", () => {
		const slots = new LayoutSlots();
		const first = entry("taken", { slot: "header" });
		expect(slots.register(first)).toBeUndefined();

		const diagnostic = slots.register(entry("taken", { slot: "footer" }));

		expect(diagnostic).toMatchObject({ severity: "warning", code: "layout.slot_conflict" });
		expect(slots.entries()).toHaveLength(1);
		expect(slots.entries()[0]).toBe(first);
	});

	it("unregisters by key", () => {
		const slots = new LayoutSlots();
		slots.register(entry("first"));
		slots.register(entry("second"));

		expect(slots.unregister("first")).toBe(true);
		expect(slots.unregister("first")).toBe(false);
		expect(slots.entries().map((registered) => registered.key)).toEqual(["second"]);
	});

	it("mounts instantiated components in registration order", () => {
		const slots = new LayoutSlots();
		slots.register(entry("header", { slot: "header" }));
		slots.register(entry("footer", { slot: "footer" }));
		const mounted: Component[] = [];

		slots.mount({ addChild: (component) => mounted.push(component) }, createTuiApplicationState());

		expect(mounted.map((component) => component.render(80))).toEqual([["header"], ["footer"]]);
	});

	it("gates a visible? entry per render from current state", () => {
		const state = createTuiApplicationState();
		const slots = new LayoutSlots();
		slots.register(entry("gated", { visible: (current) => current.toolOutputExpanded }));
		const mounted: Component[] = [];
		slots.mount({ addChild: (component) => mounted.push(component) }, state);
		const gated = mounted[0];
		if (!gated) throw new Error("Expected the gated entry to be mounted.");

		expect(gated.render(80)).toEqual([]);
		state.toolOutputExpanded = true;
		expect(gated.render(80)).toEqual(["gated"]);
		state.toolOutputExpanded = false;
		expect(gated.render(80)).toEqual([]);
	});
});
