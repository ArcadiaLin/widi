import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CommandEngine } from "../commands/engine.ts";
import type { WidiEditor } from "../editor.ts";
import { formatElapsed } from "../format.ts";
import type { AgentViewState, TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";
import { currentVoiceLine, type VoiceLine, type VoicePackId, voiceColumnWidth } from "../voice.ts";
import { activeAgent, maintenanceLabel } from "./common.ts";
import { operationHintKeys, resolveOperationHintDetail } from "./operation-hint.ts";

/** One full `.` `..` `...` cycle. Slower than the spinner, which at 160ms
 * turns three dots into a blur. */
const DOT_PERIOD_MS = 450;
const DOT_WIDTH = 3;
/** Gap between the three segments. */
const SEGMENT_GAP = 2;
/** How far back to look for the running tool. It is written at the end of the
 * timeline; scanning the whole thing every frame buys nothing. */
const RUNNING_TOOL_SCAN = 50;

/**
 * The line that says what is happening right now, in three segments: a voice
 * line, the facts behind it, and the keys that apply.
 *
 * The voice column is pinned to the widest line the current pack can produce.
 * Anything else and the two segments to its right shift sideways every time
 * the wording changes, which reads as the whole row twitching.
 *
 * Segments drop right to left as the terminal narrows: the keys go first (they
 * are named again under the footer for every state this line does not cover),
 * then the facts lose their subject and keep their duration, then the voice
 * itself degrades to its glyph and the dots.
 */
export class WorkingLineView implements Component {
	private readonly state: TuiApplicationState;
	private readonly engine: CommandEngine;
	private readonly editor: Pick<WidiEditor, "getText" | "isShowingAutocomplete">;

	constructor(options: {
		readonly state: TuiApplicationState;
		readonly engine: CommandEngine;
		readonly editor: Pick<WidiEditor, "getText" | "isShowingAutocomplete">;
	}) {
		this.state = options.state;
		this.engine = options.engine;
		this.editor = options.editor;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		if (!agent) return [];
		const now = Date.now();
		const line = currentVoiceLine(agent.voice, now);
		if (!line) return [];

		const voice = renderVoice(line, this.state.voicePack, now);
		const facts = renderFacts(agent, line, now);
		const hint = this.runHint();
		const keys = hint === undefined ? undefined : theme.faint(hint);

		// Text's own left padding is one column; keep one on the right so the
		// line never touches either edge.
		const usable = Math.max(1, width - 2);
		let body = voice.text;
		for (const candidate of [
			joinSegments(voice.text, facts?.full, keys),
			joinSegments(voice.text, facts?.full, undefined),
			joinSegments(voice.text, facts?.compact, undefined),
			voice.text,
			`${voice.glyph} ${dots(now)}`,
		]) {
			body = candidate;
			if (visibleWidth(candidate) <= usable) break;
		}
		// The blank row is part of this component, not of the transcript above it:
		// it is there only while this line is, so nothing is left behind when the
		// line has nothing to say.
		return ["", ` ${truncateToWidth(body, usable, "…")}`];
	}

	/** The hint only while it is about the run; every other kind stays on the
	 * hint line under the footer. */
	private runHint(): string | undefined {
		const detail = resolveOperationHintDetail({
			state: this.state,
			engine: this.engine,
			editorText: this.editor.getText(),
			editorAutocompleteVisible: this.editor.isShowingAutocomplete(),
			keys: operationHintKeys(),
		});
		return detail && (detail.kind === "run" || detail.kind === "maintenance") ? detail.text : undefined;
	}
}

function joinSegments(voice: string, facts: string | undefined, keys: string | undefined): string {
	const gap = " ".repeat(SEGMENT_GAP);
	return [voice, facts, keys].filter((part): part is string => part !== undefined && part !== "").join(gap);
}

function dots(now: number): string {
	const count = (Math.floor(now / DOT_PERIOD_MS) % DOT_WIDTH) + 1;
	return `${".".repeat(count)}${" ".repeat(DOT_WIDTH - count)}`;
}

interface RenderedVoice {
	readonly glyph: string;
	readonly text: string;
}

function renderVoice(line: VoiceLine, pack: VoicePackId, now: number): RenderedVoice {
	const paint = voiceHue(line.state);
	const glyph = theme.bold(paint(voiceGlyph(line.state)));
	// Only a state that continues gets a pulse; a moment that already passed
	// would be claiming to still be happening.
	const tail = line.state === "working" || line.state === "poked" ? dots(now) : " ".repeat(DOT_WIDTH);
	const padding = " ".repeat(Math.max(0, voiceColumnWidth(pack) - visibleWidth(line.text)));
	// Italic on the spoken line alone: it is the one part of this row that is a
	// voice rather than a fact.
	return { glyph, text: `${glyph} ${paint(theme.italic(line.text))}${padding}${paint(tail)}` };
}

function voiceGlyph(state: VoiceLine["state"]): string {
	switch (state) {
		case "done":
			return "✔";
		case "error":
			return "✕";
		case "aborted":
		case "aborted-by-human":
		case "aborted-by-extension":
			return "⊘";
		default:
			return "⚒";
	}
}

/**
 * One hue per state, carried by the glyph, the line and the pulse together, so
 * the row's color alone says how the run is going before a word is read.
 */
function voiceHue(state: VoiceLine["state"]): (text: string) => string {
	switch (state) {
		case "working":
			return theme.info;
		case "done":
			return theme.ok;
		case "error":
			return theme.error;
		case "aborted":
		case "aborted-by-human":
		case "aborted-by-extension":
		case "poked":
			return theme.warn;
		default:
			return theme.muted;
	}
}

interface RenderedFacts {
	/** Subject and duration. */
	readonly full: string;
	/** Duration alone: what survives a narrow terminal. */
	readonly compact: string;
}

/**
 * What the voice line is talking about. A running agent reports the work in
 * front of it; a run that just ended reports what it cost. Neither is the
 * voice's business, which is why they are separate segments.
 */
function renderFacts(agent: AgentViewState, line: VoiceLine, now: number): RenderedFacts | undefined {
	if (agent.status === "running" && agent.runStartedAt) {
		const elapsed = formatElapsed(now - Date.parse(agent.runStartedAt));
		const subject = agent.maintenance ? maintenanceLabel(agent.maintenance) : activeToolLabel(agent);
		return facts(subject, elapsed);
	}
	const lastRun = agent.lastRun;
	if (!lastRun) return undefined;
	const elapsed = formatElapsed(Date.parse(lastRun.endedAt) - Date.parse(lastRun.startedAt));
	switch (line.state) {
		case "done":
			return facts(lastRun.toolCount > 0 ? `${lastRun.toolCount} tools` : undefined, elapsed);
		case "aborted-by-human":
			return facts("aborted by you", elapsed);
		case "aborted-by-extension":
			return facts("aborted by an extension", elapsed);
		case "aborted":
			return facts("aborted", elapsed);
		default:
			return undefined;
	}
}

function facts(subject: string | undefined, elapsed: string): RenderedFacts {
	// The subject carries the accent the transcript gives a tool call, so the
	// same fact reads the same in both places; the duration stays quieter.
	const compact = theme.muted(elapsed);
	return { full: subject ? `${theme.accent(subject)} ${theme.faint("·")} ${compact}` : compact, compact };
}

/**
 * The tool the agent is inside, or the wait for the next assistant message.
 * Read off the timeline rather than `display.activeToolNames`, which is the set
 * of tools the agent may call, not the one it is calling.
 */
function activeToolLabel(agent: AgentViewState): string {
	const timeline = agent.timeline;
	const floor = Math.max(0, timeline.length - RUNNING_TOOL_SCAN);
	for (let index = timeline.length - 1; index >= floor; index--) {
		const item = timeline[index];
		if (item?.type === "tool-execution" && (item.status === "running" || item.status === "preparing")) {
			return item.toolName;
		}
	}
	return "thinking";
}
