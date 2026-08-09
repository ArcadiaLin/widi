import { describe, expect, it } from "vitest";
import {
	type AgentVoice,
	currentVoiceLine,
	hasLiveTransientVoice,
	rollVoiceLine,
	setSteadyVoice,
	setTransientVoice,
	VOICE_LINGER_MS,
	VOICE_PACK_IDS,
	voiceColumnWidth,
} from "../../src/tui/voice.ts";

/** Always the first candidate, so a roll is a table lookup in tests. */
const first = () => 0;

describe("voice packs", () => {
	it("has a line for every state in every pack", () => {
		for (const pack of VOICE_PACK_IDS) {
			for (const state of [
				"idle",
				"working",
				"done",
				"aborted",
				"aborted-by-human",
				"aborted-by-extension",
				"poked",
				"error",
			] as const) {
				expect(rollVoiceLine(pack, state, first)).not.toBe("");
			}
		}
	});

	it("speaks plainly when the voice is off", () => {
		expect(rollVoiceLine("off", "working", first)).toBe("Working");
		expect(rollVoiceLine("off", "done", first)).toBe("Done");
	});

	it("draws from both voices when the pack is random", () => {
		expect(rollVoiceLine("random", "done", () => 0)).toBe("Job's done.");
		// Second half of the pack list is the peasant table.
		expect(rollVoiceLine("random", "idle", () => 0.9)).toBe("Ready to work.");
	});

	it("pins the column to the longest line the pack can produce", () => {
		expect(voiceColumnWidth("off")).toBe("Working".length);
		expect(voiceColumnWidth("peon")).toBe("Me not that kind of orc!".length);
		// Random must reserve room for either voice or the column moves per roll.
		expect(voiceColumnWidth("random")).toBe(Math.max(voiceColumnWidth("peon"), voiceColumnWidth("peasant")));
	});
});

describe("voice state", () => {
	it("keeps the line it rolled while the state does not change", () => {
		const carrier: { voice?: AgentVoice } = {};
		setSteadyVoice(carrier, "peon", "working", () => 0);
		setSteadyVoice(carrier, "peon", "working", () => 0.9);

		expect(carrier.voice?.steady.text).toBe("Work work.");
	});

	it("rolls again once the state actually changes", () => {
		const carrier: { voice?: AgentVoice } = {};
		setSteadyVoice(carrier, "peon", "working", first);
		setSteadyVoice(carrier, "peon", "idle", first);

		expect(carrier.voice?.steady).toEqual({ state: "idle", text: "Yes?" });
	});

	it("shows the transient line until it expires, then the steady one", () => {
		const carrier: { voice?: AgentVoice } = {};
		setSteadyVoice(carrier, "peon", "idle", first);
		setTransientVoice(carrier, "peon", "done", 1_000, first);

		expect(currentVoiceLine(carrier.voice, 1_000)).toMatchObject({ state: "done", text: "Job's done." });
		expect(hasLiveTransientVoice(carrier.voice, 1_000)).toBe(true);
		expect(currentVoiceLine(carrier.voice, 1_000 + VOICE_LINGER_MS)).toEqual({ state: "idle", text: "Yes?" });
		expect(hasLiveTransientVoice(carrier.voice, 1_000 + VOICE_LINGER_MS)).toBe(false);
	});

	// The stop and the return to idle are two events whose order this layer does
	// not choose; the transient has to survive the steady line landing after it.
	it("keeps a transient line when the steady one lands afterwards", () => {
		const carrier: { voice?: AgentVoice } = {};
		setSteadyVoice(carrier, "peon", "working", first);
		setTransientVoice(carrier, "peon", "done", 1_000, first);
		setSteadyVoice(carrier, "peon", "idle", first);

		expect(currentVoiceLine(carrier.voice, 1_100)?.state).toBe("done");
		expect(currentVoiceLine(carrier.voice, 1_000 + VOICE_LINGER_MS)?.state).toBe("idle");
	});

	it("says nothing about an agent that never transitioned", () => {
		expect(currentVoiceLine(undefined)).toBeUndefined();
		expect(hasLiveTransientVoice(undefined)).toBe(false);
	});
});
