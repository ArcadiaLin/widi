/**
 * Recaps: what a branch is owed when the runtime that wrote it is gone.
 *
 * A resume rebuilds a conversation out of a session file, and some of what that
 * conversation believes was true only of the process that ended. Nobody is going
 * to correct those beliefs on their own: the model reads its branch, sees a
 * promise the runtime made it, and goes on waiting for something no longer
 * coming. A recap is the runtime saying so, on the branch, before the agent is
 * routable.
 *
 * Not every stale belief needs one. A branch that names an agent it spawned is
 * left alone, because that name still resolves: `send_message` reopens the
 * agent's session when nothing is running under it, so the conversation is
 * corrected by acting on it rather than by being told. What is left here are the
 * beliefs nothing can act on, where the fact has to arrive as a fact.
 *
 * Two rules make it one mechanism rather than a family of special cases:
 *
 * - **The branch is the question.** What is owed is derived from the entries the
 *   conversation actually carries, never from what this process happens to
 *   remember or from what is on disk beside the session. Those answer "what
 *   ran"; the branch answers "what does this conversation still believe".
 * - **The recap is its own record.** The entry it lands as names the subjects it
 *   covered, so the next resume of the same branch reads them back and stays
 *   silent. Nothing else marks it - a separate ledger entry would be a second
 *   write to keep in step with the first.
 *
 * The one recap not defined here is `carried_over_jobs` in
 * `background/background.ts`. It is the same kind of message but its subjects
 * are closed by records of their own, so its mark is those records and it needs
 * no ids.
 */

import type { SessionTreeEntry } from "@widi/agent-core";
import type { BackgroundJobStartedDetails } from "./background/index.ts";
import { formatInterruptedBackgroundJobResultText } from "./background/index.ts";
import { recapEntryIds } from "./message.ts";
import { ORCHESTRATOR_MESSAGE_CUSTOM_TYPE } from "./session-manager.ts";

/** One thing a branch is owed a word about. */
export interface RecapSubject {
	/**
	 * How this subject is named on the branch, and the whole of what makes the
	 * recap idempotent: a tool call id, say. It has to be stable across runtimes,
	 * because the run that reads it back is never the one that wrote it.
	 */
	readonly id: string;
	/** What the model reads about this subject alone. */
	readonly text: string;
}

/**
 * One kind of recap: what to look for on a branch, and how to say it.
 *
 * `collect` reports every subject the branch shows, including ones already
 * recapped - filtering those is {@link selectOwedRecap}'s job and belongs to the
 * mechanism, not to each definition.
 */
export interface RecapDefinition {
	/** The recap's name, recorded on the entry and matched when reading it back. */
	readonly recap: string;
	readonly collect: (entries: readonly SessionTreeEntry[]) => readonly RecapSubject[];
	readonly render: (subjects: readonly RecapSubject[]) => string;
}

/** What a recap would say, or nothing when the branch is already up to date. */
export interface OwedRecap {
	readonly body: string;
	readonly ids: readonly string[];
}

export const ORPHANED_JOB_HANDLES_RECAP = "orphaned_job_handles";

/**
 * Read a branch for what this recap still owes it.
 *
 * The two halves are deliberately separate: a definition says what the branch
 * shows, and this says what of it has already been said. A definition that
 * filtered its own subjects would have to know how recaps are recorded, and the
 * second one written that way would get it subtly wrong.
 */
export function selectOwedRecap(
	entries: readonly SessionTreeEntry[],
	definition: RecapDefinition,
): OwedRecap | undefined {
	const recapped = collectRecappedIds(entries, definition.recap);
	const owed = definition.collect(entries).filter((subject) => !recapped.has(subject.id));
	if (owed.length === 0) return undefined;
	return { body: definition.render(owed), ids: owed.map((subject) => subject.id) };
}

/**
 * Every subject a recap of this kind has already covered on this branch.
 *
 * A recap lands as a `custom_message` entry through the ordinary message path,
 * so this reads the same entries a UI renders, and an entry written by a build
 * that did not record ids simply covers nothing - the recap is given again,
 * which is the safe direction to be wrong in.
 */
export function collectRecappedIds(entries: readonly SessionTreeEntry[], recap: string): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		for (const id of entryRecapIds(entry, recap)) ids.add(id);
	}
	return ids;
}

/**
 * The t0 handles a branch carries that its job history has never heard of.
 *
 * The two facts are written at different points in the tree. A t0 tool result is
 * written by the harness inside the turn; the ref that records the job is
 * buffered behind that turn and lands at its save point. Every entry between
 * them is a place a navigation can land, and landing there leaves the model
 * holding a promise on a branch that never started the job.
 *
 * `recorded` is this runtime's job history, the one input that does not come
 * from the branch: a handle it knows about is one the job layer will answer
 * itself. Nothing is written for the rest - the branch has no `started` record
 * to close and inventing one would put a job on a branch that never ran it - so
 * the recap is the only record they get, and the only thing that stops the next
 * resume restating them.
 */
export function createOrphanedJobHandlesRecap(recorded: ReadonlySet<string>): RecapDefinition {
	return {
		recap: ORPHANED_JOB_HANDLES_RECAP,
		collect: (entries) =>
			entries.flatMap((entry) => {
				if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
				const details = entry.message.details;
				if (!isBackgroundJobStartedDetails(details) || recorded.has(details.toolCallId)) return [];
				return [{ id: details.toolCallId, text: toOrphanedJobHandleText(details) }];
			}),
		render: (subjects) => subjects.map((subject) => subject.text).join("\n\n"),
	};
}

/** The ids one entry records as recapped, empty for every entry that is not one. */
function entryRecapIds(entry: SessionTreeEntry, recap: string): readonly string[] {
	if (entry.type !== "custom_message" || entry.customType !== ORCHESTRATOR_MESSAGE_CUSTOM_TYPE) return [];
	return recapEntryIds(entry.details, recap);
}

/**
 * The t0 handles a branch carries, read off the structured details the
 * background runtime stamped on each one rather than off their text: a result
 * header is restated by the model, rewritten by compaction, and pasted by the
 * user, while `backgrounded: true` is only ever written by the runtime.
 */
function isBackgroundJobStartedDetails(details: unknown): details is BackgroundJobStartedDetails {
	if (typeof details !== "object" || details === null) return false;
	const candidate = details as Partial<BackgroundJobStartedDetails>;
	return (
		candidate.backgrounded === true && typeof candidate.jobId === "string" && typeof candidate.toolCallId === "string"
	);
}

function toOrphanedJobHandleText(handle: BackgroundJobStartedDetails): string {
	return formatInterruptedBackgroundJobResultText({
		jobId: handle.jobId,
		toolCallId: handle.toolCallId,
		toolName: handle.toolName,
		stopReason:
			"This part of the conversation never recorded the job, so nothing here can report its outcome. Start it again if its work is still needed.",
	});
}
