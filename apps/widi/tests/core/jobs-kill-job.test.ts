import { describe, expect, it } from "vitest";
import type {
	BackgroundJobExecution,
	BackgroundJobHost,
	BackgroundJobSnapshot,
	BackgroundJobStatus,
	BackgroundJobTransition,
} from "../../src/core/background/index.ts";
import { createKillJobToolDefinition } from "../../src/core/tools/jobs/kill-job.ts";
import { createJobRuntimeHarness, startBackgroundedJob } from "../helpers/background-jobs.ts";

const killJob = createKillJobToolDefinition();

function contextWith(jobs?: BackgroundJobHost, signal?: AbortSignal) {
	return { signal, onUpdate: undefined, extension: undefined, human: undefined, jobs };
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

/**
 * Background a job whose signal-abort settles it like the tool adapter would:
 * the settlement arrives on the abort, with the given status.
 */
function createSettlingJob(
	host: BackgroundJobHost,
	status: BackgroundJobStatus = "cancelled",
): { readonly execution: BackgroundJobExecution; readonly job: BackgroundJobSnapshot } {
	const started = startBackgroundedJob(host);
	started.execution.signal.addEventListener("abort", () => started.execution.settle({ status }), { once: true });
	return started;
}

describe("kill_job tool", () => {
	it("kills a backgrounded job and reports the confirmed cancellation", async () => {
		const { host, events } = await createJobRuntimeHarness();
		const { job } = createSettlingJob(host);

		const result = await killJob.execute("call-2", { jobIds: [job.jobId] }, contextWith(host));

		expect(result.details).toEqual({
			jobs: [{ jobId: job.jobId, toolName: "bash", name: undefined, state: "cancelled" }],
		});
		expect(textOf(result)).toContain(`${job.jobId} (bash): cancelled`);
		const transitions = events.flatMap((event): BackgroundJobTransition[] =>
			event.type === "job_changed" ? [event.transition] : [],
		);
		const abortRequested = events.find(
			(event) => event.type === "job_changed" && event.transition === "abort_requested",
		);
		expect(abortRequested?.type === "job_changed" ? abortRequested.job.stopReason : undefined).toBe(
			"Cancellation requested by kill_job.",
		);
		// The kill does not suppress the settlement: t1 routing still fires.
		expect(transitions).toEqual(["backgrounded", "abort_requested", "settled"]);
	});

	it("reports a job that finished on its own before the kill took effect", async () => {
		const { host } = await createJobRuntimeHarness();
		const { job } = createSettlingJob(host, "completed");

		const result = await killJob.execute("call-2", { jobIds: [job.jobId] }, contextWith(host));

		expect(result.details).toEqual({
			jobs: [{ jobId: job.jobId, toolName: "bash", name: undefined, state: "completed" }],
		});
	});

	it("reports aborting when the settlement does not arrive within the timeout", async () => {
		const { host } = await createJobRuntimeHarness();
		const { execution, job } = startBackgroundedJob(host);

		const result = await killJob.execute("call-2", { jobIds: [job.jobId], timeout: 0.05 }, contextWith(host));

		expect(execution.signal.aborted).toBe(true);
		expect(result.details).toEqual({
			jobs: [{ jobId: job.jobId, toolName: "bash", name: undefined, state: "aborting" }],
		});
		expect(textOf(result)).toContain("abort sent");
	});

	it("sends the abort without waiting when timeout is 0", async () => {
		const { host } = await createJobRuntimeHarness();
		const { execution, job } = startBackgroundedJob(host);

		const result = await killJob.execute("call-2", { jobIds: [job.jobId], timeout: 0 }, contextWith(host));

		expect(execution.signal.aborted).toBe(true);
		expect(result.details).toEqual({
			jobs: [{ jobId: job.jobId, toolName: "bash", name: undefined, state: "aborting" }],
		});
	});

	it("reports settled, candidate, and unknown ids as unknown without touching them", async () => {
		const { host } = await createJobRuntimeHarness();
		const settled = startBackgroundedJob(host, { toolCallId: "call-1" });
		settled.execution.settle({ status: "completed" });
		// Pre-t0 sync window: not observable, so not killable.
		const candidate = host.startLocal({ toolCallId: "call-2", toolName: "bash" });
		if (!candidate.ok) throw new Error("Expected a local job.");

		const result = await killJob.execute(
			"call-3",
			{ jobIds: [settled.job.jobId, candidate.execution.jobId, "job-99"] },
			contextWith(host),
		);

		expect(result.details).toEqual({
			jobs: [
				{ jobId: settled.job.jobId, state: "unknown" },
				{ jobId: candidate.execution.jobId, state: "unknown" },
				{ jobId: "job-99", state: "unknown" },
			],
		});
		// A repeated kill is a no-op with no side effects: the candidate was not
		// aborted.
		expect(candidate.execution.signal.aborted).toBe(false);
	});

	it("returns promptly with aborting when the call itself is interrupted", async () => {
		const { host } = await createJobRuntimeHarness();
		const { job } = startBackgroundedJob(host);
		const controller = new AbortController();

		const execPromise = killJob.execute(
			"call-2",
			{ jobIds: [job.jobId], timeout: 30 },
			contextWith(host, controller.signal),
		);
		controller.abort();
		const result = await execPromise;

		expect(result.details).toEqual({
			jobs: [{ jobId: job.jobId, toolName: "bash", name: undefined, state: "aborting" }],
		});
	});
});
