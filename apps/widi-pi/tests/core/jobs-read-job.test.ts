import { describe, expect, it } from "vitest";
import { BackgroundJobTable } from "../../src/core/background-job.ts";
import { createReadJobToolDefinition } from "../../src/core/tools/jobs/read-job.ts";

const readJob = createReadJobToolDefinition();

function contextWith(table?: BackgroundJobTable) {
	return {
		signal: undefined,
		onUpdate: undefined,
		extension: undefined,
		human: undefined,
		backgroundJobTable: table,
	};
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");

describe("read_job tool", () => {
	it("returns the live output tail of backgrounded jobs, defaulting to all", async () => {
		const table = new BackgroundJobTable();
		const first = table.create({ toolCallId: "call-1", toolName: "bash" });
		const second = table.create({ toolCallId: "call-2", toolName: "bash" });
		table.background(first.id);
		table.background(second.id);
		first.output.append("building...\n");

		const result = await readJob.execute("call-3", {}, contextWith(table));

		expect(result.details).toEqual({
			jobs: [
				{
					jobId: first.id,
					toolName: "bash",
					description: undefined,
					state: "running",
					startedAt: expect.any(Number),
					totalBytesSeen: 12,
					tailDroppedBytes: 0,
					progressDroppedBytes: 0,
					output: "building...\n",
				},
				{
					jobId: second.id,
					toolName: "bash",
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

	it("reports settled, unknown, and running-phase ids as unknown", async () => {
		const table = new BackgroundJobTable();
		const settled = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(settled.id);
		table.settle(settled.id, { status: "completed" });
		// Pre-t0 sync window: not observable, so not readable.
		const running = table.create({ toolCallId: "call-2", toolName: "bash" });

		const result = await readJob.execute(
			"call-3",
			{ jobIds: [settled.id, running.id, "job-99"] },
			contextWith(table),
		);

		expect(result.details).toEqual({
			jobs: [
				{ jobId: settled.id, state: "unknown" },
				{ jobId: running.id, state: "unknown" },
				{ jobId: "job-99", state: "unknown" },
			],
		});
		expect(textOf(result)).toContain(
			"not tracked (already finished, not backgrounded, or never started)",
		);
	});

	it("reports tail and progress-buffer drops separately", async () => {
		const table = new BackgroundJobTable({ incrementMaxBytes: 4 });
		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(job.id);
		job.output.append("abcdef");

		const result = await readJob.execute(
			"call-2",
			{ jobIds: [job.id] },
			contextWith(table),
		);

		expect(result.details.jobs[0]).toMatchObject({
			jobId: job.id,
			totalBytesSeen: 6,
			tailDroppedBytes: 0,
			progressDroppedBytes: 2,
			output: "abcdef",
		});
	});

	it("returns the latest structured report and its generic summary", async () => {
		const table = new BackgroundJobTable();
		const job = table.create({ toolCallId: "call-1", toolName: "planner" });
		table.setReport(job.id, {
			kind: "test.plan",
			schemaVersion: 1,
			summary: "Executing plan",
			progress: { completed: 2, total: 4 },
		});
		table.background(job.id);

		const result = await readJob.execute(
			"call-2",
			{ jobIds: [job.id] },
			contextWith(table),
		);

		expect(result.details.jobs[0]).toMatchObject({
			jobId: job.id,
			report: {
				revision: 1,
				value: {
					kind: "test.plan",
					summary: "Executing plan",
					progress: { completed: 2, total: 4 },
				},
			},
		});
		expect(textOf(result)).toContain("Current report: Executing plan · 2/4");
	});

	it("reports nothing to read when no jobs are live", async () => {
		const table = new BackgroundJobTable();

		const result = await readJob.execute("call-1", {}, contextWith(table));

		expect(result.details).toEqual({ jobs: [] });
		expect(textOf(result)).toBe("No live background jobs to read.");
	});

	it("degrades gracefully without a job registry", async () => {
		const result = await readJob.execute("call-1", {}, contextWith(undefined));

		expect(result.details).toEqual({ jobs: [] });
		expect(textOf(result)).toContain("No background job registry");
	});
});
