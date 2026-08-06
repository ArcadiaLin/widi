import { describe, expect, it } from "vitest";
import type { BackgroundJobHost } from "../../src/core/background/index.ts";
import { createReadJobToolDefinition } from "../../src/core/tools/jobs/read-job.ts";
import { createJobRuntimeHarness, startBackgroundedJob } from "../helpers/background-jobs.ts";

const readJob = createReadJobToolDefinition();

function contextWith(jobs?: BackgroundJobHost) {
	return { signal: undefined, onUpdate: undefined, extension: undefined, human: undefined, jobs };
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

describe("read_job tool", () => {
	it("returns the live output tail of backgrounded jobs, defaulting to all", async () => {
		const { host } = await createJobRuntimeHarness();
		const first = startBackgroundedJob(host, { toolCallId: "call-1" });
		const second = startBackgroundedJob(host, { toolCallId: "call-2" });
		first.execution.output.append("building...\n");

		const result = await readJob.execute("call-3", {}, contextWith(host));

		expect(result.details).toEqual({
			jobs: [
				{
					jobId: first.job.jobId,
					toolName: "bash",
					name: undefined,
					description: undefined,
					state: "running",
					startedAt: expect.any(Number),
					totalBytesSeen: 12,
					tailDroppedBytes: 0,
					progressDroppedBytes: 0,
					output: "building...\n",
				},
				{
					jobId: second.job.jobId,
					toolName: "bash",
					name: undefined,
					description: undefined,
					state: "running",
					startedAt: expect.any(Number),
					totalBytesSeen: 0,
					tailDroppedBytes: 0,
					progressDroppedBytes: 0,
					output: "",
				},
			],
		});
		const text = textOf(result);
		expect(text).toContain("building...");
		// An empty tail is labeled rather than rendered as a blank section.
		expect(text).toContain("(no output yet)");
	});

	it("reports settled, candidate, and unknown ids as unknown", async () => {
		const { host } = await createJobRuntimeHarness();
		const settled = startBackgroundedJob(host, { toolCallId: "call-1" });
		settled.execution.settle({ status: "completed" });
		// Pre-t0 sync window: not observable, so not readable.
		const candidate = host.startLocal({ toolCallId: "call-2", toolName: "bash" });
		if (!candidate.ok) throw new Error("Expected a local job.");

		const result = await readJob.execute(
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
		expect(textOf(result)).toContain("not tracked (already finished, not backgrounded, or never started)");
	});

	it("reports tail and progress-buffer drops separately", async () => {
		const { host } = await createJobRuntimeHarness({ incrementMaxBytes: 4 });
		const { execution, job } = startBackgroundedJob(host);
		execution.output.append("abcdef");

		const result = await readJob.execute("call-2", { jobIds: [job.jobId] }, contextWith(host));

		expect(result.details.jobs[0]).toMatchObject({
			jobId: job.jobId,
			totalBytesSeen: 6,
			tailDroppedBytes: 0,
			progressDroppedBytes: 2,
			output: "abcdef",
		});
	});

	it("returns the latest structured report and its generic summary", async () => {
		const { host } = await createJobRuntimeHarness();
		const started = host.startLocal({
			toolCallId: "call-1",
			toolName: "planner",
			report: { kind: "test.plan", schemaVersion: 1, summary: "Executing plan", progress: { completed: 2, total: 4 } },
		});
		if (!started.ok) throw new Error("Expected a local job.");
		const accepted = started.execution.acceptBackground();
		if (!accepted.ok) throw new Error("Expected the job to background.");

		const result = await readJob.execute("call-2", { jobIds: [accepted.job.jobId] }, contextWith(host));

		expect(result.details.jobs[0]).toMatchObject({
			jobId: accepted.job.jobId,
			report: {
				revision: 1,
				value: { kind: "test.plan", summary: "Executing plan", progress: { completed: 2, total: 4 } },
			},
		});
		expect(textOf(result)).toContain("Current report: Executing plan · 2/4");
	});

	it("reports nothing to read when no jobs are live", async () => {
		const { host } = await createJobRuntimeHarness();

		const result = await readJob.execute("call-1", {}, contextWith(host));

		expect(result.details).toEqual({ jobs: [] });
		expect(textOf(result)).toBe("No live background jobs to read.");
	});

	it("degrades gracefully without a job registry", async () => {
		const result = await readJob.execute("call-1", {}, contextWith(undefined));

		expect(result.details).toEqual({ jobs: [] });
		expect(textOf(result)).toContain("No background job registry");
	});
});
