import type {
	BackgroundJob,
	BackgroundJobOutcome,
	BackgroundJobTable,
} from "../../background-job.ts";

/**
 * Why a settlement wait returned:
 * - `completed`: every pending job settled.
 * - `timed_out`: the timeout elapsed with jobs still pending.
 * - `aborted`: the waiting tool call was interrupted.
 */
export type SettlementWaitOutcome = "completed" | "timed_out" | "aborted";

/**
 * Wait for every job in `pending` to settle, up to `timeoutMs`. Shared waiting
 * skeleton of `wait_for_jobs` and `kill_job`, whose semantics must match.
 *
 * Each settlement is reported through `onSettled` and removed from `pending`,
 * so whatever remains in `pending` afterwards is still running. The change
 * listener, the timer, and the abort listener are all released on every exit
 * path (`finish` is idempotent). Subscribes synchronously, so a caller may
 * start the wait before triggering the settlements it expects to observe.
 */
export function waitForSettlements(options: {
	table: BackgroundJobTable;
	pending: Map<string, BackgroundJob>;
	timeoutMs: number;
	signal: AbortSignal | undefined;
	onSettled: (job: BackgroundJob, outcome: BackgroundJobOutcome) => void;
}): Promise<SettlementWaitOutcome> {
	const { table, pending, timeoutMs, signal, onSettled } = options;
	return new Promise((resolve) => {
		let finished = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (outcome: SettlementWaitOutcome) => {
			if (finished) return;
			finished = true;
			unsubscribe();
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
		timer = setTimeout(() => finish("timed_out"), timeoutMs);
		if (signal) {
			if (signal.aborted) finish("aborted");
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}
