import { type Static, Type } from "typebox";
import type {
	BackgroundJob,
	BackgroundJobStatus,
	BackgroundJobTable,
} from "../../background-job.ts";
import type { ToolDefinition } from "../types.ts";

/** Default barrier timeout so a wait never hangs the agent indefinitely. */
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;

const waitForJobsSchema = Type.Object({
	jobIds: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Handles of the background jobs to wait for (the `job-N` ids returned when a call moved to the background). Omit to wait for every background job that is currently live.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Maximum seconds to block before returning with the current status (default 60). Jobs that are still running keep running; their output still arrives later as separate background job result messages.",
		}),
	),
});

export type WaitForJobsInput = Static<typeof waitForJobsSchema>;

/**
 * Why the wait returned:
 * - `completed`: every waited-on job settled.
 * - `timed_out`: the timeout elapsed with jobs still running.
 * - `aborted`: the call was interrupted with jobs still running.
 */
export type WaitForJobsOutcome = "completed" | "timed_out" | "aborted";

/** Per-job status reported by `wait_for_jobs`. */
export interface WaitForJobsJobStatus {
	readonly jobId: string;
	readonly toolName?: string;
	/**
	 * `running` means the job had not settled when the wait returned (timed out
	 * or interrupted). `unknown` means no live backgrounded job matched the id:
	 * it either already finished (its result was delivered separately), has not
	 * been moved to the background, or never existed.
	 */
	readonly state: BackgroundJobStatus | "running" | "unknown";
}

export interface WaitForJobsDetails {
	readonly outcome: WaitForJobsOutcome;
	readonly jobs: readonly WaitForJobsJobStatus[];
}

/**
 * Build the `wait_for_jobs` tool: an explicit convergence point for pseudo-async
 * background jobs.
 *
 * It blocks until the named jobs reach a terminal outcome or the timeout
 * elapses, then reports each job's status. It is a barrier, not an output
 * channel: the detailed result of each finished job still arrives through the
 * normal background job result message (t1), so this tool never duplicates large
 * command output inline. A timeout returns the current status rather than
 * hanging, and jobs left running keep running.
 */
export function createWaitForJobsToolDefinition(): ToolDefinition<
	typeof waitForJobsSchema,
	WaitForJobsDetails
> {
	return {
		name: "wait_for_jobs",
		label: "wait_for_jobs",
		description:
			"Wait for one or more background jobs (started by a backgrounded tool call, such as bash with background: true) to finish, then report each job's status. Blocks up to the timeout, then returns; jobs still running keep running. Detailed output for each finished job arrives separately as a background job result message, so use this to synchronize, not to fetch output.",
		promptSnippet: "Wait for background jobs to finish before continuing",
		parameters: waitForJobsSchema,
		execute: async (_toolCallId, { jobIds, timeout }, context) => {
			const table = context.backgroundJobTable;
			if (!table) {
				return {
					content: [
						{
							type: "text",
							text: "No background job registry is available, so there is nothing to wait for.",
						},
					],
					details: { outcome: "completed", jobs: [] },
				};
			}

			// Only jobs already moved to the background are safe to wait on: their
			// settlement is guaranteed to fire `onResult`. A job still in the
			// `running` phase has not committed to background delivery and may
			// settle inline (delivered to its own tool call, with no listener
			// notification), which would strand the wait until it times out. Ids
			// the model actually holds came from a t0 handle, so they are already
			// backgrounded; running-phase jobs are excluded on purpose.
			const live = new Map(
				table
					.list()
					.filter((job) => job.phase === "backgrounded")
					.map((job) => [job.id, job]),
			);
			const requestedIds =
				jobIds && jobIds.length > 0
					? Array.from(new Set(jobIds))
					: Array.from(live.keys());

			const statuses = new Map<string, WaitForJobsJobStatus>();
			const pending = new Map<string, BackgroundJob>();
			for (const id of requestedIds) {
				const job = live.get(id);
				if (job) pending.set(id, job);
				else statuses.set(id, { jobId: id, state: "unknown" });
			}

			let outcome: WaitForJobsOutcome = "completed";
			if (pending.size > 0) {
				outcome = await waitForPending(
					table,
					pending,
					statuses,
					resolveWaitTimeoutMs(timeout),
					context.signal,
				);
			}

			// Anything still pending stopped short of settling (timeout or abort)
			// while the job kept running.
			for (const [id, job] of pending) {
				statuses.set(id, {
					jobId: id,
					toolName: job.toolName,
					state: "running",
				});
			}

			const jobs = requestedIds.map(
				(id) => statuses.get(id) ?? { jobId: id, state: "unknown" as const },
			);
			return {
				content: [{ type: "text", text: formatWaitSummary(jobs, outcome) }],
				details: { outcome, jobs },
			};
		},
	};
}

/**
 * Resolve with the reason the wait ended: `completed` once every pending job has
 * settled, `timed_out` when the timeout elapses first, or `aborted` when the
 * call is interrupted. Settled jobs are recorded into `statuses` and removed
 * from `pending`, so whatever remains in `pending` afterwards is still running.
 */
function waitForPending(
	table: BackgroundJobTable,
	pending: Map<string, BackgroundJob>,
	statuses: Map<string, WaitForJobsJobStatus>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<WaitForJobsOutcome> {
	return new Promise((resolve) => {
		let finished = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (outcome: WaitForJobsOutcome) => {
			if (finished) return;
			finished = true;
			unsubscribe();
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const onAbort = () => finish("aborted");
		const unsubscribe = table.onResult((settlement) => {
			if (!pending.has(settlement.job.id)) return;
			pending.delete(settlement.job.id);
			statuses.set(settlement.job.id, {
				jobId: settlement.job.id,
				toolName: settlement.job.toolName,
				state: settlement.outcome.status,
			});
			if (pending.size === 0) finish("completed");
		});
		timer = setTimeout(() => finish("timed_out"), timeoutMs);
		if (signal) {
			if (signal.aborted) finish("aborted");
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function resolveWaitTimeoutMs(timeout: number | undefined): number {
	if (timeout === undefined || !Number.isFinite(timeout) || timeout <= 0) {
		return DEFAULT_WAIT_TIMEOUT_MS;
	}
	return timeout * 1000;
}

function formatWaitSummary(
	jobs: readonly WaitForJobsJobStatus[],
	outcome: WaitForJobsOutcome,
): string {
	if (jobs.length === 0) {
		return "No matching background jobs to wait for.";
	}
	const lines = jobs.map((job) => {
		const name = job.toolName ? ` (${job.toolName})` : "";
		switch (job.state) {
			case "completed":
				return `- ${job.jobId}${name}: completed`;
			case "failed":
				return `- ${job.jobId}${name}: failed`;
			case "cancelled":
				return `- ${job.jobId}${name}: cancelled`;
			case "running":
				return `- ${job.jobId}${name}: still running`;
			default:
				return `- ${job.jobId}: not tracked (already finished, not backgrounded, or never started)`;
		}
	});
	const header =
		outcome === "timed_out"
			? "Timed out waiting for background jobs; some are still running:"
			: outcome === "aborted"
				? "Wait interrupted; background jobs are still running:"
				: "Background jobs finished:";
	return `${header}\n${lines.join("\n")}\n\nDetailed output for each finished job arrives as a separate background job result message.`;
}
