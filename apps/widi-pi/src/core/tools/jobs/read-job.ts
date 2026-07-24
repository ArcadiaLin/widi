import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../types.ts";

const readJobSchema = Type.Object({
	jobIds: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Handles of the background jobs to read (the `job-N` ids returned when a call moved to the background). Omit to read every background job that is currently live.",
		}),
	),
});

export type ReadJobInput = Static<typeof readJobSchema>;

/** Per-job report returned by `read_job`. */
export type ReadJobJobStatus =
	| {
			readonly jobId: string;
			readonly toolName: string;
			/** Human-readable label for the job (for bash, the command); may be absent. */
			readonly description?: string;
			readonly state: "running";
			/** Epoch ms when the job's tool call began. */
			readonly startedAt: number;
			/** Total bytes ever appended to the job's output. */
			readonly totalBytesSeen: number;
			/** Total bytes dropped from the rolling tail and no longer readable. */
			readonly tailDroppedBytes: number;
			/** Cumulative bytes dropped from the progress-forwarding buffer. */
			readonly progressDroppedBytes: number;
			/** Current rolling output tail at read time. */
			readonly output: string;
	  }
	| {
			/**
			 * No live backgrounded job matched the id: it either already finished
			 * (its result was delivered separately), has not been moved to the
			 * background, or never existed.
			 */
			readonly jobId: string;
			readonly state: "unknown";
	  };

export interface ReadJobDetails {
	readonly jobs: readonly ReadJobJobStatus[];
}

/**
 * Build the `read_job` tool: a synchronous peek at the live output of running
 * background jobs.
 *
 * Pure read, pure pull: it never blocks, never affects the job, and reads a
 * consistent snapshot (the buffer only mutates between turns of the event
 * loop). The tail is a bounded rolling buffer, so it is a progress peek, not
 * the job's result: the full output still arrives as the job's background job
 * result message when it finishes.
 */
export function createReadJobToolDefinition(): ToolDefinition<
	typeof readJobSchema,
	ReadJobDetails
> {
	return {
		name: "read_job",
		label: "read_job",
		description:
			"Read the current live output of one or more running background jobs (started by a backgrounded tool call, such as bash with background: true). Returns each job's rolling output tail without blocking or affecting the job; use it to check progress or spot errors mid-run. The tail is bounded, so it is not the final result: the finished job's output still arrives separately as a background job result message. To block until jobs finish use wait_for_jobs; to terminate one use kill_job.",
		promptSnippet: "Peek at the live output of running background jobs",
		parameters: readJobSchema,
		execute: async (_toolCallId, { jobIds }, context) => {
			const table = context.backgroundJobTable;
			if (!table) {
				return {
					content: [
						{
							type: "text",
							text: "No background job registry is available, so there is nothing to read.",
						},
					],
					details: { jobs: [] },
				};
			}

			// Same observability ruling as wait_for_jobs: only backgrounded jobs
			// exist for the model (their ids came from t0 handles); running-phase
			// jobs are excluded on purpose.
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

			const jobs = requestedIds.map((id): ReadJobJobStatus => {
				const job = live.get(id);
				return job
					? {
							jobId: id,
							toolName: job.toolName,
							description: job.description,
							state: "running",
							startedAt: job.startedAt,
							totalBytesSeen: job.output.totalBytesSeen,
							tailDroppedBytes: job.output.tailDroppedBytes,
							progressDroppedBytes: job.output.progressDroppedBytes,
							output: job.output.read(),
						}
					: { jobId: id, state: "unknown" };
			});
			return {
				content: [{ type: "text", text: formatReadSummary(jobs) }],
				details: { jobs },
			};
		},
	};
}

function formatReadSummary(jobs: readonly ReadJobJobStatus[]): string {
	if (jobs.length === 0) {
		return "No live background jobs to read.";
	}
	const sections = jobs.map((job) => {
		if (job.state === "unknown") {
			return `## Job ${job.jobId}: not tracked (already finished, not backgrounded, or never started)`;
		}
		const output = job.output ? job.output : "(no output yet)";
		const label = job.description ? `: ${job.description}` : "";
		return `## Job ${job.jobId} (${job.toolName})${label}: running — live output tail\n${output}`;
	});
	return `${sections.join("\n\n")}\n\nThis is a live tail, not the final result: each finished job's output arrives as a separate background job result message.`;
}
