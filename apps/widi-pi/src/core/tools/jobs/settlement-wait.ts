import type {
	BackgroundJob,
	BackgroundJobOutcome,
	BackgroundJobTable,
} from "../../background/index.ts";
import type { HumanInterruptWatch } from "../../human-interrupt.ts";

/**
 * Why a settlement wait returned:
 * - `completed`: every pending job settled.
 * - `timed_out`: the timeout elapsed with jobs still pending.
 * - `aborted`: the waiting tool call was interrupted.
 * - `steered`: the human sent a steer, so the wait gave the turn back rather
 *   than holding it open until the steer could be read.
 */
export type SettlementWaitOutcome =
	| "completed"
	| "timed_out"
	| "aborted"
	| "steered";

/**
 * Wait for every job in `pending` to settle, up to `timeoutMs`. Shared waiting
 * skeleton of `wait_for_jobs` and `kill_job`, whose semantics must match.
 *
 * Each settlement is reported through `onSettled` and removed from `pending`,
 * so whatever remains in `pending` afterwards is still running. The change
 * listener, the timer, the abort listener and the interrupt subscription are
 * all released on every exit path (`finish` is idempotent). Subscribes
 * synchronously, so a caller may start the wait before triggering the
 * settlements it expects to observe.
 *
 * `humanInterrupts` opts the wait into ending on a human steer. A steer is only
 * read at a turn boundary, so a wait that keeps holding the turn is exactly
 * what makes the user's message look lost; ending early hands the turn back and
 * lets the loop drain it.
 */
export function waitForSettlements(options: {
	table: BackgroundJobTable;
	pending: Map<string, BackgroundJob>;
	timeoutMs: number;
	signal: AbortSignal | undefined;
	humanInterrupts?: HumanInterruptWatch;
	onSettled: (job: BackgroundJob, outcome: BackgroundJobOutcome) => void;
}): Promise<SettlementWaitOutcome> {
	const { table, pending, timeoutMs, signal, humanInterrupts, onSettled } =
		options;
	return new Promise((resolve) => {
		let finished = false;
		let timer: NodeJS.Timeout | undefined;
		let unsubscribeInterrupts: (() => void) | undefined;
		const finish = (outcome: SettlementWaitOutcome) => {
			if (finished) return;
			finished = true;
			unsubscribe();
			unsubscribeInterrupts?.();
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const onAbort = () => finish("aborted");
		const unsubscribe = table.onChange((change) => {
			if (change.transition !== "settled") return;
			if (!pending.has(change.job.id)) return;
			pending.delete(change.job.id);
			onSettled(change.job, change.outcome);
			if (pending.size === 0) finish("completed");
		});
		if (pending.size === 0) {
			finish("completed");
			return;
		}
		// A steer queued while an earlier tool call ran is just as unread as one
		// that arrives during this wait, so check before subscribing.
		if (humanInterrupts?.pending()) {
			finish("steered");
			return;
		}
		timer = setTimeout(() => finish("timed_out"), timeoutMs);
		unsubscribeInterrupts = humanInterrupts?.subscribe(() => finish("steered"));
		if (signal) {
			if (signal.aborted) finish("aborted");
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}
