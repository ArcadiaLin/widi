/**
 * The pure half of job persistence: what a chain of records reduces to, and
 * which open jobs a runtime has to close.
 *
 * Every case here is a boundary or a fault. The happy path is one test; the
 * rest are the shapes a killed process, a hand-edited log, or a newer build
 * leaves behind.
 */

import { describe, expect, it } from "vitest";
import {
	boundJobRecord,
	jobOutputFileName,
	planJobClosures,
	reduceJobRecords,
	toJobRecord,
} from "../../src/core/background/job-persistence.ts";
import {
	type JobClosedRecord,
	type JobSettledRecord,
	type JobStartedRecord,
	MAX_PERSISTED_JOB_MESSAGE_BYTES,
	MAX_PERSISTED_JOB_OUTPUT_BYTES,
} from "../../src/core/background/types.ts";

function started(overrides: Partial<JobStartedRecord> = {}): JobStartedRecord {
	return {
		kind: "started",
		toolCallId: "call-1",
		jobId: "job-1",
		ownerAgentId: "coder",
		sessionId: "coder",
		toolName: "bash",
		startedAt: 10,
		backgroundedAt: 20,
		outputFile: jobOutputFileName("call-1"),
		...overrides,
	};
}

function settled(overrides: Partial<JobSettledRecord> = {}): JobSettledRecord {
	return { kind: "settled", toolCallId: "call-1", status: "completed", endedAt: 30, messageText: "done", ...overrides };
}

function closed(overrides: Partial<JobClosedRecord> = {}): JobClosedRecord {
	return { kind: "closed", toolCallId: "call-1", cause: "resume", closedAt: 40, ...overrides };
}

describe("reduceJobRecords", () => {
	it("carries a started job's identity through to its settlement", () => {
		const jobs = reduceJobRecords([
			started({ name: "build", description: "npm run build" }),
			settled({ status: "failed", stopReason: "exit 1", outputTail: "boom" }),
		]);
		expect(jobs).toEqual([
			{
				toolCallId: "call-1",
				jobId: "job-1",
				ownerAgentId: "coder",
				sessionId: "coder",
				toolName: "bash",
				name: "build",
				description: "npm run build",
				startedAt: 10,
				backgroundedAt: 20,
				outputFile: jobOutputFileName("call-1"),
				state: "settled",
				status: "failed",
				stopReason: "exit 1",
				endedAt: 30,
				messageText: "done",
				outputTail: "boom",
			},
		]);
	});

	it("leaves a job with no terminal record open", () => {
		const jobs = reduceJobRecords([started()]);
		expect(jobs[0]?.state).toBe("open");
		expect(jobs[0]?.status).toBeUndefined();
	});

	it("keeps the cause of a closure readable without inspecting anything else", () => {
		const jobs = reduceJobRecords([started(), closed({ cause: "dispose", stopReason: "agent disposed" })]);
		expect(jobs[0]).toMatchObject({ state: "closed", cause: "dispose", stopReason: "agent disposed", endedAt: 40 });
		expect(jobs[0]?.status).toBeUndefined();
	});

	it("drops a terminal record whose job was never started on this chain", () => {
		expect(reduceJobRecords([settled(), closed()])).toEqual([]);
	});

	it("keeps the first terminal record when a second one arrives", () => {
		const settledFirst = reduceJobRecords([started(), settled(), closed()]);
		expect(settledFirst[0]).toMatchObject({ state: "settled" });
		const closedFirst = reduceJobRecords([started(), closed(), settled()]);
		expect(closedFirst[0]).toMatchObject({ state: "closed", cause: "resume" });
	});

	it("keeps the first head when a tool call id is started twice", () => {
		const jobs = reduceJobRecords([started({ jobId: "job-1" }), started({ jobId: "job-9", toolName: "other" })]);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({ jobId: "job-1", toolName: "bash" });
	});

	it("orders jobs by when they started, not by when they ended", () => {
		const jobs = reduceJobRecords([
			started({ toolCallId: "a", outputFile: "a.log" }),
			started({ toolCallId: "b", outputFile: "b.log" }),
			settled({ toolCallId: "b" }),
			settled({ toolCallId: "a" }),
		]);
		expect(jobs.map((job) => job.toolCallId)).toEqual(["a", "b"]);
	});
});

