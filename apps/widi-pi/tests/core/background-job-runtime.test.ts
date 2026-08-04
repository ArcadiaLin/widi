/**
 * The background job runtime: the only place job state changes, and the only
 * authority on who may change it.
 *
 * The cases here are the boundaries a caller can actually reach - the
 * pre-t0 window that is not observable, the settlement authority of an external
 * job, and the throttles that decide when an observer hears about progress.
 */

import { describe, expect, it, vi } from "vitest";
import {
	type BackgroundJobChange,
	type BackgroundJobEvent,
	type BackgroundJobReport,
	type BackgroundJobTransition,
	formatBackgroundJobResultMessageText,
	MAX_BACKGROUND_JOB_REPORT_BYTES,
} from "../../src/core/background/index.ts";
import { collectJobChanges, createJobRuntimeHarness, startBackgroundedJob } from "../helpers/background-jobs.ts";

function transitionsOf(changes: readonly BackgroundJobChange[]): BackgroundJobTransition[] {
	return changes.map((change) => change.transition);
}

/**
 * Observers are fed from the owner's serialized side-effect tail, so a change
 * is delivered on a later turn of the loop than the call that caused it.
 */
async function settleSideEffects(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function progressEvents(events: readonly BackgroundJobEvent[]): BackgroundJobEvent[] {
	return events.filter((event) => event.type === "job_progress");
}

function reportEvents(events: readonly BackgroundJobEvent[]): BackgroundJobEvent[] {
	return events.filter((event) => event.type === "job_report");
}

describe("BackgroundJobRuntime lifecycle", () => {
	it("starts a candidate that is not observable and has a live signal", async () => {
		const { host } = await createJobRuntimeHarness();
		const started = host.startLocal({ toolCallId: "call-1", toolName: "bash" });
		if (!started.ok) throw new Error("Expected a local job.");

		expect(started.execution.jobId).toBe("job-1");
		expect(started.execution.signal.aborted).toBe(false);
		// The observable world starts at t0: a candidate is listed nowhere.
		expect(host.list()).toEqual([]);
		expect(host.read("job-1")).toEqual({ ok: false, reason: "not_backgrounded" });
	});

	it("publishes a change when a job is backgrounded and when it settles", async () => {
		const { host } = await createJobRuntimeHarness();
		const { changes } = collectJobChanges(host);
		const started = host.startLocal({ toolCallId: "call-1", toolName: "bash" });
		if (!started.ok) throw new Error("Expected a local job.");
		expect(changes).toEqual([]);

		const accepted = started.execution.acceptBackground();
		expect(accepted.ok).toBe(true);
		expect(started.execution.settle({ status: "completed" })).toEqual({ ok: true, disposition: "backgrounded" });

		await settleSideEffects();
		expect(transitionsOf(changes)).toEqual(["backgrounded", "settled"]);
		// The job leaves the live index once it settles.
		expect(host.list()).toEqual([]);
		expect(host.read("job-1")).toEqual({ ok: false, reason: "unknown_job" });
	});

	it("settles inline without publishing anything when the deadline never fired", async () => {
		const { host } = await createJobRuntimeHarness();
		const { changes } = collectJobChanges(host);
		const started = host.startLocal({ toolCallId: "call-1", toolName: "bash" });
		if (!started.ok) throw new Error("Expected a local job.");

		expect(started.execution.settle({ status: "completed" })).toEqual({ ok: true, disposition: "inline" });
		await settleSideEffects();
		expect(changes).toEqual([]);
	});

	it("refuses to background a job that already settled inline, and ignores a second settle", async () => {
		const { host } = await createJobRuntimeHarness();
		const started = host.startLocal({ toolCallId: "call-1", toolName: "bash" });
		if (!started.ok) throw new Error("Expected a local job.");

		expect(started.execution.settle({ status: "completed" })).toEqual({ ok: true, disposition: "inline" });
		expect(started.execution.acceptBackground()).toEqual({ ok: false, reason: "unknown_job" });
		expect(started.execution.settle({ status: "failed" })).toEqual({ ok: false, reason: "unknown_job" });
	});

	it("publishes abort_requested once, ordered before the settlement", async () => {
		const { host } = await createJobRuntimeHarness();
		const { changes } = collectJobChanges(host);
		const { execution, job } = startBackgroundedJob(host);

		expect(host.abort(job.jobId)).toEqual({ ok: true });
		expect(execution.signal.aborted).toBe(true);
		// Repeated aborts are silent.
		expect(host.abort(job.jobId)).toEqual({ ok: true });

		execution.settle({ status: "cancelled" });
		await settleSideEffects();
		expect(transitionsOf(changes)).toEqual(["backgrounded", "abort_requested", "settled"]);
	});

	it("refuses to abort a candidate, whose signal nobody outside the call holds", async () => {
		const { host } = await createJobRuntimeHarness();
		const { changes } = collectJobChanges(host);
		const started = host.startLocal({ toolCallId: "call-1", toolName: "bash" });
		if (!started.ok) throw new Error("Expected a local job.");

		expect(host.abort(started.execution.jobId)).toEqual({ ok: false, reason: "not_backgrounded" });
		expect(started.execution.signal.aborted).toBe(false);
		await settleSideEffects();
		expect(changes).toEqual([]);
	});

	it("stops delivering to a watcher that unsubscribed", async () => {
		const { host } = await createJobRuntimeHarness();
		const { changes, stop } = collectJobChanges(host);
		stop();

		const { execution } = startBackgroundedJob(host);
		execution.settle({ status: "completed" });
		await settleSideEffects();
		expect(changes).toEqual([]);
	});

	it("carries the caller's name and description onto the snapshot", async () => {
		const { host } = await createJobRuntimeHarness();
		const { job } = startBackgroundedJob(host, { name: "nightly build", description: "npm run build" });

		expect(job).toMatchObject({ name: "nightly build", description: "npm run build", toolName: "bash" });
	});
});

describe("BackgroundJobRuntime structured reports", () => {
	it("stores an initial report as a detached, frozen, revisioned snapshot", async () => {
		const source = {
			kind: "test.plan",
			schemaVersion: 1,
			summary: "First step",
			progress: { completed: 0, total: 1 },
			data: { items: ["first"] },
		} satisfies BackgroundJobReport;
		const { host } = await createJobRuntimeHarness();
		const started = host.startLocal({ toolCallId: "call-1", toolName: "planner", report: source });
		if (!started.ok) throw new Error("Expected a local job.");
		const accepted = started.execution.acceptBackground();
		if (!accepted.ok) throw new Error("Expected the job to background.");

		source.data.items.push("mutated later");
		expect(accepted.job.report).toMatchObject({
			revision: 1,
			updatedAt: expect.any(Number),
			value: { kind: "test.plan", data: { items: ["first"] } },
		});
		expect(Object.isFrozen(accepted.job.report)).toBe(true);
		expect(Object.isFrozen(accepted.job.report?.value.data)).toBe(true);
	});

	it("keeps pre-t0 reports silent and includes the latest one at backgrounding", async () => {
		const { host, events } = await createJobRuntimeHarness({ reportThrottleMs: 0 });
		const { changes } = collectJobChanges(host);
		const started = host.startLocal({ toolCallId: "call-1", toolName: "planner" });
		if (!started.ok) throw new Error("Expected a local job.");

		expect(started.execution.setReport({ kind: "test.plan", schemaVersion: 1, summary: "Prepared" })).toEqual({
			ok: true,
		});
		expect(reportEvents(events)).toEqual([]);

		started.execution.acceptBackground();
		await settleSideEffects();
		expect(changes[0]?.job.report).toMatchObject({ revision: 1, value: { summary: "Prepared" } });
		expect(reportEvents(events)).toEqual([]);
	});

	it("coalesces reports and flushes the final revision before the settlement", async () => {
		const { host, events } = await createJobRuntimeHarness({ reportThrottleMs: 10_000 });
		const { execution } = startBackgroundedJob(host, { toolName: "planner" });

		for (const completed of [1, 2, 3]) {
			execution.setReport({ kind: "test.plan", schemaVersion: 1, progress: { completed, total: 3 } });
		}
		await settleSideEffects();
		expect(reportEvents(events)).toEqual([]);

		execution.settle({ status: "completed" });
		await settleSideEffects();
		const flushed = reportEvents(events);
		expect(flushed).toHaveLength(1);
		expect(flushed[0]).toMatchObject({ report: { revision: 3 } });
		// `settled` is a barrier: the final report is published ahead of it.
		expect(events.map((event) => event.type)).toEqual(["job_changed", "job_report", "job_changed"]);
	});

	it("rejects an invalid or oversized report without advancing the revision", async () => {
		const { host } = await createJobRuntimeHarness();
		const { execution, job } = startBackgroundedJob(host, { toolName: "planner" });
		execution.setReport({ kind: "test.plan", schemaVersion: 1, summary: "valid" });

		expect(() =>
			execution.setReport({ kind: "test.plan", schemaVersion: 1, progress: { completed: 2, total: 1 } }),
		).toThrow(/cannot exceed total/);
		expect(() =>
			execution.setReport({
				kind: "test.plan",
				schemaVersion: 1,
				data: { text: "x".repeat(MAX_BACKGROUND_JOB_REPORT_BYTES) },
			}),
		).toThrow(/exceeds/);
		const read = host.read(job.jobId);
		expect(read.ok && read.read.job.report?.revision).toBe(1);
	});
});

describe("BackgroundJobRuntime output", () => {
	it("publishes progress on the first append after t0", async () => {
		const { host, events } = await createJobRuntimeHarness();
		const { execution, job } = startBackgroundedJob(host);

		execution.output.append("first line\n");

		await settleSideEffects();
		expect(progressEvents(events)).toHaveLength(1);
		expect(progressEvents(events)[0]).toMatchObject({ jobId: job.jobId });
	});

	it("withholds pre-t0 output and publishes it once the job is backgrounded", async () => {
		const { host, events } = await createJobRuntimeHarness();
		const started = host.startLocal({ toolCallId: "call-1", toolName: "bash" });
		if (!started.ok) throw new Error("Expected a local job.");

		started.execution.output.append("early output");
		await settleSideEffects();
		expect(progressEvents(events)).toEqual([]);

		started.execution.acceptBackground();
		await settleSideEffects();
		const published = progressEvents(events);
		expect(published).toHaveLength(1);
		const chunk = published[0]?.type === "job_progress" ? published[0].chunk : "";
		expect(Buffer.from(chunk, "base64").toString("utf-8")).toBe("early output");
	});

	it("never publishes progress for a job that settles inline", async () => {
		const { host, events } = await createJobRuntimeHarness();
		const started = host.startLocal({ toolCallId: "call-1", toolName: "bash" });
		if (!started.ok) throw new Error("Expected a local job.");

		started.execution.output.append("inline output");
		started.execution.settle({ status: "completed" });

		await settleSideEffects();
		expect(progressEvents(events)).toEqual([]);
	});

	it("coalesces a burst of appends within the throttle window", async () => {
		const { host, events } = await createJobRuntimeHarness({ progressThrottleMs: 10_000 });
		const { execution } = startBackgroundedJob(host);

		execution.output.append("a");
		execution.output.append("b");
		execution.output.append("c");

		// One immediate emit; the rest fold into a single trailing timer the long
		// throttle keeps pending, so no further emits fire.
		await settleSideEffects();
		expect(progressEvents(events)).toHaveLength(1);
	});

	it("trips the output ceiling once and aborts the job", async () => {
		const { host } = await createJobRuntimeHarness({ outputCeilingBytes: 8 });
		const { changes } = collectJobChanges(host);
		const { execution, job } = startBackgroundedJob(host);

		execution.output.append("0123456789"); // 10 bytes > 8-byte ceiling

		expect(execution.signal.aborted).toBe(true);
		const read = host.read(job.jobId);
		expect(read.ok && read.read.job.stopReason).toContain("Output limit exceeded");

		// The trip is one-shot: further output does not re-abort or re-publish.
		execution.output.append("more");
		execution.settle({ status: "cancelled" });
		await settleSideEffects();
		expect(transitionsOf(changes)).toEqual(["backgrounded", "abort_requested", "settled"]);
	});
});

describe("BackgroundJobRuntime settlement", () => {
	it("records a terminal reason for failures and for unexplained cancellation", async () => {
		const { host } = await createJobRuntimeHarness();
		const { changes } = collectJobChanges(host);

		const failed = startBackgroundedJob(host, { toolCallId: "call-failed" });
		failed.execution.settle({ status: "failed", error: new Error("command failed") });

		const cancelled = startBackgroundedJob(host, { toolCallId: "call-cancelled" });
		cancelled.execution.settle({ status: "cancelled" });

		await settleSideEffects();
		const reasons = changes.flatMap((change) => (change.transition === "settled" ? [change.job.stopReason ?? ""] : []));
		expect(reasons).toEqual(["command failed", "The job was cancelled."]);
	});

	it("keeps partial tool output alongside an explicit cancellation reason", async () => {
		const { host } = await createJobRuntimeHarness();
		let resultText = "";
		host.watch().start((change) => {
			if (change.transition === "settled") resultText = formatBackgroundJobResultMessageText(change);
		});

		const { execution, job } = startBackgroundedJob(host);
		host.abort(job.jobId, "Cancellation requested by kill_job.");
		execution.settle({ status: "cancelled", error: new Error("partial output\n\nCommand aborted") });

		await settleSideEffects();
		expect(resultText).toContain("Cancellation requested by kill_job.");
		expect(resultText).toContain("partial output");
	});

	it("hands a settled job's text to its owner exactly once", async () => {
		const { host, deliveries, agentId } = await createJobRuntimeHarness();
		const { execution, job } = startBackgroundedJob(host);

		execution.settle({
			status: "completed",
			result: { content: [{ type: "text", text: "build done" }], details: undefined },
		});

		await vi.waitFor(() => expect(deliveries).toHaveLength(1));
		expect(deliveries[0]).toMatchObject({ ownerAgentId: agentId, jobId: job.jobId });
		expect(deliveries[0]?.body).toContain("build done");
	});
});

describe("BackgroundJobRuntime external jobs", () => {
	it("defaults a local job's origin to the call that started it", async () => {
		const { host } = await createJobRuntimeHarness();
		const { job } = startBackgroundedJob(host);

		expect(job.origin).toEqual({ kind: "local" });
	});

	it("accepts an external job's outcome only from its named settler", async () => {
		const harness = await createJobRuntimeHarness({ agentId: "owner" });
		const worker = await harness.attach("agent-worker");
		const intruder = await harness.attach("agent-intruder");
		const created = await harness.host.createExternal({
			toolCallId: "call-assign",
			toolName: "assign_agent_task",
			settlerAgentId: "agent-worker",
		});
		if (!created.ok) throw new Error(`Expected an external job, got ${created.reason}.`);

		expect(
			intruder.settler.settle({ ownerAgentId: "owner", jobId: created.job.jobId, outcome: { status: "completed" } }),
		).toEqual({ ok: false, reason: "not_settler" });
		expect(harness.host.list()).toHaveLength(1);

		expect(
			worker.settler.settle({ ownerAgentId: "owner", jobId: created.job.jobId, outcome: { status: "completed" } }),
		).toEqual({ ok: true });
		expect(harness.host.list()).toEqual([]);
	});

	// Nothing watches an external job's signal, so an abort that only fired the
	// signal would leave the job stuck in `abort_requested` forever.
	it("completes an aborted external job as cancelled by itself", async () => {
		const harness = await createJobRuntimeHarness({ agentId: "owner" });
		const worker = await harness.attach("agent-worker");
		const { changes } = collectJobChanges(harness.host);
		const created = await harness.host.createExternal({
			toolCallId: "call-assign",
			toolName: "assign_agent_task",
			settlerAgentId: "agent-worker",
		});
		if (!created.ok) throw new Error(`Expected an external job, got ${created.reason}.`);

		harness.host.abort(created.job.jobId, "Worker was killed");

		await settleSideEffects();
		expect(transitionsOf(changes)).toEqual(["backgrounded", "abort_requested", "settled"]);
		expect(harness.host.list()).toEqual([]);
		expect(
			worker.settler.settle({ ownerAgentId: "owner", jobId: created.job.jobId, outcome: { status: "completed" } }),
		).toEqual({ ok: false, reason: "unknown_job" });
	});

	it("cancels the work a detached settler still owed", async () => {
		const harness = await createJobRuntimeHarness({ agentId: "owner" });
		await harness.attach("agent-worker");
		const { changes } = collectJobChanges(harness.host);
		const created = await harness.host.createExternal({
			toolCallId: "call-assign",
			toolName: "assign_agent_task",
			settlerAgentId: "agent-worker",
		});
		if (!created.ok) throw new Error(`Expected an external job, got ${created.reason}.`);

		harness.runtime.detachAgent("agent-worker");

		// The owner stays live and learns the task will never be reported.
		await settleSideEffects();
		expect(transitionsOf(changes)).toContain("settled");
		expect(harness.host.list()).toEqual([]);
	});
});
