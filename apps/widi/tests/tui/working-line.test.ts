import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { builtInCommands } from "../../src/tui/commands/built-ins.ts";
import { CommandEngine } from "../../src/tui/commands/engine.ts";
import { WorkingLineView } from "../../src/tui/components/working-line.ts";
import { createWidiKeybindings } from "../../src/tui/keybindings.ts";
import {
	type AgentViewState,
	createTuiApplicationState,
	setActiveAgent,
	type TuiApplicationState,
} from "../../src/tui/state.ts";
import { setSteadyVoice, setTransientVoice } from "../../src/tui/voice.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const engine = new CommandEngine(builtInCommands);
const editor = { getText: () => "", isShowingAutocomplete: () => false };

function render(state: TuiApplicationState, width = 120): string {
	return new WorkingLineView({ state, engine, editor }).render(width).join("\n").replace(ANSI_SEQUENCE, "");
}

function running(state: TuiApplicationState, startedMsAgo = 72_000): AgentViewState {
	const agent = setActiveAgent(state, "main");
	agent.status = "running";
	agent.runStartedAt = new Date(Date.now() - startedMsAgo).toISOString();
	setSteadyVoice(agent, state.voicePack, "working", () => 0);
	return agent;
}

beforeEach(() => {
	setKeybindings(createWidiKeybindings());
});

describe("WorkingLineView", () => {
	it("says nothing about an agent that has not transitioned yet", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main");

		expect(new WorkingLineView({ state, engine, editor }).render(120)).toEqual([]);
	});

	// The spacer belongs to this component so it disappears with the line; a
	// blank row left behind by a silent working line is just a hole.
	it("keeps a blank row between itself and the transcript", () => {
		const state = createTuiApplicationState();
		running(state);

		const lines = new WorkingLineView({ state, engine, editor }).render(120);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("");
	});

	it("reports the voice, the run and the keys that apply", () => {
		const state = createTuiApplicationState();
		const agent = running(state);
		agent.timeline.push({
			type: "tool-execution",
			id: "call-1",
			toolCallId: "call-1",
			durability: "durable",
			createdAt: new Date().toISOString(),
			startedAt: new Date().toISOString(),
			toolName: "Bash",
			status: "running",
		});

		const line = render(state);

		expect(line).toContain("Work work.");
		expect(line).toContain("Bash · 1m12s");
		expect(line).toContain("Esc abort");
	});

	it("waits on the model when no tool is running", () => {
		const state = createTuiApplicationState();
		running(state, 8_000);

		expect(render(state)).toContain("thinking · 8s");
	});

	it("names the maintenance phase instead of a tool", () => {
		const state = createTuiApplicationState();
		const agent = running(state, 3_000);
		agent.maintenance = "compaction";

		const line = render(state);

		expect(line).toContain("Compacting · 3s");
		expect(line).toContain("queue follow-up");
		expect(line).not.toContain("abort");
	});

	it("reports what the finished run cost", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.status = "idle";
		agent.lastRun = { startedAt: new Date(0).toISOString(), endedAt: new Date(108_000).toISOString(), toolCount: 3 };
		setTransientVoice(agent, state.voicePack, "done", Date.now(), () => 0);

		const line = render(state);

		expect(line).toContain("✔");
		expect(line).toContain("Job's done.");
		expect(line).toContain("3 tools · 1m48s");
	});

	it("says who stopped the run", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.status = "idle";
		agent.lastRun = { startedAt: new Date(0).toISOString(), endedAt: new Date(4_000).toISOString(), toolCount: 0 };

		setTransientVoice(agent, state.voicePack, "aborted-by-human", Date.now(), () => 0);
		expect(render(state)).toContain("aborted by you · 4s");

		setTransientVoice(agent, state.voicePack, "aborted-by-extension", Date.now(), () => 0);
		expect(render(state)).toContain("aborted by an extension · 4s");
	});

	// The whole point of pinning the column: the two segments to its right must
	// land in the same place whatever the voice happens to be saying.
	it("keeps the segments after the voice from moving", () => {
		const state = createTuiApplicationState();
		const agent = running(state, 5_000);

		setSteadyVoice(agent, state.voicePack, "idle", () => 0);
		const short = render(state).indexOf("5s");
		agent.voice = undefined;
		setSteadyVoice(agent, state.voicePack, "working", () => 0.4);
		const other = render(state).indexOf("5s");

		expect(short).toBeGreaterThan(0);
		expect(other).toBe(short);
	});

	it("drops the keys first, then the subject, as the terminal narrows", () => {
		const state = createTuiApplicationState();
		running(state, 5_000);

		expect(render(state, 120)).toContain("Esc abort");
		const narrow = render(state, 46);
		expect(narrow).not.toContain("Esc abort");
		expect(narrow).toContain("thinking · 5s");
		const narrower = render(state, 36);
		expect(narrower).not.toContain("thinking");
		expect(narrower).toContain("5s");
	});

	it("stays inside the terminal width", () => {
		const state = createTuiApplicationState();
		running(state);

		for (const width of [20, 40, 80, 120]) {
			for (const line of new WorkingLineView({ state, engine, editor }).render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
