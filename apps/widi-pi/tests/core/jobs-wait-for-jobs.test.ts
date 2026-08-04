import { describe, expect, it, vi } from "vitest";
import type {
	BackgroundJobExecution,
	BackgroundJobHost,
	BackgroundJobOutcome,
} from "../../src/core/background/index.ts";
import { HumanInterruptRegistry } from "../../src/core/human-interrupt.ts";
import { createWaitForJobsToolDefinition, type WaitForJobsDetails } from "../../src/core/tools/jobs/wait-for-jobs.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";
import { createJobRuntimeHarness, startBackgroundedJob } from "../helpers/background-jobs.ts";

const completedOutcome: BackgroundJobOutcome = {
	status: "completed",
	result: { content: [{ type: "text", text: "build done" }], details: undefined },
};

function makeContext(
	jobs: BackgroundJobHost | undefined,
	signal?: AbortSignal,
	humanInterrupts?: ToolExecutionContext<WaitForJobsDetails>["humanInterrupts"],
): ToolExecutionContext<WaitForJobsDetails> {
	return { signal, onUpdate: undefined, extension: undefined, human: undefined, jobs, humanInterrupts };
}

/** Background a job and keep its handle, which is the only way to settle it. */
function backgroundJob(
	host: BackgroundJobHost,
	toolName = "bash",
): { readonly jobId: string; readonly execution: BackgroundJobExecution } {
	const { execution, job } = startBackgroundedJob(host, { toolCallId: `call-${toolName}`, toolName });
	return { jobId: job.jobId, execution };
}

/** Observable jobs still live on the host, by id. */
function liveJobIds(host: BackgroundJobHost): string[] {
	return host.list().map((job) => job.jobId);
}

