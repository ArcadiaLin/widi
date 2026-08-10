import { describe, expect, it } from "vitest";
import { type EditorCapability, TuiCapabilityRegistry } from "../../src/tui/capabilities.ts";

function editorCapability(state: { text: string }): EditorCapability {
	return {
		getText: () => state.text,
		setText: (text) => {
			state.text = text;
		},
		insertAtCursor: (text) => {
			state.text += text;
		},
		clear: () => {
			state.text = "";
		},
	};
}

describe("TuiCapabilityRegistry", () => {
	it("hands back what was published under a key", () => {
		const registry = new TuiCapabilityRegistry();
		const state = { text: "draft" };
		registry.publish("editor", editorCapability(state));

		const editor = registry.get("editor");

		expect(editor?.getText()).toBe("draft");
		editor?.setText("rewritten");
		expect(state.text).toBe("rewritten");
	});

	// An extension asking for a key nobody publishes is the normal case, not an
	// error: the application it is running against may simply be older.
	it("misses quietly on an unpublished key", () => {
		const registry = new TuiCapabilityRegistry();

		expect(registry.get("editor")).toBeUndefined();
		expect(registry.get("nothing-here")).toBeUndefined();
		expect(registry.keys()).toEqual([]);
	});

	it("lists what it published, for /layout and the drill ledger", () => {
		const registry = new TuiCapabilityRegistry();
		registry.publish("editor", editorCapability({ text: "" }));

		expect(registry.keys()).toEqual(["editor"]);
	});
});
