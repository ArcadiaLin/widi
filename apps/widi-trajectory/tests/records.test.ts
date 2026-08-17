import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSessionFile } from "../src/load/session-file.ts";
import { buildBranches } from "../src/model/branch.ts";
import { ImageAllowance } from "../src/model/content.ts";
import { buildRecords } from "../src/model/records.ts";
import {
	assistantEntry,
	leafEntry,
	makeTempDir,
	noticeEntry,
	toolResultEntry,
	userEntry,
	writeSessionTree,
} from "./helpers/session-fixture.ts";

async function load(entries: Parameters<typeof writeSessionTree>[1]["entries"]) {
	const root = await makeTempDir();
	const dir = await writeSessionTree(root, {
		dirName: "s",
		id: "agent-1",
		timestamp: "2026-08-01T12:00:00.000Z",
		entries,
	});
	const file = await readSessionFile(join(dir, "session.jsonl"));
	const records = buildRecords({ entries: file.entries, images: new ImageAllowance(), keyOfAgent: () => undefined });
	return { file, ...records };
}

describe("buildRecords", () => {
	it("folds a tool result into the call that asked for it", async () => {
		const { records } = await load([
			userEntry("e1", null, "2026-08-01T12:00:00.000Z", "go"),
			assistantEntry("e2", "e1", "2026-08-01T12:00:04.000Z", {
				startedAt: "2026-08-01T12:00:01.000Z",
				text: "running it",
				toolCalls: [{ id: "call-1", name: "bash", arguments: { command: "ls" } }],
			}),
			toolResultEntry("e3", "e2", "2026-08-01T12:00:06.000Z", {
				toolCallId: "call-1",
				toolName: "bash",
				text: "file.txt",
			}),
		]);
		expect(records.map((record) => record.kind)).toEqual(["user", "assistant", "tool"]);
		const tool = records[2];
		expect(tool.id).toBe("e2#call-1");
		expect(tool.title).toBe("bash");
		expect(tool.toolCall?.settled).toBe(true);
		expect(tool.output?.[0]).toEqual({ type: "text", text: "file.txt" });
		// The call starts when the entry its result hangs from was written.
		expect(tool.endedAt - tool.startedAt).toBe(2000);
	});

	it("takes an assistant span from the request start to the recorded reply", async () => {
		const { records } = await load([
			userEntry("e1", null, "2026-08-01T12:00:00.000Z", "go"),
			assistantEntry("e2", "e1", "2026-08-01T12:00:04.000Z", { startedAt: "2026-08-01T12:00:01.000Z", text: "done" }),
		]);
		const assistant = records[1];
		expect(assistant.endedAt - assistant.startedAt).toBe(3000);
		expect(assistant.usage?.total).toBe(120);
		expect(assistant.model).toEqual({ provider: "test", model: "test-model", api: "openai-completions" });
	});

	it("keeps an unsettled call as a record and says the result is missing", async () => {
		const { records } = await load([
			userEntry("e1", null, "2026-08-01T12:00:00.000Z", "go"),
			assistantEntry("e2", "e1", "2026-08-01T12:00:01.000Z", { toolCalls: [{ id: "call-1", name: "bash" }] }),
		]);
		const tool = records.find((record) => record.kind === "tool");
		expect(tool?.toolCall?.settled).toBe(false);
		expect(tool?.startedAt).toBe(tool?.endedAt);
	});

	it("reads a delivered notice as its body, keeping the wrapped text beside it", async () => {
		const { records } = await load([
			noticeEntry("e1", null, "2026-08-01T12:00:00.000Z", {
				senderAgentId: "plan-1",
				body: "the plan",
				notice: { status: "idle", reason: "settled" },
			}),
		]);
		expect(records[0].kind).toBe("notice");
		expect(records[0].blocks?.[0]).toEqual({ type: "text", text: "the plan" });
		expect(records[0].output?.[0]?.type).toBe("text");
		expect(records[0].link?.status).toBe("idle");
		expect(records[0].link?.direction).toBe("in");
	});
});

describe("buildBranches", () => {
	it("numbers turns and steps within one branch", async () => {
		const { file, records, byEntryId } = await load([
			userEntry("e1", null, "2026-08-01T12:00:00.000Z", "first"),
			assistantEntry("e2", "e1", "2026-08-01T12:00:01.000Z", { toolCalls: [{ id: "call-1", name: "bash" }] }),
			toolResultEntry("e3", "e2", "2026-08-01T12:00:02.000Z", { toolCallId: "call-1", toolName: "bash" }),
			assistantEntry("e4", "e3", "2026-08-01T12:00:03.000Z", { text: "ok" }),
			userEntry("e5", "e4", "2026-08-01T12:00:04.000Z", "second"),
			assistantEntry("e6", "e5", "2026-08-01T12:00:05.000Z", { text: "ok again" }),
		]);
		const { branches, currentBranchId } = buildBranches({
			entries: file.entries,
			leafId: file.leafId,
			records,
			byEntryId,
		});
		expect(branches).toHaveLength(1);
		expect(currentBranchId).toBe("e6");
		expect(branches[0].turns.map((turn) => [turn.turn, turn.stepCount])).toEqual([
			[1, 2],
			[2, 1],
		]);
		const rows = branches[0].rows;
		expect(rows.map((row) => `${row.turn}.${row.step}`)).toEqual(["1.0", "1.1", "1.1", "1.2", "2.0", "2.1"]);
	});

	it("keeps an abandoned branch and marks the one the session was left on", async () => {
		const { file, records, byEntryId } = await load([
			userEntry("e1", null, "2026-08-01T12:00:00.000Z", "first"),
			assistantEntry("e2", "e1", "2026-08-01T12:00:01.000Z", { text: "attempt" }),
			leafEntry("l1", "e2", "2026-08-01T12:00:02.000Z", "e1"),
			assistantEntry("e3", "e1", "2026-08-01T12:00:03.000Z", { text: "retry" }),
		]);
		const { branches, currentBranchId } = buildBranches({
			entries: file.entries,
			leafId: file.leafId,
			records,
			byEntryId,
		});
		expect(branches).toHaveLength(2);
		expect(currentBranchId).toBe("e3");
		expect(branches[0].current).toBe(true);
		expect(branches.find((branch) => branch.id === "e2")?.current).toBe(false);
	});
});
