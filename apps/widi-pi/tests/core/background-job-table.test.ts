import { describe, expect, it, vi } from "vitest";
import {
	type BackgroundJobChange,
	BackgroundJobTable,
	type BackgroundJobTransition,
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
});
