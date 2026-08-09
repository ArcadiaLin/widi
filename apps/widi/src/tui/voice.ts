import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * What the working line is reporting. Not the agent's status: several of these
 * are moments rather than states, and they are what the line is for - a run
 * that ended is worth a beat of its own before the line settles back to idle.
 */
export type VoiceState =
	| "idle"
	| "working"
	| "done"
	| "aborted"
	| "aborted-by-human"
	| "aborted-by-extension"
	| "poked"
	| "error";

export type VoicePackId = "off" | "peon" | "peasant" | "random";

export const VOICE_PACK_IDS: readonly VoicePackId[] = ["off", "peon", "peasant", "random"];

/** States that pass rather than hold, and how long the line keeps saying them. */
export const VOICE_LINGER_MS = 2_500;

/**
 * One line per state, or several to pick between. A pack is a table and
 * nothing else, so a voice pack shipped by an extension one day is the same
 * shape as these two.
 */
type VoicePack = Readonly<Record<VoiceState, readonly string[]>>;

const OFF: VoicePack = {
	idle: ["Ready"],
	working: ["Working"],
	done: ["Done"],
	aborted: ["Stopped"],
	"aborted-by-human": ["Stopped"],
	"aborted-by-extension": ["Stopped"],
	poked: ["Working"],
	error: ["Failed"],
};

const PEON: VoicePack = {
	idle: ["Yes?", "Something need doing?", "Ready to work.", "What you want?"],
	working: ["Work work.", "Zug zug.", "Okey dokey.", "Be happy to."],
	done: ["Job's done."],
	aborted: ["Me stop."],
	"aborted-by-human": ["Okay, okay!"],
	"aborted-by-extension": ["Something stop me."],
	poked: ["Stop poking me!"],
	error: ["Me not that kind of orc!"],
};

const PEASANT: VoicePack = {
	idle: ["Yes, milord?", "What is it?", "More work?", "Ready to work."],
	working: ["Right-o.", "Off I go, then!", "Yes, milord.", "As you wish."],
	done: ["Job's done."],
	aborted: ["I've stopped, milord."],
	"aborted-by-human": ["As you wish, milord."],
	"aborted-by-extension": ["I've been called off."],
	poked: ["I'm going, I'm going!"],
	error: ["That's beyond me, milord."],
};

const PACKS: Readonly<Record<Exclude<VoicePackId, "random">, VoicePack>> = { off: OFF, peon: PEON, peasant: PEASANT };

/** Packs a setting can actually roll from; "random" draws from both voices. */
function packsFor(pack: VoicePackId): readonly VoicePack[] {
	if (pack === "random") return [PEON, PEASANT];
	return [PACKS[pack]];
}

export interface VoiceLine {
	readonly state: VoiceState;
	readonly text: string;
}

/**
 * The steady line plus, when something just happened, the line saying so.
 *
 * Two slots rather than one because the two arrive independently: a run ending
 * publishes both the stop and the return to idle, in an order this layer does
 * not get to choose, and the transient must survive the steady line landing
 * either side of it.
 */
export interface AgentVoice {
	steady: VoiceLine;
	transient?: VoiceLine & { readonly expiresAt: number };
}

/** A voice holder, kept structural so state.ts stays out of this module. */
interface VoiceCarrier {
	voice?: AgentVoice;
}

export function rollVoiceLine(pack: VoicePackId, state: VoiceState, random: () => number = Math.random): string {
	const packs = packsFor(pack);
	const lines = packs[Math.floor(random() * packs.length)]?.[state] ?? OFF[state];
	return lines[Math.floor(random() * lines.length)] ?? OFF[state][0];
}

/**
 * The line the agent holds while nothing is happening to it. Re-entering a
 * state it is already in keeps the line it already rolled: rolling per event
 * would reword the same situation every time anything touched the agent.
 */
export function setSteadyVoice(
	carrier: VoiceCarrier,
	pack: VoicePackId,
	state: VoiceState,
	random?: () => number,
): void {
	if (carrier.voice?.steady.state === state) return;
	const steady = { state, text: rollVoiceLine(pack, state, random) };
	carrier.voice = carrier.voice ? { ...carrier.voice, steady } : { steady };
}

/** A line for something that just happened, shown for VOICE_LINGER_MS. */
export function setTransientVoice(
	carrier: VoiceCarrier,
	pack: VoicePackId,
	state: VoiceState,
	at: number = Date.now(),
	random?: () => number,
): void {
	const transient = { state, text: rollVoiceLine(pack, state, random), expiresAt: at + VOICE_LINGER_MS };
	carrier.voice = carrier.voice ? { ...carrier.voice, transient } : { steady: transient, transient };
}

/** What the line says now: the unexpired transient, else the steady line. */
export function currentVoiceLine(voice: AgentVoice | undefined, at: number = Date.now()): VoiceLine | undefined {
	if (!voice) return undefined;
	if (voice.transient && at < voice.transient.expiresAt) return voice.transient;
	return voice.steady;
}

export function hasLiveTransientVoice(voice: AgentVoice | undefined, at: number = Date.now()): boolean {
	return voice?.transient !== undefined && at < voice.transient.expiresAt;
}

/**
 * Width the voice column is pinned to: the longest line the current setting
 * can produce. Without this the two segments to its right jump sideways every
 * time the line changes, which is the one way this row is easy to ruin.
 */
export function voiceColumnWidth(pack: VoicePackId): number {
	let widest = 0;
	for (const table of packsFor(pack)) {
		for (const lines of Object.values(table)) {
			for (const line of lines) widest = Math.max(widest, visibleWidth(line));
		}
	}
	return widest;
}
