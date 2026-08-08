/**
 * One agent's job store: the branch decides what is open, the store writes what
 * closes it.
 *
 * The cases that matter are the ones where the branch and this process disagree
 * - a rewound branch, an inherited one, a ref that will not land - because that
 * disagreement is the whole reason the state lives on the branch.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	JOBS_NAMESPACE,
	JobHistoryStorage,
	jobOutputFileName,
	SessionJobStore,
} from "../../src/core/background/job-persistence.ts";
import type { JobBranchPort, JobRecord, JobStartedRecord } from "../../src/core/background/types.ts";
import type { NamespaceProjection } from "../../src/core/persistence/index.ts";
import { PersistenceDiagnostics } from "../../src/core/persistence/index.ts";
import { MemoryFileSystem } from "../helpers/memory-fs.ts";

const DIR = "/runs/--w--/root/persistence/core__jobs";

/**
 * The orchestrator's side of the port, reduced to what it means: a list of
 * committed roots, the last one being the one in force.
 */
class FakeBranch implements JobBranchPort {
	committed: (string | null)[] = [];
	failNextCommit = false;

	async projection(): Promise<NamespaceProjection | undefined> {
		if (this.committed.length === 0) return undefined;
		return {
			namespace: JOBS_NAMESPACE,
			stateRoot: this.committed[this.committed.length - 1] ?? null,
			refs: [],
			provenance: "current",
		};
	}

	async commit(stateRoot: string | null): Promise<void> {
		if (this.failNextCommit) {
			this.failNextCommit = false;
			throw new Error("the harness refused this write");
		}
		this.committed.push(stateRoot);
	}

	/** Drop the last `count` refs, as rewinding the conversation would. */
	rewind(count: number): void {
		this.committed = this.committed.slice(0, Math.max(0, this.committed.length - count));
	}
}

function started(toolCallId: string): JobStartedRecord {
	return {
		kind: "started",
		toolCallId,
		jobId: `job-${toolCallId}`,
		ownerAgentId: "coder",
		sessionId: "coder",
		toolName: "bash",
		startedAt: 1,
		backgroundedAt: 2,
		outputFile: jobOutputFileName(toolCallId),
	};
}

function settled(toolCallId: string): JobRecord {
	return { kind: "settled", toolCallId, status: "completed", endedAt: 9, messageText: "ok" };
}

let fs: MemoryFileSystem;
let branch: FakeBranch;

async function openStore(): Promise<SessionJobStore> {
	return await SessionJobStore.open({
		storage: await JobHistoryStorage.open({
			fs,
			dirPath: DIR,
			sessionKey: ["root"],
			diagnostics: new PersistenceDiagnostics(),
		}),
		branch,
	});
}

beforeEach(() => {
	fs = new MemoryFileSystem();
	branch = new FakeBranch();
});

describe("SessionJobStore", () => {
	it("starts empty on a branch that never ran a job", async () => {
		const store = await openStore();
		expect(store.history()).toEqual([]);
		expect(store.carriedOverJobs()).toEqual([]);
		expect(store.stateRoot).toBeNull();
	});

	it("puts one ref on the branch per record", async () => {
		const store = await openStore();
		await store.append(started("a"));
		await store.append(settled("a"));
		expect(branch.committed).toHaveLength(2);
		expect(store.history().map((job) => job.state)).toEqual(["settled"]);
	});

	it("reads back what an earlier run left open", async () => {
		const first = await openStore();
		await first.append(started("a"));
		await first.append(started("b"));
		await first.append(settled("b"));

		const second = await openStore();
		expect(second.carriedOverJobs().map((job) => job.toolCallId)).toEqual(["a"]);
		expect(second.history()).toHaveLength(2);
	});

	it("does not see a job whose start the branch was rewound past", async () => {
		const first = await openStore();
		await first.append(started("a"));
		branch.rewind(1);

		const second = await openStore();
		expect(second.history()).toEqual([]);
		expect(second.stateRoot).toBeNull();
	});

	it("keeps a carried-over set frozen at open, not tracking later writes", async () => {
		const first = await openStore();
		await first.append(started("a"));

		const second = await openStore();
		await second.append(started("b"));
		expect(second.carriedOverJobs().map((job) => job.toolCallId)).toEqual(["a"]);
	});

	it("chains each record onto the root the branch currently names", async () => {
		const store = await openStore();
		const rootA = await store.append(started("a"));
		const rootB = await store.append(started("b"));
		expect(rootB).not.toBe(rootA);
		expect(branch.committed).toEqual([rootA, rootB]);
	});

	it("serializes concurrent transitions without losing either branch ref", async () => {
		const store = await openStore();
		const roots = await Promise.all([store.append(started("a")), store.append(started("b"))]);

		expect(new Set(roots).size).toBe(2);
		expect(branch.committed).toEqual(roots);
		expect((await openStore()).history().map((job) => job.toolCallId)).toEqual(["a", "b"]);
	});
});

