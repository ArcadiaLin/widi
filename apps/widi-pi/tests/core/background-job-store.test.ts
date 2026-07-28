import { describe, expect, it } from "vitest";
import type { BackgroundJobSnapshot } from "../../src/core/background/index.ts";
import {
	BackgroundJobStore,
	MAX_PERSISTED_JOB_MESSAGE_BYTES,
	MAX_PERSISTED_JOB_OUTPUT_BYTES,
} from "../../src/core/background/index.ts";
import { MemoryExecutionEnv } from "../helpers/orchestrator.ts";

const SESSION_DIR = "/sessions/--workspace--/2026-01-01_agent";
const LOG_PATH = `${SESSION_DIR}/jobs/jobs.jsonl`;

function snapshot(
	overrides: Partial<BackgroundJobSnapshot> = {},
): BackgroundJobSnapshot {
	return {
		jobId: "job-1",
		origin: { kind: "local" },
		toolCallId: "call-1",
		toolName: "bash",
		description: "npm test",
		phase: "backgrounded",
		startedAt: 1000,
		backgroundedAt: 1100,
		totalBytesSeen: 0,
		droppedBytes: 0,
		...overrides,
	};
}

async function openStore(
	fs: MemoryExecutionEnv,
	epoch: string,
	onWriteFailure?: (error: unknown) => void,
): Promise<BackgroundJobStore> {
	return await BackgroundJobStore.open({
		fs,
		sessionDir: SESSION_DIR,
		epoch,
		onWriteFailure,
	});
}

describe("BackgroundJobStore", () => {
	it("creates nothing until a job is actually recorded", async () => {
		const fs = new MemoryExecutionEnv();
		await openStore(fs, "epoch-1");
		expect(fs.files.has(LOG_PATH)).toBe(false);
	});

	it("replays a job's lifecycle into its latest state", async () => {
		const fs = new MemoryExecutionEnv();
		const store = await openStore(fs, "epoch-1");
		await store.recordBackgrounded(snapshot({ name: "run tests" }));
		expect(store.history()[0]?.name).toBe("run tests");
		await store.recordReport("job-1", {
			revision: 2,
			updatedAt: 1200,
			value: { kind: "widi.test", schemaVersion: 1, summary: "half way" },
		});
		await store.recordAborting(snapshot({ stopReason: "user asked" }));
		await store.recordSettled(
			snapshot({
				status: "cancelled",
				endedAt: 1300,
				stopReason: "user asked",
			}),
			{
				messageText: "Background job job-1 ... cancelled:",
				outputTail: "tail",
			},
		);

		const reopened = await openStore(fs, "epoch-2");
		expect(reopened.history()).toEqual([
			{
				epoch: "epoch-1",
				jobId: "job-1",
				toolCallId: "call-1",
				toolName: "bash",
				name: "run tests",
				description: "npm test",
				origin: { kind: "local" },
				startedAt: 1000,
				backgroundedAt: 1100,
				report: {
					revision: 2,
					updatedAt: 1200,
					value: { kind: "widi.test", schemaVersion: 1, summary: "half way" },
				},
				abortRequested: true,
				status: "cancelled",
				stopReason: "user asked",
				endedAt: 1300,
				messageText: "Background job job-1 ... cancelled:",
				outputTail: "tail",
			},
		]);
	});

	// Job ids restart from 1 in every runtime, so the epoch is what keeps two
	// runs' `job-1` from collapsing into one record.
	it("keeps same-id jobs from different runs apart", async () => {
		const fs = new MemoryExecutionEnv();
		const first = await openStore(fs, "epoch-1");
		await first.recordBackgrounded(snapshot({ toolCallId: "call-a" }));
		await first.recordSettled(snapshot({ status: "completed" }), {
			messageText: "first run result",
		});

		const second = await openStore(fs, "epoch-2");
		await second.recordBackgrounded(snapshot({ toolCallId: "call-b" }));

		expect(second.history().map((job) => job.epoch)).toEqual([
			"epoch-1",
			"epoch-2",
		]);
		const carriedOver = second.carriedOverJobs();
		expect(carriedOver).toHaveLength(1);
		expect(carriedOver[0]).toMatchObject({
			epoch: "epoch-1",
			toolCallId: "call-a",
			messageText: "first run result",
		});
	});

	// The shape a killed runtime leaves behind: the last line never finished.
	it("drops a torn trailing line instead of failing the read", async () => {
		const fs = new MemoryExecutionEnv();
		const store = await openStore(fs, "epoch-1");
		await store.recordBackgrounded(snapshot());
		await store.recordBackgrounded(snapshot({ jobId: "job-2" }));
		const written = fs.files.get(LOG_PATH) ?? "";
		fs.files.set(LOG_PATH, `${written.slice(0, written.length - 12)}`);

		const reopened = await openStore(fs, "epoch-2");
		expect(reopened.history().map((job) => job.jobId)).toEqual(["job-1"]);
	});

	// A refinement without its t0 head cannot describe a job on its own.
	it("ignores records whose job was never recorded as backgrounded", async () => {
		const fs = new MemoryExecutionEnv();
		fs.files.set(
			LOG_PATH,
			`${JSON.stringify({
				type: "settled",
				epoch: "epoch-1",
				jobId: "job-9",
				status: "completed",
				messageText: "orphan",
			})}\n`,
		);
		const store = await openStore(fs, "epoch-2");
		expect(store.history()).toEqual([]);
	});

	it("bounds a stored result and output tail", async () => {
		const fs = new MemoryExecutionEnv();
		const store = await openStore(fs, "epoch-1");
		await store.recordBackgrounded(snapshot());
		await store.recordSettled(snapshot({ status: "completed" }), {
			messageText: "m".repeat(MAX_PERSISTED_JOB_MESSAGE_BYTES + 500),
			outputTail: "o".repeat(MAX_PERSISTED_JOB_OUTPUT_BYTES + 500),
		});

		const job = store.history()[0];
		expect(job?.messageText?.startsWith("m".repeat(64))).toBe(true);
		expect(job?.messageText).toContain("500 more bytes were not stored");
		// The tail is what a tail is for: the end survives, the head is elided.
		expect(job?.outputTail?.endsWith("o".repeat(64))).toBe(true);
		expect(job?.outputTail).toContain("500 earlier bytes were not stored");
	});

	// A store that cannot write is degraded, not fatal, and says so exactly once.
	it("reports the first write failure and keeps serving replayed state", async () => {
		const fs = new MemoryExecutionEnv();
		const failures: unknown[] = [];
		const store = await openStore(fs, "epoch-1", (error) =>
			failures.push(error),
		);
		fs.createDir = async () => {
			throw new Error("read-only session directory");
		};

		await store.recordBackgrounded(snapshot());
		await store.recordSettled(snapshot({ status: "completed" }), {
			messageText: "never written",
		});

		expect(failures).toHaveLength(1);
		expect(fs.files.has(LOG_PATH)).toBe(false);
		expect(store.history()[0]).toMatchObject({
			jobId: "job-1",
			status: "completed",
		});
	});
});
