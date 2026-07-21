import { describe, expect, it, vi } from "vitest";
import {
	type BackgroundJobSettlement,
	BackgroundJobTable,
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

	it("notifies result listeners only after a job is backgrounded", () => {
		const table = new BackgroundJobTable();
		const settlements: BackgroundJobSettlement[] = [];
		table.onResult((settlement) => settlements.push(settlement));

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		expect(table.background(job.id)).toBe(true);
		expect(job.phase).toBe("backgrounded");

		const outcome = { status: "completed" as const };
		expect(table.settle(job.id, outcome)).toBe("backgrounded");
		expect(settlements).toEqual([{ job, outcome }]);
		// The job is removed once it settles.
		expect(table.get(job.id)).toBeUndefined();
		expect(table.list()).toEqual([]);
	});

	it("settles inline without notifying when the deadline never fired", () => {
		const table = new BackgroundJobTable();
		const listener = vi.fn();
		table.onResult(listener);

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

	it("aborts a live job through its signal", () => {
		const table = new BackgroundJobTable();
		const job = table.create({ toolCallId: "call-1", toolName: "bash" });

		table.abort(job.id);
		expect(job.signal.aborted).toBe(true);
	});

	it("isolates listener failures from other listeners", () => {
		const table = new BackgroundJobTable();
		const good = vi.fn();
		table.onResult(() => {
			throw new Error("bad listener");
		});
		table.onResult(good);

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(job.id);
		expect(() => table.settle(job.id, { status: "completed" })).not.toThrow();
		expect(good).toHaveBeenCalledTimes(1);
	});

	it("stops delivering to unsubscribed listeners", () => {
		const table = new BackgroundJobTable();
		const listener = vi.fn();
		const unsubscribe = table.onResult(listener);
		unsubscribe();

		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(job.id);
		table.settle(job.id, { status: "completed" });
		expect(listener).not.toHaveBeenCalled();
	});
});
