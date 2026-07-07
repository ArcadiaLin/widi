import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileMutationQueue } from "../../src/core/tools/coding/file-mutation-queue.ts";
import {
	createLocalCodingToolFileOperations,
	isMissingPathError,
} from "../../src/core/tools/coding/operations.ts";
import { resolveToCwd } from "../../src/core/tools/coding/path-utils.ts";
import {
	formatSize,
	truncateHead,
} from "../../src/core/tools/coding/truncate.ts";

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

describe("coding tool shared primitives", () => {
	const tempRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(
			tempRoots.map((root) => rm(root, { force: true, recursive: true })),
		);
		tempRoots.length = 0;
	});

	it("resolves relative paths against cwd and normalizes absolute paths", () => {
		expect(resolveToCwd("src/../README.md", "/workspace/project")).toBe(
			"/workspace/project/README.md",
		);
		expect(resolveToCwd("/tmp/../var/file.txt", "/workspace/project")).toBe(
			"/var/file.txt",
		);
	});

	it("provides local file operations without exposing ExecutionEnv", async () => {
		const root = await mkdtemp(join(tmpdir(), "widi-coding-"));
		tempRoots.push(root);
		const operations = createLocalCodingToolFileOperations();
		const filePath = join(root, "nested", "file.txt");

		await operations.mkdir(dirname(filePath));
		await operations.writeFile(filePath, "hello");

		await expect(operations.access(filePath, "read")).resolves.toBeUndefined();
		await expect(operations.readFile(filePath)).resolves.toEqual(
			Buffer.from("hello"),
		);
		await expect(operations.realpath(filePath)).resolves.toBe(filePath);
	});

	it("detects missing path errors by node-style error code", () => {
		expect(isMissingPathError({ code: "ENOENT" })).toBe(true);
		expect(isMissingPathError({ code: "ENOTDIR" })).toBe(true);
		expect(isMissingPathError({ code: "EACCES" })).toBe(false);
		expect(isMissingPathError(new Error("missing"))).toBe(false);
	});

	it("serializes mutations that resolve to the same file key", async () => {
		const firstStarted = deferred<void>();
		const releaseFirst = deferred<void>();
		const events: string[] = [];
		const operations = {
			realpath: async (path: string) => path.replace("/link", "/target"),
		};

		const first = withFileMutationQueue(
			"/workspace/link",
			async () => {
				events.push("first:start");
				firstStarted.resolve();
				await releaseFirst.promise;
				events.push("first:end");
				return "first";
			},
			{ operations },
		);
		const second = withFileMutationQueue(
			"/workspace/target",
			async () => {
				events.push("second:start");
				return "second";
			},
			{ operations },
		);

		await firstStarted.promise;
		await Promise.resolve();
		expect(events).toEqual(["first:start"]);

		releaseFirst.resolve();
		await expect(Promise.all([first, second])).resolves.toEqual([
			"first",
			"second",
		]);
		expect(events).toEqual(["first:start", "first:end", "second:start"]);
	});

	it("releases the mutation queue when a mutation fails", async () => {
		const operations = { realpath: async (path: string) => path };
		const events: string[] = [];

		const first = withFileMutationQueue(
			"/workspace/file.txt",
			async () => {
				events.push("first");
				throw new Error("boom");
			},
			{ operations },
		);
		const second = withFileMutationQueue(
			"/workspace/file.txt",
			async () => {
				events.push("second");
				return "ok";
			},
			{ operations },
		);

		await expect(first).rejects.toThrow("boom");
		await expect(second).resolves.toBe("ok");
		expect(events).toEqual(["first", "second"]);
	});

	it("truncates file reads by line and byte limits without partial lines", () => {
		const byLines = truncateHead("one\ntwo\nthree", {
			maxLines: 2,
			maxBytes: 100,
		});
		expect(byLines).toMatchObject({
			content: "one\ntwo",
			truncated: true,
			truncatedBy: "lines",
			totalLines: 3,
			outputLines: 2,
		});

		const byBytes = truncateHead("alpha\nbeta\ngamma", {
			maxLines: 10,
			maxBytes: 9,
		});
		expect(byBytes).toMatchObject({
			content: "alpha",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 1,
			firstLineExceedsLimit: false,
		});

		const firstLineTooLarge = truncateHead("123456\nok", {
			maxLines: 10,
			maxBytes: 4,
		});
		expect(firstLineTooLarge).toMatchObject({
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 0,
			firstLineExceedsLimit: true,
		});
	});

	it("formats byte sizes for tool notices", () => {
		expect(formatSize(512)).toBe("512B");
		expect(formatSize(1536)).toBe("1.5KB");
		expect(formatSize(2 * 1024 * 1024)).toBe("2.0MB");
	});
});
