import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSessionFile, SessionFileError } from "../src/load/session-file.ts";
import { assistantEntry, leafEntry, makeTempDir, userEntry, writeSessionTree } from "./helpers/session-fixture.ts";

describe("readSessionFile", () => {
	it("reads the header and the entries", async () => {
		const root = await makeTempDir();
		const dir = await writeSessionTree(root, {
			dirName: "s",
			id: "agent-1",
			timestamp: "2026-08-01T12:00:00.000Z",
			metadata: { profile: { id: "plan" } },
			entries: [userEntry("e1", null, "2026-08-01T12:00:01.000Z", "hi")],
		});
		const file = await readSessionFile(join(dir, "session.jsonl"));
		expect(file.header.id).toBe("agent-1");
		expect(file.header.metadata).toEqual({ profile: { id: "plan" } });
		expect(file.entries).toHaveLength(1);
		expect(file.leafId).toBe("e1");
		expect(file.warnings).toEqual([]);
	});

	it("follows leaf entries to the entry the session was left on", async () => {
		const root = await makeTempDir();
		const dir = await writeSessionTree(root, {
			dirName: "s",
			id: "agent-1",
			timestamp: "2026-08-01T12:00:00.000Z",
			entries: [
				userEntry("e1", null, "2026-08-01T12:00:01.000Z", "one"),
				assistantEntry("e2", "e1", "2026-08-01T12:00:02.000Z", { text: "two" }),
				leafEntry("l1", "e2", "2026-08-01T12:00:03.000Z", "e1"),
			],
		});
		const file = await readSessionFile(join(dir, "session.jsonl"));
		expect(file.leafId).toBe("e1");
	});

	it("drops a torn last line instead of refusing the file", async () => {
		const root = await makeTempDir();
		const dir = await writeSessionTree(root, {
			dirName: "s",
			id: "agent-1",
			timestamp: "2026-08-01T12:00:00.000Z",
			entries: [userEntry("e1", null, "2026-08-01T12:00:01.000Z", "hi")],
			trailer: '{"type":"message","id":"e2","parentI',
		});
		const file = await readSessionFile(join(dir, "session.jsonl"));
		expect(file.entries).toHaveLength(1);
		expect(file.warnings.join(" ")).toContain("torn last line");
	});

	it("refuses a file whose header is not a session header", async () => {
		const root = await makeTempDir();
		const dir = await writeSessionTree(root, {
			dirName: "s",
			id: "agent-1",
			timestamp: "2026-08-01T12:00:00.000Z",
			entries: [],
		});
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(dir, "session.jsonl"), '{"type":"message"}\n', "utf8");
		await expect(readSessionFile(join(dir, "session.jsonl"))).rejects.toBeInstanceOf(SessionFileError);
	});

	it("skips a duplicate entry id and keeps reading", async () => {
		const root = await makeTempDir();
		const dir = await writeSessionTree(root, {
			dirName: "s",
			id: "agent-1",
			timestamp: "2026-08-01T12:00:00.000Z",
			entries: [
				userEntry("e1", null, "2026-08-01T12:00:01.000Z", "one"),
				userEntry("e1", null, "2026-08-01T12:00:02.000Z", "again"),
				assistantEntry("e2", "e1", "2026-08-01T12:00:03.000Z", { text: "two" }),
			],
		});
		const file = await readSessionFile(join(dir, "session.jsonl"));
		expect(file.entries.map((entry) => entry.id)).toEqual(["e1", "e2"]);
		expect(file.warnings.join(" ")).toContain("duplicate entry id");
	});
});
