import { type Static, Type } from "typebox";
import {
	type BackgroundJobSnapshot,
	type BackgroundJobStatus,
	backgroundJobToolLabel,
} from "../../background/index.ts";
import type { ToolDefinition } from "../types.ts";
import { waitForSettlements } from "./settlement-wait.ts";

/** Default confirmation window before reporting `aborting` instead. */
const DEFAULT_KILL_TIMEOUT_MS = 5_000;
/** Hard ceiling on the confirmation window. */
const MAX_KILL_TIMEOUT_MS = 30_000;

const killJobSchema = Type.Object({
	jobIds: Type.Array(Type.String(), {
		description:
			"Handles of the background jobs to terminate (the `job-N` ids returned when a call moved to the background).",
	}),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Maximum seconds to wait for the termination to be confirmed (default 5, capped at 30; pass 0 to send the abort without waiting).",
		}),
	),
});

export type KillJobInput = Static<typeof killJobSchema>;

/**
 * Per-job state reported by `kill_job`:
 * - a terminal status when the job settled within the confirmation window
 *   (usually `cancelled`; `completed`/`failed` when the job happened to finish
 *   on its own before the kill took effect - reported as-is);
 * - `aborting` when the abort was sent but the settlement did not arrive in
 *   time (the confirmation arrives as the job's result message);
 * - `unknown` when no live backgrounded job matched the id (already finished,
 *   not backgrounded, or never existed). Killing a finished job is a no-op.
 */
export type KillJobJobState = BackgroundJobStatus | "aborting" | "unknown";

export interface KillJobJobStatus {
	readonly jobId: string;
	readonly toolName?: string;
	/** The name the job was started with, when it was named. */
	readonly name?: string;
	readonly state: KillJobJobState;
}

export interface KillJobDetails {
	readonly jobs: readonly KillJobJobStatus[];
}

/**
 * Build the `kill_job` tool: terminate background jobs by aborting them and
 * waiting briefly for the settlement to confirm.
 *
 * The kill only reports the state transition; it does not carry the killed
 * job's output. The job's final output (cancelled, plus whatever it wrote
 * before dying) still arrives as its normal background job result message -
 * kill does not suppress t1.
 */
export function createKillJobToolDefinition(): ToolDefinition<typeof killJobSchema, KillJobDetails> {
	return {
		name: "kill_job",
		label: "kill_job",
		description:
			"Terminate one or more background jobs (started by a backgrounded tool call, such as bash with background: true). Sends an abort to each job and waits up to the timeout for the termination to be confirmed, then reports each job's state. Ids of jobs that already finished report as not tracked; killing them again has no effect. The killed job's final output still arrives separately as a background job result message. To inspect a running job's live output first use read_job.",
		promptSnippet: "Terminate running background jobs",
		parameters: killJobSchema,
		execute: async (_toolCallId, { jobIds, timeout }, context) => {
			const host = context.jobs;
			if (!host) {
				return {
					content: [{ type: "text", text: "No background job registry is available, so there is nothing to kill." }],
					details: { jobs: [] },
				};
			}

			// Only observable jobs exist for the model; anything else reports `unknown`.
			const live = new Map(host.list().map((job) => [job.jobId, job]));
			const requestedIds = Array.from(new Set(jobIds));

			const statuses = new Map<string, KillJobJobStatus>();
			const pending = new Map<string, BackgroundJobSnapshot>();
			for (const id of requestedIds) {
				const job = live.get(id);
				if (job) pending.set(id, job);
				else statuses.set(id, { jobId: id, state: "unknown" });
			}

			// The wait subscribes synchronously, before the aborts below: a job that
			// settles on its own signal must still be observed as settled rather
			// than waiting out the timeout.
			const timeoutMs = resolveKillTimeoutMs(timeout);
			const settlementWait =
				pending.size > 0 && timeoutMs > 0
					? waitForSettlements({
							watch: host.watch(),
							pending,
							timeoutMs,
							signal: context.signal,
							onSettled: (job, outcome) =>
								statuses.set(job.jobId, {
									jobId: job.jobId,
									toolName: job.toolName,
									name: job.name,
									state: outcome.status,
								}),
						})
					: undefined;
			// The listener drains `pending` as jobs settle; snapshot the ids first.
			for (const id of Array.from(pending.keys())) {
				host.abort(id, "Cancellation requested by kill_job.");
			}
			if (settlementWait) await settlementWait;

			// Whatever is still pending got the abort but no settlement in time.
			for (const [id, job] of pending) {
				statuses.set(id, { jobId: id, toolName: job.toolName, name: job.name, state: "aborting" });
			}

			const jobs = requestedIds.map((id) => statuses.get(id) ?? { jobId: id, state: "unknown" as const });
			return { content: [{ type: "text", text: formatKillSummary(jobs) }], details: { jobs } };
		},
	};
}

function resolveKillTimeoutMs(timeout: number | undefined): number {
	// Omitted or not a number: fall back to the default confirmation window.
	if (timeout === undefined || Number.isNaN(timeout)) {
		return DEFAULT_KILL_TIMEOUT_MS;
	}
	// Zero (or a nonsensical negative) means "send the abort, do not wait".
	if (timeout <= 0) return 0;
	return Math.min(timeout * 1000, MAX_KILL_TIMEOUT_MS);
}

function formatKillSummary(jobs: readonly KillJobJobStatus[]): string {
	if (jobs.length === 0) {
		return "No matching background jobs to kill.";
	}
	const lines = jobs.map((job) => {
		const label = job.toolName ? ` (${backgroundJobToolLabel({ toolName: job.toolName, name: job.name })})` : "";
		switch (job.state) {
			case "cancelled":
				return `- ${job.jobId}${label}: cancelled`;
			case "completed":
				return `- ${job.jobId}${label}: completed (finished on its own before the kill took effect)`;
			case "failed":
				return `- ${job.jobId}${label}: failed (failed on its own before the kill took effect)`;
			case "aborting":
				return `- ${job.jobId}${label}: aborting (abort sent; the confirmation arrives as its background job result message)`;
			default:
				return `- ${job.jobId}: not tracked (already finished, not backgrounded, or never started)`;
		}
	});
	return `Kill requested for background jobs:\n${lines.join("\n")}\n\nDetailed output for each terminated job arrives as a separate background job result message.`;
}
