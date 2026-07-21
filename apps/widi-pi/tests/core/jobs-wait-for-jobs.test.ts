import { describe, expect, it, vi } from "vitest";
import {
	type BackgroundJobOutcome,
	BackgroundJobTable,
} from "../../src/core/background-job.ts";
import {
	createWaitForJobsToolDefinition,
	type WaitForJobsDetails,
} from "../../src/core/tools/jobs/wait-for-jobs.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";

const completedOutcome: BackgroundJobOutcome = {
	status: "completed",
	result: {
		content: [{ type: "text", text: "build done" }],
		details: undefined,
	},
};

function makeContext(
	table: BackgroundJobTable | undefined,
	signal?: AbortSignal,
): ToolExecutionContext<WaitForJobsDetails> {
	return {
		signal,
		onUpdate: undefined,
		extension: undefined,
		human: undefined,
		backgroundJobTable: table,
	};
}

/** Register a backgrounded job on the table and return its id. */
function backgroundJob(table: BackgroundJobTable, toolName = "bash"): string {
	const job = table.create({ toolCallId: `call-${toolName}`, toolName });
	table.background(job.id);
	return job.id;
}

describe("wait_for_jobs tool", () => {
	it("resolves when a waited-on job settles and reports its status", async () => {
		const table = new BackgroundJobTable();
		const jobId = backgroundJob(table);
		const tool = createWaitForJobsToolDefinition();

		const promise = tool.execute(
			"wait-1",
			{ jobIds: [jobId] },
			makeContext(table),
		);
		// The wait is now subscribed; settling the job releases it.
		table.settle(jobId, completedOutcome);
		const result = await promise;

		expect(result.details.outcome).toBe("completed");
		expect(result.details.jobs).toEqual([
			{ jobId, toolName: "bash", state: "completed" },
		]);
	});

	it("waits for every live job when no ids are given", async () => {
		const table = new BackgroundJobTable();
		const first = backgroundJob(table, "bash");
		const second = backgroundJob(table, "spawn_agent");
		const tool = createWaitForJobsToolDefinition();

		const promise = tool.execute("wait-1", {}, makeContext(table));
		table.settle(first, completedOutcome);
		table.settle(second, { status: "failed", error: new Error("boom") });
		const result = await promise;

		expect(result.details.outcome).toBe("completed");
		expect(result.details.jobs.map((job) => job.state)).toEqual([
			"completed",
			"failed",
		]);
	});

	it("reports unknown ids that match no live job", async () => {
		const table = new BackgroundJobTable();
		const tool = createWaitForJobsToolDefinition();

		const result = await tool.execute(
			"wait-1",
			{ jobIds: ["job-404"] },
			makeContext(table),
		);

		expect(result.details.outcome).toBe("completed");
		expect(result.details.jobs).toEqual([
			{ jobId: "job-404", state: "unknown" },
		]);
	});

	it("does not wait on a job that has not been backgrounded yet", async () => {
		const table = new BackgroundJobTable();
		// A `running`-phase job (created but not yet past its deadline). It may
		// still settle inline, which never notifies listeners, so waiting on it
		// would strand until timeout. It must be excluded from the wait.
		const job = table.create({ toolCallId: "c1", toolName: "bash" });
		const tool = createWaitForJobsToolDefinition();

		// No ids: the snapshot only sees backgrounded jobs, so there is nothing to
		// wait for and the call returns immediately.
		const all = await tool.execute("wait-1", {}, makeContext(table));
		expect(all.details).toEqual({ outcome: "completed", jobs: [] });

		// Explicitly naming the running job reports it as untracked rather than
		// blocking on a settlement that will never notify.
		const named = await tool.execute(
			"wait-2",
			{ jobIds: [job.id] },
			makeContext(table),
		);
		expect(named.details.outcome).toBe("completed");
		expect(named.details.jobs).toEqual([{ jobId: job.id, state: "unknown" }]);

		// The job later settling inline is a no-op for the (already returned) wait.
		expect(table.settle(job.id, completedOutcome)).toBe("inline");
	});

	it("returns still-running status on timeout instead of hanging", async () => {
		vi.useFakeTimers();
		try {
			const table = new BackgroundJobTable();
			const jobId = backgroundJob(table);
			const tool = createWaitForJobsToolDefinition();

			const promise = tool.execute(
				"wait-1",
				{ jobIds: [jobId], timeout: 1 },
				makeContext(table),
			);
			await vi.advanceTimersByTimeAsync(1000);
			const result = await promise;

			expect(result.details.outcome).toBe("timed_out");
			expect(result.details.jobs).toEqual([
				{ jobId, toolName: "bash", state: "running" },
			]);
			// The job is untouched and keeps running.
			expect(table.get(jobId)?.phase).toBe("backgrounded");
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports an aborted wait distinctly from a timeout, leaving the job running", async () => {
		const table = new BackgroundJobTable();
		const jobId = backgroundJob(table);
		const controller = new AbortController();
		const tool = createWaitForJobsToolDefinition();

		const promise = tool.execute(
			"wait-1",
			{ jobIds: [jobId] },
			makeContext(table, controller.signal),
		);
		controller.abort();
		const result = await promise;

		expect(result.details.outcome).toBe("aborted");
		expect(result.details.jobs).toEqual([
			{ jobId, toolName: "bash", state: "running" },
		]);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("interrupted"),
		});
		expect(table.get(jobId)?.phase).toBe("backgrounded");
	});

	it("reports no registry when the background job table is absent", async () => {
		const tool = createWaitForJobsToolDefinition();
		const result = await tool.execute(
			"wait-1",
			{ jobIds: ["job-1"] },
			makeContext(undefined),
		);

		expect(result.details).toEqual({ outcome: "completed", jobs: [] });
		expect(result.content[0]).toMatchObject({ type: "text" });
	});
});
