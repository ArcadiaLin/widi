/**
 * The `core:jobs` storage: a chain of records that resolves to a job table, and
 * an output file that travels with it.
 *
 * The interesting cases are the damaged ones. A chain whose middle is gone, one
 * that points at itself, and one longer than anything a session could produce
 * all have to answer rather than hang or throw.
 */

import { describe, expect, it } from "vitest";
import {
	createJobsNamespace,
	JOB_OUTPUT_DIR_NAME,
	JOBS_NAMESPACE,
	JobHistoryStorage,
	jobOutputFileName,
	MAX_JOB_CHAIN_LENGTH,
} from "../../src/core/background/job-persistence.ts";
import type {
	JobHistory,
	JobRecord,
	JobStartedRecord,
} from "../../src/core/background/types.ts";
import {
	contentHash,
	PersistenceDiagnostics,
	PersistenceRegistry,
} from "../../src/core/persistence/index.ts";
import { MemoryFileSystem } from "../helpers/memory-fs.ts";

const DIR = "/runs/--w--/root/persistence/core__jobs";
const LOG = `${DIR}/objects.jsonl`;

async function openStorage(
	fs: MemoryFileSystem,
	dirPath = DIR,
): Promise<JobHistoryStorage> {
	return await JobHistoryStorage.open({
		fs,
		dirPath,
		sessionKey: ["root"],
		diagnostics: new PersistenceDiagnostics(),
	});
}

function started(toolCallId: string): JobStartedRecord {
	return {
		kind: "started",
		toolCallId,
		jobId: `job-${toolCallId}`,
		ownerAgentId: "coder",
		sessionId: "coder",
		toolName: "bash",
		origin: { kind: "local" },
		startedAt: 1,
		backgroundedAt: 2,
		outputFile: jobOutputFileName(toolCallId),
	};
}

async function appendAll(
	storage: JobHistoryStorage,
	records: readonly JobRecord[],
): Promise<string> {
	let root: string | null = null;
	for (const record of records) root = await storage.appendRecord(record, root);
	if (root === null) throw new Error("nothing appended");
	return root;
}

/** Plant a log no writer would produce, so the reader can be tested against it. */
function plantLog(
	fs: MemoryFileSystem,
	objects: readonly { id: string; deps: string[]; data: unknown }[],
	dirPath = DIR,
): void {
	const header = {
		type: "persistence-objects",
		version: 1,
		namespace: JOBS_NAMESPACE,
		formatVersion: 1,
	};
	const lines = [header, ...objects].map((line) => JSON.stringify(line));
	fs.files.set(`${dirPath}/objects.jsonl`, `${lines.join("\n")}\n`);
}

describe("JobHistoryStorage", () => {
	it("creates nothing until a record is appended", async () => {
		const fs = new MemoryFileSystem();
		await openStorage(fs);
		expect(fs.files.has(LOG)).toBe(false);
	});

	it("resolves a chain into the job table it reduces to", async () => {
		const fs = new MemoryFileSystem();
		const storage = await openStorage(fs);
		const root = await appendAll(storage, [
			started("a"),
			started("b"),
			{
				kind: "settled",
				toolCallId: "a",
				status: "completed",
				endedAt: 9,
				messageText: "ok",
			},
		]);
		const history = (await storage.resolveState(root)) as JobHistory;
		expect(history.truncated).toBe(false);
		expect(history.jobs.map((job) => [job.toolCallId, job.state])).toEqual([
			["a", "settled"],
			["b", "open"],
		]);
	});

	it("resolves an older root to what that root saw", async () => {
		const fs = new MemoryFileSystem();
		const storage = await openStorage(fs);
		const first = await storage.appendRecord(started("a"), null);
		await storage.appendRecord(started("b"), first);
		const history = (await storage.resolveState(first)) as JobHistory;
		expect(history.jobs.map((job) => job.toolCallId)).toEqual(["a"]);
	});

	it("survives a reopen and keeps resolving the same root", async () => {
		const fs = new MemoryFileSystem();
		const root = await appendAll(await openStorage(fs), [started("a")]);
		const reopened = await openStorage(fs);
		const history = (await reopened.resolveState(root)) as JobHistory;
		expect(history.jobs).toHaveLength(1);
	});

	it("answers undefined for a root nothing wrote", async () => {
		const fs = new MemoryFileSystem();
		const storage = await openStorage(fs);
		expect(await storage.resolveState(contentHash("absent"))).toBeUndefined();
	});

	it("reports the chain as truncated when its middle is gone", async () => {
		const fs = new MemoryFileSystem();
		const missing = contentHash("gone");
		const tip = { deps: [missing], data: started("b") };
		plantLog(fs, [{ id: contentHash(tip), ...tip }]);
		const storage = await openStorage(fs);
		const history = (await storage.resolveState(
			contentHash(tip),
		)) as JobHistory;
		expect(history.truncated).toBe(true);
		expect(history.jobs.map((job) => job.toolCallId)).toEqual(["b"]);
	});

	it("terminates on a chain that points at itself", async () => {
		const fs = new MemoryFileSystem();
		const id = contentHash("loop");
		plantLog(fs, [{ id, deps: [id], data: started("a") }]);
		const storage = await openStorage(fs);
		const history = (await storage.resolveState(id)) as JobHistory;
		expect(history.jobs).toHaveLength(1);
		expect(history.truncated).toBe(true);
	});

	it("stops walking a chain longer than a session could produce", async () => {
		const fs = new MemoryFileSystem();
		const objects: { id: string; deps: string[]; data: unknown }[] = [];
		let previous: string | undefined;
		for (let index = 0; index <= MAX_JOB_CHAIN_LENGTH; index += 1) {
			const id = contentHash(`link-${index}`);
			objects.push({
				id,
				deps: previous === undefined ? [] : [previous],
				data: started(`call-${index}`),
			});
			previous = id;
		}
		plantLog(fs, objects);
		const storage = await openStorage(fs);
		const history = (await storage.resolveState(
			contentHash(`link-${MAX_JOB_CHAIN_LENGTH}`),
		)) as JobHistory;
		expect(history.truncated).toBe(true);
		expect(history.jobs.length).toBeLessThanOrEqual(MAX_JOB_CHAIN_LENGTH);
	});

	it("walks past a link this build cannot read instead of stopping", async () => {
		const fs = new MemoryFileSystem();
		const head = { deps: [] as string[], data: started("a") };
		const headId = contentHash(head);
		const alien = { deps: [headId], data: { kind: "hibernated" } };
		const alienId = contentHash(alien);
		const tip = {
			deps: [alienId],
			data: {
				kind: "settled",
				toolCallId: "a",
				status: "completed",
				endedAt: 9,
				messageText: "ok",
			},
		};
		plantLog(fs, [
			{ id: headId, ...head },
			{ id: alienId, ...alien },
			{ id: contentHash(tip), ...tip },
		]);
		const storage = await openStorage(fs);
		const history = (await storage.resolveState(
			contentHash(tip),
		)) as JobHistory;
		expect(history.truncated).toBe(false);
		expect(history.jobs[0]).toMatchObject({ state: "settled" });
	});

	it("bounds the texts a settled record carries before storing them", async () => {
		const fs = new MemoryFileSystem();
		const storage = await openStorage(fs);
		await appendAll(storage, [
			started("a"),
			{
				kind: "settled",
				toolCallId: "a",
				status: "completed",
				endedAt: 9,
				messageText: "m".repeat(200_000),
			},
		]);
		expect((fs.files.get(LOG) ?? "").length).toBeLessThan(150_000);
	});
});