describe("SessionJobStore closure", () => {
	it("closes what the branch has open and this runtime does not hold", async () => {
		const first = await openStore();
		await first.append(started("a"));
		await first.append(started("b"));

		const second = await openStore();
		const closed = await second.seal({ cause: "resume", recognized: new Set(["b"]) });
		expect(closed.map((record) => record.toolCallId)).toEqual(["a"]);
		expect(second.history().map((job) => [job.toolCallId, job.state, job.cause])).toEqual([
			["a", "closed", "resume"],
			["b", "open", undefined],
		]);
	});

	it("writes nothing to the branch when there is nothing to close", async () => {
		const store = await openStore();
		await store.append(started("a"));
		const before = branch.committed.length;
		await store.seal({ cause: "navigate", recognized: new Set(["a"]) });
		expect(branch.committed).toHaveLength(before);
	});

	it("is idempotent across a second interrupted run", async () => {
		const first = await openStore();
		await first.append(started("a"));

		const second = await openStore();
		await second.seal({ cause: "resume", recognized: new Set() });
		const third = await openStore();
		expect(await third.seal({ cause: "resume", recognized: new Set() })).toEqual([]);
	});
});

describe("SessionJobStore rebind", () => {
	it("hands a rewound branch the outcome this runtime already saw", async () => {
		const store = await openStore();
		await store.append(started("a"));
		await store.append(settled("a"));
		// The conversation moved back to a point where this job was still running.
		// It is not running - it finished, on the branch that was left behind.
		branch.rewind(1);
		const announced: string[][] = [];

		const records = await store.rebind({ cause: "navigate", recognized: new Set() }, async (jobs) => {
			announced.push(jobs.map((job) => job.messageText ?? ""));
		});

		expect(records.map((record) => record.kind)).toEqual(["settled"]);
		expect(announced).toEqual([["ok"]]);
		expect(store.history().map((job) => [job.toolCallId, job.state, job.status])).toEqual([
			["a", "settled", "completed"],
		]);
	});

	it("closes what no runtime can account for, and leaves alone what one still holds", async () => {
		const first = await openStore();
		await first.append(started("a"));
		await first.append(started("b"));

		// A fresh store knows nothing about either job, so only the one its caller
		// still holds an executor for survives.
		const second = await openStore();
		const records = await second.rebind({ cause: "navigate", recognized: new Set(["b"]) }, async () => {});

		expect(records.map((record) => [record.toolCallId, record.kind])).toEqual([["a", "closed"]]);
		expect(second.history().map((job) => [job.toolCallId, job.state])).toEqual([
			["a", "closed"],
			["b", "open"],
		]);
	});

	it("chains onto the branch's root again after the leaf moved", async () => {
		const store = await openStore();
		const rootA = await store.append(started("a"));
		await store.append(started("b"));
		branch.rewind(1);

		// Nothing to settle: `a` is still open on the rewound branch and its caller
		// still holds it. What must change is where the next record chains from.
		await store.rebind({ cause: "navigate", recognized: new Set(["a"]) }, async () => {});
		expect(store.stateRoot).toBe(rootA);
		const next = await store.append(settled("a"));
		expect(branch.committed[branch.committed.length - 1]).toBe(next);
		expect((await openStore()).history().map((job) => job.toolCallId)).toEqual(["a"]);
	});

	it("says nothing when the branch and this runtime already agree", async () => {
		const store = await openStore();
		await store.append(started("a"));
		const before = branch.committed.length;
		let announcements = 0;

		await store.rebind({ cause: "navigate", recognized: new Set(["a"]) }, async () => {
			announcements += 1;
		});

		expect(announcements).toBe(0);
		expect(branch.committed).toHaveLength(before);
	});
});

describe("SessionJobStore under a failing branch", () => {
	it("rejects and leaves the branch's root where it was", async () => {
		const store = await openStore();
		const root = await store.append(started("a"));
		branch.failNextCommit = true;
		await expect(store.append(started("b"))).rejects.toThrow(/refused/);
		expect(store.stateRoot).toBe(root);
		expect(branch.committed).toHaveLength(1);
	});

	it("keeps this process's own view of the job it failed to record", async () => {
		const store = await openStore();
		branch.failNextCommit = true;
		await expect(store.append(started("a"))).rejects.toThrow(/refused/);
		expect(store.history().map((job) => job.toolCallId)).toEqual(["a"]);
		expect((await openStore()).history()).toEqual([]);
	});

	it("goes on recording after a refused write instead of wedging", async () => {
		const store = await openStore();
		branch.failNextCommit = true;
		await expect(store.append(started("a"))).rejects.toThrow(/refused/);
		await store.append(started("b"));
		expect((await openStore()).history().map((job) => job.toolCallId)).toEqual(["b"]);
	});
});

describe("SessionJobStore output", () => {
	it("names a job's output file under its own namespace directory", async () => {
		const store = await openStore();
		const path = await store.outputFilePath("call-1");
		expect(path).toBe(`${DIR}/output/${jobOutputFileName("call-1")}`);
	});

	it("creates the output directory only when asked", async () => {
		const store = await openStore();
		expect(fs.dirs.has(`${DIR}/output`)).toBe(false);
		await store.ensureOutputDir();
		expect(fs.dirs.has(`${DIR}/output`)).toBe(true);
	});
});
