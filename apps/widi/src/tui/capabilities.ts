/**
 * The control surfaces the application publishes for other runtimes.
 *
 * The layout registry answers "what is on screen and where"; this answers "what
 * can be done to it". They are two tables on purpose - the command engine and
 * the theme are capabilities with no slot, and a decorative widget is a slot
 * with no capability - but where both exist they share one key, so the name an
 * extension wraps is the name it controls.
 *
 * What goes in a capability is product vocabulary, never an internal method
 * promoted to public. `application.ts` has thirty-odd private methods and most
 * of them are paint bookkeeping (`updateEditorAvailability`,
 * `expireNotification`); publishing those would make every refactor a breaking
 * change and leave extension authors unable to tell a capability from an
 * implementation detail. A capability is written by hand, one layer above.
 *
 * **Writes are deferred, reads are not.** Every mutating method schedules its
 * effect for after the current frame, so a capability call from inside a
 * component's render can never re-enter the paint it was called from. This is
 * why there is no "you may not call this during render" rule to learn: the
 * shape makes the hazard unreachable instead of reporting it.
 */

import type { CandidateItem } from "../core/types.ts";
import type { CommandView } from "./commands/types.ts";
import type { AgentViewStatus } from "./state.ts";

/** Text access to the editor. Submitting is deliberately absent - see below. */
export interface EditorCapability {
	getText(): string;
	/**
	 * Replace the draft. Deferred to after the current frame.
	 *
	 * There is no submit. Not because an extension cannot be trusted with one,
	 * but because of attribution: a submitted draft lands on the branch as a
	 * human message, and it would not be one. `stage` is the designed answer -
	 * the extension puts the words up, the human reads them, may rewrite them,
	 * and presses enter themselves, and the entry records both facts.
	 */
	setText(text: string): void;
	/** Insert at the cursor, keeping the rest of the draft. Deferred. */
	insertAtCursor(text: string): void;
	/** Drop the draft. Deferred. */
	clear(): void;
}

/** What `CommandsCapability.run` did with the input. */
export type CommandRunOutcome =
	| { readonly kind: "executed"; readonly name: string; readonly value: unknown; readonly display?: string }
	| { readonly kind: "failed"; readonly name: string; readonly error: string }
	/**
	 * A prompt command ran and produced text. It is handed back rather than
	 * sent, for the same reason the editor has no submit: the message would land
	 * on the branch as the human's. Put it in the editor and let them press
	 * enter.
	 */
	| { readonly kind: "expanded"; readonly text: string }
	/**
	 * The command wants an argument it was not given. The candidates are the
	 * ones the picker would have shown; choose one and run the command again
	 * with it. Nothing was opened on screen.
	 */
	| { readonly kind: "needs-argument"; readonly name: string; readonly candidates: readonly CandidateItem[] }
	| { readonly kind: "not-a-command" };

/** The command engine, as an extension sees it. */
export interface CommandsCapability {
	/** Every registered command, availability computed against the visible agent. */
	list(): readonly CommandView[];
	/**
	 * Run `/name argument` against the visible agent. Deferred to after the
	 * current frame; the promise settles when the command does.
	 *
	 * A command runs with the same transcript trace a typed one leaves, and
	 * commands that switch agents switch this one too. What it will not do is
	 * materialize a pending agent or send anything to the model.
	 */
	run(input: string): Promise<CommandRunOutcome>;
}

/** Who a scoped capability attributes its writes to when nobody said. */
export const APPLICATION_CALLER = "widi";

/** One row of the agent strip. */
export interface AgentBrief {
	readonly agentId: string;
	readonly label: string;
	/** 0 for a top-level agent, +1 per spawn generation below it. */
	readonly depth: number;
	readonly status: AgentViewStatus;
	/** The agent whose tool spawned this one; unset for user-side spawns. */
	readonly spawnedBy?: string;
	readonly unreadCount: number;
}

/**
 * The agent strip: which agents exist, which one the transcript is showing,
 * and how to change that.
 *
 * There is no spawn. Creating an agent is core's, and a TUI half that wants
 * one asks its core half to spawn it - the strip picks the new agent up from
 * the runtime event either way, and `switchTo` brings it on screen. A second
 * spawn path here would only be a copy of the pending-session state machine
 * that drifts from it.
 */
