import { describe, expect, it, vi } from "vitest";
import {
	type BackgroundJobChange,
	BackgroundJobTable,
	type BackgroundJobTransition,
	formatBackgroundJobResultMessageText,
} from "../../src/core/background-job.ts";

describe("BackgroundJobTable", () => {
	it("creates jobs in the running phase with a live signal", () => {
		const table = new BackgroundJobTable();
		const job = table.create({ toolCallId: "call-1", toolName: "bash" });

		expect(job.id).toBe("job-1");
		expect(job.phase).toBe("running");
		expect(job.signal.aborted).toBe(false);
		expect(table.get("job-1")).toBe(job);
		expect(table.list()).toEqual([job]);
	});

	it("allocates a live output buffer per job, reachable through the table", () => {
		const table = new BackgroundJobTable();
		const job = table.create({ toolCallId: "call-1", toolName: "bash" });

		job.output.append("progress line\n");
		expect(table.get("job-1")?.output.read()).toBe("progress line\n");

		// The buffer is the job's; once it settles the record — and its output —
		// is dropped from the table.
		table.background(job.id);
		table.settle(job.id, { status: "completed" });
		expect(table.get("job-1")).toBeUndefined();
	});

	it("emits a change when a job is backgrounded and when it settles", () => {
		const table = new BackgroundJobTable();
		const changes: BackgroundJobChange[] = [];
		table.onChange((change) => changes.push(change));

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		// The observable world starts at t0: create emits nothing.
		expect(changes).toEqual([]);

		expect(table.background(job.id)).toBe(true);
		expect(job.phase).toBe("backgrounded");

		const outcome = { status: "completed" as const };
		expect(table.settle(job.id, outcome)).toBe("backgrounded");
		expect(changes).toEqual([
			{ transition: "backgrounded", job },
			{ transition: "settled", job, outcome },
		]);
		// The job is removed once it settles.
		expect(table.get(job.id)).toBeUndefined();
		expect(table.list()).toEqual([]);
	});

	it("settles inline without emitting when the deadline never fired", () => {
		const table = new BackgroundJobTable();
		const listener = vi.fn();
		table.onChange(listener);

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		expect(table.settle(job.id, { status: "completed" })).toBe("inline");
		expect(listener).not.toHaveBeenCalled();
		expect(table.get(job.id)).toBeUndefined();
	});

	it("refuses to background a job that already settled inline", () => {
		const table = new BackgroundJobTable();
		const job = table.create({ toolCallId: "call-1", toolName: "bash" });

		expect(table.settle(job.id, { status: "completed" })).toBe("inline");
		expect(table.background(job.id)).toBe(false);
	});

	it("ignores a second settle for the same job", () => {
		const table = new BackgroundJobTable();
		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(job.id);

		expect(table.settle(job.id, { status: "completed" })).toBe("backgrounded");
		expect(table.settle(job.id, { status: "failed" })).toBe("ignored");
	});

	it("emits aborting once for a backgrounded job, ordered before its settlement", () => {
		const table = new BackgroundJobTable();
		const transitions: BackgroundJobTransition[] = [];
		table.onChange((change) => transitions.push(change.transition));

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(job.id);

		table.abort(job.id);
		expect(job.signal.aborted).toBe(true);
		// Repeated aborts are silent.
		table.abort(job.id);

		table.settle(job.id, { status: "cancelled" });
		expect(transitions).toEqual(["backgrounded", "aborting", "settled"]);
	});

	it("aborts a running-phase job through its signal without emitting", () => {
		const table = new BackgroundJobTable();
		const listener = vi.fn();
		table.onChange(listener);

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.abort(job.id);

		// The pre-t0 sync window is not observable: the signal fires, no change.
		expect(job.signal.aborted).toBe(true);
		expect(listener).not.toHaveBeenCalled();
	});

	it("isolates listener failures from other listeners", () => {
		const table = new BackgroundJobTable();
		const good = vi.fn();
		table.onChange(() => {
			throw new Error("bad listener");
		});
		table.onChange(good);

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		expect(() => table.background(job.id)).not.toThrow();
		expect(() => table.settle(job.id, { status: "completed" })).not.toThrow();
		expect(good).toHaveBeenCalledTimes(2);
	});

	it("stops delivering to unsubscribed listeners", () => {
		const table = new BackgroundJobTable();
		const listener = vi.fn();
		const unsubscribe = table.onChange(listener);
		unsubscribe();

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(job.id);
		table.settle(job.id, { status: "completed" });
		expect(listener).not.toHaveBeenCalled();
	});

	it("carries a description onto the job view", () => {
		const table = new BackgroundJobTable();
		const job = table.create({
			toolCallId: "call-1",
			toolName: "bash",
			description: "npm run build",
		});
		expect(job.description).toBe("npm run build");
	});

	it("notifies progress listeners immediately on the first append", () => {
		const table = new BackgroundJobTable();
		const progress = vi.fn();
		table.onProgress(progress);

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(job.id);
		job.output.append("first line\n");

		// The first append after the throttle window elapsed fires synchronously.
		expect(progress).toHaveBeenCalledTimes(1);
		expect(progress.mock.calls[0]?.[0]).toBe(job);
	});

	it("withholds pre-t0 output and publishes it after the job is backgrounded", () => {
		const table = new BackgroundJobTable();
		const progress = vi.fn();
		table.onProgress(progress);

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		job.output.append("early output");
		expect(progress).not.toHaveBeenCalled();

		table.background(job.id);
		expect(progress).toHaveBeenCalledTimes(1);
		expect(progress.mock.calls[0]?.[0]).toBe(job);
		expect(
			Buffer.from(job.output.drainIncrement()?.chunk ?? "", "base64").toString(
				"utf-8",
			),
		).toBe("early output");
	});

	it("never publishes progress for a job that settles inline", () => {
		const table = new BackgroundJobTable();
		const progress = vi.fn();
		table.onProgress(progress);

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		job.output.append("inline output");
		table.settle(job.id, { status: "completed" });

		expect(progress).not.toHaveBeenCalled();
	});

	it("coalesces a burst of appends within the throttle window", () => {
		const table = new BackgroundJobTable({ progressThrottleMs: 10_000 });
		const progress = vi.fn();
		table.onProgress(progress);

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(job.id);
		job.output.append("a");
		job.output.append("b");
		job.output.append("c");

		// One immediate emit; the rest fold into a single trailing timer that the
		// long throttle keeps pending, so no further synchronous emits fire.
		expect(progress).toHaveBeenCalledTimes(1);
	});

	it("trips the circuit breaker and aborts once past the output ceiling", () => {
		const table = new BackgroundJobTable({ outputCeilingBytes: 8 });
		const transitions: BackgroundJobTransition[] = [];
		table.onChange((change) => transitions.push(change.transition));

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(job.id);
		job.output.append("0123456789"); // 10 bytes > 8-byte ceiling

		expect(job.signal.aborted).toBe(true);
		expect(job.stopReason).toContain("Output limit exceeded");

		// The trip is one-shot: further output does not re-abort or re-emit.
		job.output.append("more");
		table.settle(job.id, { status: "cancelled" });
		expect(transitions).toEqual(["backgrounded", "aborting", "settled"]);
	});

	it("records a terminal reason for failures and otherwise unexplained cancellation", () => {
		const table = new BackgroundJobTable();
		const failures: string[] = [];
		table.onChange((change) => {
			if (change.transition === "settled") {
				failures.push(change.job.stopReason ?? "");
			}
		});

		const failed = table.create({
			toolCallId: "call-failed",
			toolName: "bash",
		});
		table.background(failed.id);
		table.settle(failed.id, {
			status: "failed",
			error: new Error("command failed"),
		});

		const cancelled = table.create({
			toolCallId: "call-cancelled",
			toolName: "bash",
		});
		table.background(cancelled.id);
		table.settle(cancelled.id, { status: "cancelled" });

		expect(failures).toEqual(["command failed", "The job was cancelled."]);
	});

	it("keeps partial tool output alongside an explicit cancellation reason", () => {
		const table = new BackgroundJobTable();
		let resultText = "";
		table.onChange((change) => {
			if (change.transition === "settled") {
				resultText = formatBackgroundJobResultMessageText(change);
			}
		});

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(job.id);
		table.abort(job.id, "Cancellation requested by kill_job.");
		table.settle(job.id, {
			status: "cancelled",
			error: new Error("partial output\n\nCommand aborted"),
		});

		expect(resultText).toContain("Cancellation requested by kill_job.");
		expect(resultText).toContain("partial output");
	});
});