describe("JobHistoryStorage output files", () => {
	it("places output under the namespace directory, never beside the session", async () => {
		const fs = new MemoryFileSystem();
		const storage = await openStorage(fs);
		const path = await storage.outputFilePath(jobOutputFileName("a"));
		expect(path.startsWith(`${DIR}/${JOB_OUTPUT_DIR_NAME}/`)).toBe(true);
	});

	it("copies the objects and the output files a fork can see", async () => {
		const fs = new MemoryFileSystem();
		const source = await openStorage(fs);
		const root = await appendAll(source, [started("a"), started("b")]);
		await fs.writeFile(
			await source.outputFilePath(jobOutputFileName("a")),
			"hello",
		);
		const targetDir = "/runs/--w--/forked/persistence/core__jobs";
		const target = await openStorage(fs, targetDir);
		await source.copyReachable(target, await source.reachableFrom(root));

		const copied = (await target.resolveState(root)) as JobHistory;
		expect(copied.jobs.map((job) => job.toolCallId)).toEqual(["a", "b"]);
		expect(
			fs.files.get(
				`${targetDir}/${JOB_OUTPUT_DIR_NAME}/${jobOutputFileName("a")}`,
			),
		).toBe("hello");
	});

	it("copies a job whose output file was never written", async () => {
		const fs = new MemoryFileSystem();
		const source = await openStorage(fs);
		const root = await appendAll(source, [started("a")]);
		const targetDir = "/runs/--w--/forked/persistence/core__jobs";
		const target = await openStorage(fs, targetDir);
		await source.copyReachable(target, await source.reachableFrom(root));
		expect(await target.resolveState(root)).toBeDefined();
	});
});

describe("createJobsNamespace", () => {
	it("registers under a name the framework accepts", () => {
		const registry = new PersistenceRegistry();
		registry.register(createJobsNamespace());
		expect(registry.get(JOBS_NAMESPACE)?.forkPolicy).toBe("degrade");
	});

	it("closes every inherited job in the fork, and only in the fork", async () => {
		const fs = new MemoryFileSystem();
		const definition = createJobsNamespace();
		const source = await openStorage(fs);
		const root = await appendAll(source, [started("a"), started("b")]);
		const targetDir = "/runs/--w--/forked/persistence/core__jobs";
		const target = await openStorage(fs, targetDir);

		const result = await definition.fork?.({
			source,
			target,
			roots: await source.reachableFrom(root),
			diagnostics: new PersistenceDiagnostics(),
		});

		expect(result?.stateRoot).toBeDefined();
		expect(result?.stateRoot).not.toBe(root);
		const forked = (await target.resolveState(
			result?.stateRoot ?? "",
		)) as JobHistory;
		expect(forked.jobs.map((job) => [job.state, job.cause])).toEqual([
			["closed", "fork"],
			["closed", "fork"],
		]);
		const origin = (await source.resolveState(root)) as JobHistory;
		expect(origin.jobs.every((job) => job.state === "open")).toBe(true);
	});

	it("keeps the root unchanged when the fork inherits nothing open", async () => {
		const fs = new MemoryFileSystem();
		const definition = createJobsNamespace();
		const source = await openStorage(fs);
		const root = await appendAll(source, [
			started("a"),
			{
				kind: "settled",
				toolCallId: "a",
				status: "completed",
				endedAt: 9,
				messageText: "ok",
			},
		]);
		const target = await openStorage(fs, "/runs/--w--/forked/p/core__jobs");
		const result = await definition.fork?.({
			source,
			target,
			roots: await source.reachableFrom(root),
			diagnostics: new PersistenceDiagnostics(),
		});
		expect(result?.stateRoot).toBe(root);
	});
});