export interface AgentStripCapability {
	/** Every live agent in strip order: each one followed by its subtree. */
	list(): readonly AgentBrief[];
	/** The agent the transcript is showing; undefined while a session is pending. */
	visibleAgentId(): string | undefined;
	/** Bring an agent on screen. Deferred to after the current frame. */
	switchTo(agentId: string): void;
	/**
	 * Close an agent, leaving its session file behind, and move on to a
	 * sensible neighbour. Deferred; the promise settles once it is gone.
	 */
	dispose(agentId: string): Promise<void>;
	/**
	 * Fires whenever the visible agent changes, with the new one (undefined
	 * while a session is pending). Returns the detach.
	 *
	 * This is what makes the event bus usable from a TUI half: an envelope
	 * carries the agent it came from, and a core half that lives in every agent
	 * emits from all of them at once. Knowing which one is on screen is how the
	 * TUI half tells its own instance's traffic from the rest.
	 */
	onVisibleAgentChanged(listener: (agentId: string | undefined) => void): () => void;
}

/**
 * Rows in an agent's transcript.
 *
 * Ephemeral is the whole surface, and that is a boundary rather than a
 * shortcoming. A durable entry is one the model reads on every resume and
 * every fork inherits; putting one there is a decision about the branch, the
 * branch belongs to core, and the way to it is the core half's
 * `publishMessage`. What is left here is what the terminal is for: saying
 * something to the person looking at it.
 */
export interface ChatCapability {
	/**
	 * Add a row, or replace the one already under this id. The id is namespaced
	 * to the caller, so two extensions cannot overwrite each other. Defaults to
	 * the visible agent. Deferred to after the current frame.
	 */
	insert(id: string, text: string, options?: { readonly agentId?: string }): void;
	/** Remove a row this caller inserted. Deferred; an unknown id does nothing. */
	remove(id: string, options?: { readonly agentId?: string }): void;
}

/** The notice area above the transcript. */
export interface NoticesCapability {
	/**
	 * Post a notice, or replace the one already under this id. Notices expire on
	 * their own; pass `ttlMs: 0` for one that stays until it is dismissed.
	 * Deferred to after the current frame.
	 */
	post(id: string, text: string, options?: { readonly ttlMs?: number }): void;
	/** Take a notice down early. Deferred; an unknown id does nothing. */
	dismiss(id: string): void;
}

/**
 * The built-in capability keys and what each one hands back.
 *
 * Extensions may publish nothing here: the map is the application's own
 * vocabulary, and a key outside it reads back as `unknown` so the caller has to
 * narrow it themselves rather than assert a shape nobody promised.
 */
export interface TuiCapabilityMap {
	readonly editor: EditorCapability;
	readonly commands: CommandsCapability;
	readonly agentStrip: AgentStripCapability;
	readonly chat: ChatCapability;
	readonly notices: NoticesCapability;
}

export type TuiCapabilityKey = keyof TuiCapabilityMap;

/**
 * The published set. One instance per application; the application fills it
 * during construction and never removes an entry, so a capability held from
 * activation stays valid for the life of the process.
 */
export class TuiCapabilityRegistry {
	private readonly published = new Map<string, object>();
	private readonly binders = new Map<string, (caller: string) => object>();
	private readonly bound = new Map<string, object>();

	publish<TKey extends TuiCapabilityKey>(key: TKey, capability: TuiCapabilityMap[TKey]): void {
		this.published.set(key, capability);
	}

	/**
	 * Publish a capability whose writes carry the caller's name - a transcript
	 * row and a notice both say who put them there, and asking the caller to
	 * pass its own id would make that a claim rather than a fact. One instance
	 * per caller, so a handle held from activation keeps working.
	 */
	publishScoped<TKey extends TuiCapabilityKey>(key: TKey, bind: (caller: string) => TuiCapabilityMap[TKey]): void {
		this.binders.set(key, bind);
	}

	get<TKey extends TuiCapabilityKey>(key: TKey, caller?: string): TuiCapabilityMap[TKey] | undefined;
	get(key: string, caller?: string): unknown;
	get(key: string, caller = APPLICATION_CALLER): unknown {
		const bind = this.binders.get(key);
		if (!bind) return this.published.get(key);
		const boundKey = `${key} ${caller}`;
		const existing = this.bound.get(boundKey);
		if (existing) return existing;
		const capability = bind(caller);
		this.bound.set(boundKey, capability);
		return capability;
	}

	/** Published keys, for `/layout` and the drill coverage ledger. */
	keys(): readonly string[] {
		return [...this.published.keys(), ...this.binders.keys()];
	}
}
