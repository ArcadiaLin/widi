import { describe, expect, it } from "vitest";
import {
	BackgroundJobTable,
	type BackgroundJobTransition,
} from "../../src/core/background-job.ts";
import { createKillJobToolDefinition } from "../../src/core/tools/jobs/kill-job.ts";

const killJob = createKillJobToolDefinition();

function contextWith(table?: BackgroundJobTable, signal?: AbortSignal) {
	return {
		signal,
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

/**
 * Register and background a job whose signal-abort settles it like the tool
 * adapter would: the settlement arrives on the abort, with the given status.
 */
function createSettlingJob(
	table: BackgroundJobTable,
	status: "cancelled" | "completed" | "failed" = "cancelled",
) {
	const job = table.create({ toolCallId: "call-1", toolName: "bash" });
	table.background(job.id);
	job.signal.addEventListener("abort", () => table.settle(job.id, { status }), {
		once: true,
	});
	return job;
}

describe("kill_job tool", () => {
	it("kills a backgrounded job and reports the confirmed cancellation", async () => {
		const table = new BackgroundJobTable();
		const transitions: BackgroundJobTransition[] = [];
		let abortReason: string | undefined;
		table.onChange((change) => {
			transitions.push(change.transition);
			if (change.transition === "aborting") {
				abortReason = change.job.stopReason;
			}
		});
		const job = createSettlingJob(table);

		const result = await killJob.execute(
			"call-2",
			{ jobIds: [job.id] },
			contextWith(table),
		);

		expect(result.details).toEqual({
			jobs: [{ jobId: job.id, toolName: "bash", state: "cancelled" }],
		});
		expect(textOf(result)).toContain(`${job.id} (bash): cancelled`);
		expect(abortReason).toBe("Cancellation requested by kill_job.");
		// The kill does not suppress the settlement: t1 routing still fires.
		expect(transitions).toEqual(["backgrounded", "aborting", "settled"]);
	});

	it("reports a job that finished on its own before the kill took effect", async () => {
		const table = new BackgroundJobTable();
		const job = createSettlingJob(table, "completed");

		const result = await killJob.execute(
			"call-2",
			{ jobIds: [job.id] },
			contextWith(table),
		);

		expect(result.details).toEqual({
			jobs: [{ jobId: job.id, toolName: "bash", state: "completed" }],
		});
	});

	it("reports aborting when the settlement does not arrive within the timeout", async () => {
		const table = new BackgroundJobTable();
		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(job.id);

		const result = await killJob.execute(
			"call-2",
			{ jobIds: [job.id], timeout: 0.05 },
			contextWith(table),
		);

		expect(job.signal.aborted).toBe(true);
		expect(result.details).toEqual({
			jobs: [{ jobId: job.id, toolName: "bash", state: "aborting" }],
		});
		expect(textOf(result)).toContain("abort sent");
	});

	it("sends the abort without waiting when timeout is 0", async () => {
		const table = new BackgroundJobTable();
		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(job.id);

		const result = await killJob.execute(
			"call-2",
			{ jobIds: [job.id], timeout: 0 },
			contextWith(table),
		);

		expect(job.signal.aborted).toBe(true);
		expect(result.details).toEqual({
			jobs: [{ jobId: job.id, toolName: "bash", state: "aborting" }],
		});
	});

	it("reports settled, unknown, and running-phase ids as unknown without touching them", async () => {
		const table = new BackgroundJobTable();
		const settled = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(settled.id);
		table.settle(settled.id, { status: "completed" });
		// Pre-t0 sync window: not observable, so not killable.
		const running = table.create({ toolCallId: "call-2", toolName: "bash" });

		const result = await killJob.execute(
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
		// A repeated kill is a no-op with no side effects: the running-phase job
		// was not aborted.
		expect(running.signal.aborted).toBe(false);
	});

	it("returns promptly with aborting when the call itself is interrupted", async () => {
		const table = new BackgroundJobTable();
		const job = table.create({ toolCallId: "call-1", toolName: "bash" });
		table.background(job.id);
		const controller = new AbortController();

		const execPromise = killJob.execute(
			"call-2",
			{ jobIds: [job.id], timeout: 30 },
			contextWith(table, controller.signal),
		);
		controller.abort();
		const result = await execPromise;

		expect(result.details).toEqual({
			jobs: [{ jobId: job.id, toolName: "bash", state: "aborting" }],
		});
	});
});