describe("toJobRecord", () => {
	it("accepts the three record kinds", () => {
		expect(toJobRecord(started())).toEqual(started());
		expect(toJobRecord(settled())).toEqual(settled());
		expect(toJobRecord(closed())).toEqual(closed());
	});

	it("rejects a kind this build does not know", () => {
		expect(toJobRecord({ ...started(), kind: "paused" })).toBeUndefined();
	});

	it("rejects a record missing the key everything else hangs off", () => {
		const { toolCallId: _dropped, ...headless } = started();
		expect(toJobRecord(headless)).toBeUndefined();
	});

	it("rejects a closure with a cause this build cannot name", () => {
		expect(toJobRecord({ ...closed(), cause: "vacuumed" })).toBeUndefined();
	});

	it("rejects values that are not records at all", () => {
		for (const value of [null, undefined, 7, "started", [started()]]) {
			expect(toJobRecord(value)).toBeUndefined();
		}
	});
});

describe("boundJobRecord", () => {
	it("leaves a record with no stored text alone", () => {
		expect(boundJobRecord(started())).toEqual(started());
		expect(boundJobRecord(closed())).toEqual(closed());
	});

	it("keeps the head of an oversized t1 and the tail of oversized output", () => {
		const record = boundJobRecord(
			settled({
				messageText: `START${"m".repeat(MAX_PERSISTED_JOB_MESSAGE_BYTES)}`,
				outputTail: `${"o".repeat(MAX_PERSISTED_JOB_OUTPUT_BYTES)}END`,
			}),
		) as JobSettledRecord;
		expect(record.messageText.startsWith("START")).toBe(true);
		expect(record.messageText).toContain("were not stored");
		expect(record.outputTail?.endsWith("END")).toBe(true);
		expect(record.outputTail).toContain("were not stored");
	});

	it("drops an empty output tail rather than storing a blank field", () => {
		const record = boundJobRecord(settled({ outputTail: "" })) as JobSettledRecord;
		expect(record.outputTail).toBeUndefined();
	});
});

describe("planJobClosures", () => {
	const openJobs = reduceJobRecords([
		started({ toolCallId: "a", outputFile: "a.log" }),
		started({ toolCallId: "b", outputFile: "b.log" }),
		started({ toolCallId: "c", outputFile: "c.log" }),
		settled({ toolCallId: "c" }),
	]);

	it("closes what the branch has open and the runtime does not hold", () => {
		const plan = planJobClosures({ jobs: openJobs, recognized: new Set(["a"]), cause: "navigate", closedAt: 99 });
		expect(plan).toEqual([{ kind: "closed", toolCallId: "b", cause: "navigate", closedAt: 99 }]);
	});

	it("closes everything when the runtime holds nothing", () => {
		const plan = planJobClosures({
			jobs: openJobs,
			recognized: new Set(),
			cause: "dispose",
			closedAt: 99,
			stopReason: "agent disposed",
		});
		expect(plan.map((record) => record.toolCallId)).toEqual(["a", "b"]);
		expect(plan.every((record) => record.stopReason === "agent disposed")).toBe(true);
	});

	it("never reopens a job that already has a terminal record", () => {
		const plan = planJobClosures({
			jobs: reduceJobRecords([started(), closed({ cause: "abort" })]),
			recognized: new Set(),
			cause: "resume",
			closedAt: 99,
		});
		expect(plan).toEqual([]);
	});

	it("writes nothing when every open job is still recognized", () => {
		const plan = planJobClosures({ jobs: openJobs, recognized: new Set(["a", "b"]), cause: "navigate", closedAt: 99 });
		expect(plan).toEqual([]);
	});
});

describe("jobOutputFileName", () => {
	it("is stable for one tool call id", () => {
		expect(jobOutputFileName("toolu_01A")).toBe(jobOutputFileName("toolu_01A"));
	});

	it("separates ids that differ only where a path cannot", () => {
		expect(jobOutputFileName("a/b")).not.toBe(jobOutputFileName("a-b"));
	});

	it("produces a single safe path segment for hostile ids", () => {
		for (const id of ["../../etc/passwd", "a\\b:c*d", "", "  ", "."]) {
			expect(jobOutputFileName(id)).toMatch(/^[A-Za-z0-9_-]*-[0-9a-f]{8}\.log$/);
		}
	});

	it("bounds the name a very long id produces", () => {
		expect(jobOutputFileName("x".repeat(4096)).length).toBeLessThanOrEqual(80);
	});
});
