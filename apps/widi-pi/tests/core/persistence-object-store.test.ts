/**
 * The default custom storage: immutable objects, addressed by content.
 *
 * Two properties matter more than the rest. Writing the same object twice costs
 * one line, which is what lets several refs share a root and a fork be safe to
 * retry. And a log damaged by a killed process still yields everything before
 * the damage, because losing a conversation to a half-written state object is
 * exactly the failure this layer exists to prevent.
 */

import { describe, expect, it } from "vitest";
import {
	contentHash,
	JsonlObjectStore,
	PersistenceDiagnostics,
} from "../../src/core/persistence/index.ts";
import { MemoryFileSystem } from "../helpers/memory-fs.ts";

const DIR = "/runs/--w--/root/persistence/test__counter";
const LOG = `${DIR}/objects.jsonl`;

async function openStore(
	fs: MemoryFileSystem,
	options: {
		formatVersion?: number;
		diagnostics?: PersistenceDiagnostics;
		dir?: string;
	} = {},
): Promise<JsonlObjectStore> {
	const dirPath = options.dir ?? DIR;
	return await JsonlObjectStore.open({
		fs,
		dirPath,
		filePath: `${dirPath}/objects.jsonl`,
		namespace: "test:counter",
		formatVersion: options.formatVersion ?? 1,
		sessionKey: ["root"],
		diagnostics: options.diagnostics,
	});
}

function logLines(fs: MemoryFileSystem, path = LOG): string[] {
	return (fs.files.get(path) ?? "").split("\n").filter((line) => line.trim());
}

describe("JsonlObjectStore", () => {
	it("creates nothing until something is stored", async () => {
		const fs = new MemoryFileSystem();
		await openStore(fs);
		expect(fs.files.has(LOG)).toBe(false);
	});

	it("writes a header once, then one line per object", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		await store.putObject({ data: { count: 1 } });
		await store.putObject({ data: { count: 2 } });
		const lines = logLines(fs);
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
			type: "persistence-objects",
			namespace: "test:counter",
			formatVersion: 1,
		});
	});

	it("gives the same content the same root and stores it once", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		const first = await store.putObject({ data: { count: 1 } });
		const second = await store.putObject({ data: { count: 1 } });
		expect(second).toBe(first);
		expect(logLines(fs)).toHaveLength(2);
	});

	it("ignores dependency order when addressing an object", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		const a = await store.putObject({ data: { n: 1 } });
		const b = await store.putObject({ data: { n: 2 } });
		const left = await store.putObject({ data: {}, dependencies: [a, b] });
		const right = await store.putObject({ data: {}, dependencies: [b, a, a] });
		expect(right).toBe(left);
	});

	it("resolves state and dependencies after reopening", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		const base = await store.putObject({ data: { count: 1 } });
		const derived = await store.putObject({
			data: { count: 2 },
			dependencies: [base],
		});

		const reopened = await openStore(fs);
		expect(await reopened.resolveState(derived)).toEqual({ count: 2 });
		expect(await reopened.listDependencies(derived)).toEqual([base]);
		expect(reopened.has(base)).toBe(true);
	});

	it("reports a missing object as undefined rather than throwing", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		expect(
			await store.resolveState(contentHash({ nope: true })),
		).toBeUndefined();
		expect(await store.listDependencies("sha256:missing")).toEqual([]);
	});

	// A killed runtime tears the line it was writing. Everything before it is
	// still true, and refusing to read the file would lose all of it.
	it("tolerates a torn last line", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		const root = await store.putObject({ data: { count: 1 } });
		await fs.appendFile(LOG, '{"id":"sha256:hal');

		const diagnostics = new PersistenceDiagnostics();
		const reopened = await openStore(fs, { diagnostics });
		expect(await reopened.resolveState(root)).toEqual({ count: 1 });
		expect(diagnostics.entries).toHaveLength(0);
	});

	it("reports damage that is not at the end", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs);
		await store.putObject({ data: { count: 1 } });
		const lines = logLines(fs);
		await fs.writeFile(LOG, `${lines[0]}\nbroken\n${lines[1]}\n`);

		const diagnostics = new PersistenceDiagnostics();
		await openStore(fs, { diagnostics });
		expect(diagnostics.entries.map((entry) => entry.code)).toEqual([
			"persistence.corrupt_log",
		]);
		expect(diagnostics.hasErrors).toBe(true);
	});

	it("stops at a log written by a newer build instead of guessing", async () => {
		const fs = new MemoryFileSystem();
		await fs.writeFile(
			LOG,
			`${JSON.stringify({
				type: "persistence-objects",
				version: 99,
				namespace: "test:counter",
				formatVersion: 1,
			})}\n${JSON.stringify({ id: "sha256:x", deps: [], data: {} })}\n`,
		);
		const diagnostics = new PersistenceDiagnostics();
		const store = await openStore(fs, { diagnostics });
		expect(store.has("sha256:x")).toBe(false);
		expect(diagnostics.entries.map((entry) => entry.code)).toEqual([
			"persistence.unsupported_version",
		]);
	});

	it("reports the format version the objects were written with", async () => {
		const fs = new MemoryFileSystem();
		const store = await openStore(fs, { formatVersion: 1 });
		await store.putObject({ data: { count: 1 } });
		const reopened = await openStore(fs, { formatVersion: 2 });
		expect(reopened.storedFormatVersion).toBe(1);
	});

	it("copies objects into another store without duplicating them", async () => {
		const fs = new MemoryFileSystem();
		const source = await openStore(fs);
		const base = await source.putObject({ data: { count: 1 } });
		const derived = await source.putObject({
			data: { count: 2 },
			dependencies: [base],
		});

		const targetDir = "/runs/--w--/fork/persistence/test__counter";
		const target = await openStore(fs, { dir: targetDir });
		await source.copyReachable(target, [base, derived]);
		await source.copyReachable(target, [base, derived]);

		expect(logLines(fs, `${targetDir}/objects.jsonl`)).toHaveLength(3);
		expect(await target.resolveState(derived)).toEqual({ count: 2 });
		expect(await target.listDependencies(derived)).toEqual([base]);
	});
});