describe("wait_for_jobs tool", () => {
	it("resolves when a waited-on job settles and reports its status", async () => {
		const { host } = await createJobRuntimeHarness();
		const { jobId, execution } = backgroundJob(host);
		const tool = createWaitForJobsToolDefinition();

		const promise = tool.execute("wait-1", { jobIds: [jobId] }, makeContext(host));
		// The wait is now subscribed; settling the job releases it.
		execution.settle(completedOutcome);
		const result = await promise;

		expect(result.details.outcome).toBe("completed");
		expect(result.details.jobs).toEqual([{ jobId, toolName: "bash", name: undefined, state: "completed" }]);
	});

	it("waits for every live job when no ids are given", async () => {
		const { host } = await createJobRuntimeHarness();
		const first = backgroundJob(host, "bash");
		const second = backgroundJob(host, "spawn_agent");
		const tool = createWaitForJobsToolDefinition();

		const promise = tool.execute("wait-1", {}, makeContext(host));
		first.execution.settle(completedOutcome);
		second.execution.settle({ status: "failed", error: new Error("boom") });
		const result = await promise;

		expect(result.details.outcome).toBe("completed");
		expect(result.details.jobs.map((job) => job.state)).toEqual(["completed", "failed"]);
	});

	it("reports unknown ids that match no live job", async () => {
		const { host } = await createJobRuntimeHarness();
		const tool = createWaitForJobsToolDefinition();

		const result = await tool.execute("wait-1", { jobIds: ["job-404"] }, makeContext(host));

		expect(result.details.outcome).toBe("completed");
		expect(result.details.jobs).toEqual([{ jobId: "job-404", state: "unknown" }]);
	});

	it("does not wait on a job that has not been backgrounded yet", async () => {
		const { host } = await createJobRuntimeHarness();
		// A candidate (started but not yet past its deadline). It may still settle
		// inline, which never notifies listeners, so waiting on it would strand
		// until timeout. It must be excluded from the wait.
		const started = host.startLocal({ toolCallId: "c1", toolName: "bash" });
		if (!started.ok) throw new Error("Expected a local job.");
		const tool = createWaitForJobsToolDefinition();

		// No ids: the snapshot only sees observable jobs, so there is nothing to
		// wait for and the call returns immediately.
		const all = await tool.execute("wait-1", {}, makeContext(host));
		expect(all.details).toEqual({ outcome: "completed", jobs: [] });

		// Explicitly naming the candidate reports it as untracked rather than
		// blocking on a settlement that will never notify.
		const named = await tool.execute("wait-2", { jobIds: [started.execution.jobId] }, makeContext(host));
		expect(named.details.outcome).toBe("completed");
		expect(named.details.jobs).toEqual([{ jobId: started.execution.jobId, state: "unknown" }]);

		// The job later settling inline is a no-op for the (already returned) wait.
		expect(started.execution.settle(completedOutcome)).toEqual({ ok: true, disposition: "inline" });
	});

	it("returns still-running status on timeout instead of hanging", async () => {
		vi.useFakeTimers();
		try {
			const { host } = await createJobRuntimeHarness();
			const { jobId } = backgroundJob(host);
			const tool = createWaitForJobsToolDefinition();

			const promise = tool.execute("wait-1", { jobIds: [jobId], timeout: 1 }, makeContext(host));
			await vi.advanceTimersByTimeAsync(1000);
			const result = await promise;

			expect(result.details.outcome).toBe("timed_out");
			expect(result.details.jobs).toEqual([{ jobId, toolName: "bash", name: undefined, state: "running" }]);
			// The job is untouched and keeps running.
			expect(liveJobIds(host)).toEqual([jobId]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports an aborted wait distinctly from a timeout, leaving the job running", async () => {
		const { host } = await createJobRuntimeHarness();
		const { jobId } = backgroundJob(host);
		const controller = new AbortController();
		const tool = createWaitForJobsToolDefinition();

		const promise = tool.execute("wait-1", { jobIds: [jobId] }, makeContext(host, controller.signal));
		controller.abort();
		const result = await promise;

		expect(result.details.outcome).toBe("aborted");
		expect(result.details.jobs).toEqual([{ jobId, toolName: "bash", name: undefined, state: "running" }]);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("interrupted") });
		expect(liveJobIds(host)).toEqual([jobId]);
	});

	it("gives the turn back when the human steers mid-wait, leaving the job running", async () => {
		const { host } = await createJobRuntimeHarness();
		const { jobId } = backgroundJob(host);
		const interrupts = new HumanInterruptRegistry();
		const tool = createWaitForJobsToolDefinition();

		const promise = tool.execute(
			"wait-1",
			{ jobIds: [jobId] },
			makeContext(host, undefined, interrupts.watch("agent-1")),
		);
		interrupts.notify("agent-1");
		const result = await promise;

		expect(result.details.outcome).toBe("steered");
		expect(result.details.jobs).toEqual([{ jobId, toolName: "bash", name: undefined, state: "running" }]);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("the user sent a message") });
		expect(liveJobIds(host)).toEqual([jobId]);
	});

	it("returns immediately when a steer is already waiting to be read", async () => {
		const { host } = await createJobRuntimeHarness();
		const { jobId } = backgroundJob(host);
		const interrupts = new HumanInterruptRegistry();
		// The steer arrived while an earlier tool call ran: it is just as unread,
		// so the barrier must not start blocking at all.
		interrupts.notify("agent-1");
		const tool = createWaitForJobsToolDefinition();

		const result = await tool.execute(
			"wait-1",
			{ jobIds: [jobId] },
			makeContext(host, undefined, interrupts.watch("agent-1")),
		);

		expect(result.details.outcome).toBe("steered");
		expect(liveJobIds(host)).toEqual([jobId]);
	});

	it("polls the current status without blocking when timeout is 0", async () => {
		const { host } = await createJobRuntimeHarness();
		const { jobId } = backgroundJob(host);
		const tool = createWaitForJobsToolDefinition();

		// timeout 0 must return promptly with the live status rather than falling
		// back to the default 60s barrier.
		const result = await tool.execute("wait-1", { jobIds: [jobId], timeout: 0 }, makeContext(host));

		expect(result.details.outcome).toBe("timed_out");
		expect(result.details.jobs).toEqual([{ jobId, toolName: "bash", name: undefined, state: "running" }]);
		// The job is untouched and keeps running.
		expect(liveJobIds(host)).toEqual([jobId]);
	});

	it("clamps an oversized timeout to the ceiling", async () => {
		vi.useFakeTimers();
		try {
			const { host } = await createJobRuntimeHarness();
			const { jobId } = backgroundJob(host);
			const tool = createWaitForJobsToolDefinition();

			// A day-long request must not hang: it is clamped to the 600s ceiling, so
			// advancing 600s releases the wait.
			const promise = tool.execute("wait-1", { jobIds: [jobId], timeout: 86_400 }, makeContext(host));
			await vi.advanceTimersByTimeAsync(600_000);
			const result = await promise;

			expect(result.details.outcome).toBe("timed_out");
			expect(result.details.jobs).toEqual([{ jobId, toolName: "bash", name: undefined, state: "running" }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not claim jobs finished when every requested id is unknown", async () => {
		const { host } = await createJobRuntimeHarness();
		const tool = createWaitForJobsToolDefinition();

		const result = await tool.execute("wait-1", { jobIds: ["job-404"] }, makeContext(host));

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("may have already finished"),
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.not.stringContaining("Background jobs finished"),
		});
	});

	it("reports no registry when the background job table is absent", async () => {
		const tool = createWaitForJobsToolDefinition();
		const result = await tool.execute("wait-1", { jobIds: ["job-1"] }, makeContext(undefined));

		expect(result.details).toEqual({ outcome: "completed", jobs: [] });
		expect(result.content[0]).toMatchObject({ type: "text" });
	});
});
