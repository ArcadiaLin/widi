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

/**
 * The built-in capability keys and what each one hands back.
 *
 * Extensions may publish nothing here: the map is the application's own
 * vocabulary, and a key outside it reads back as `unknown` so the caller has to
 * narrow it themselves rather than assert a shape nobody promised.
 */
export interface TuiCapabilityMap {
	readonly editor: EditorCapability;
}

export type TuiCapabilityKey = keyof TuiCapabilityMap;

/**
 * The published set. One instance per application; the application fills it
 * during construction and never removes an entry, so a capability held from
 * activation stays valid for the life of the process.
 */
export class TuiCapabilityRegistry {
	private readonly published = new Map<string, object>();

	publish<TKey extends TuiCapabilityKey>(key: TKey, capability: TuiCapabilityMap[TKey]): void {
		this.published.set(key, capability);
	}

	get<TKey extends TuiCapabilityKey>(key: TKey): TuiCapabilityMap[TKey] | undefined;
	get(key: string): unknown;
	get(key: string): unknown {
		return this.published.get(key);
	}

	/** Published keys, for `/layout` and the drill coverage ledger. */
	keys(): readonly string[] {
		return [...this.published.keys()];
	}
}
