import type { MessageEntry, SessionTreeEntry } from "@widi/agent-core";
import { describe, expect, it } from "vitest";
import type { AgentSessionTreeSnapshot } from "../../src/core/session-manager.ts";
import { buildSessionEntryRows, findSessionEntryRow, userMessageHeadline } from "../../src/tui/session-tree.ts";

const TIMESTAMP = "2026-08-01T00:00:00.000Z";

function userEntry(id: string, parentId: string | null, text: string): MessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: { role: "user", content: text, timestamp: 0 },
	};
}

function assistantEntry(id: string, parentId: string): MessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: { role: "assistant", content: [] } as unknown as MessageEntry["message"],
	};
}

function snapshot(entries: readonly SessionTreeEntry[], leafId: string | null): AgentSessionTreeSnapshot {
	return { entries, leafId } as unknown as AgentSessionTreeSnapshot;
}

describe("buildSessionEntryRows", () => {
	it("flattens a single chain, skipping the assistant entries in between", () => {
		const rows = buildSessionEntryRows(
			snapshot(
				[userEntry("u1", null, "first question"), assistantEntry("a1", "u1"), userEntry("u2", "a1", "follow up")],
				"u2",
			),
		);

		expect(rows).toEqual([
			{ entryId: "u1", headline: "first question", timestamp: TIMESTAMP, depth: 0, last: true, current: false },
			{ entryId: "u2", headline: "follow up", timestamp: TIMESTAMP, depth: 1, last: true, current: true },
		]);
	});

	it("lays out branches in preorder with sibling last flags", () => {
		const rows = buildSessionEntryRows(
			snapshot(
				[
					userEntry("u1", null, "first question"),
					assistantEntry("a1", "u1"),
					userEntry("u2", "a1", "follow up"),
					assistantEntry("a2", "u2"),
					userEntry("u3", "a1", "new branch"),
					assistantEntry("a3", "u3"),
				],
				"a3",
			),
		);

		expect(rows.map((row) => [row.entryId, row.depth, row.last, row.current])).toEqual([
			["u1", 0, true, false],
			["u2", 1, false, false],
			["u3", 1, true, true],
		]);
	});

	it("marks the current row by the nearest user message at or above the leaf", () => {
		const rows = buildSessionEntryRows(
			snapshot([userEntry("u1", null, "first question"), assistantEntry("a1", "u1")], "a1"),
		);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.current).toBe(true);
	});

	it("returns no rows for an empty tree", () => {
		expect(buildSessionEntryRows(snapshot([], null))).toEqual([]);
	});

	it("returns no rows when the tree has no user messages", () => {
		expect(buildSessionEntryRows(snapshot([assistantEntry("a1", "gone")], "a1"))).toEqual([]);
	});

	it("marks nothing current when the leaf is unset", () => {
		const rows = buildSessionEntryRows(snapshot([userEntry("u1", null, "first question")], null));

		expect(rows[0]?.current).toBe(false);
	});
});

describe("findSessionEntryRow", () => {
	const rows = buildSessionEntryRows(
		snapshot(
			[userEntry("entry-aaa", null, "first question"), userEntry("entry-bbb", "entry-aaa", "follow up")],
			"entry-bbb",
		),
	);

	it("prefers an exact entry id", () => {
		expect(findSessionEntryRow(rows, "entry-aaa")).toBe("entry-aaa");
	});

	it("accepts a unique id prefix", () => {
		expect(findSessionEntryRow(rows, "entry-b")).toBe("entry-bbb");
	});

	it("falls back to the first headline containing the query", () => {
		expect(findSessionEntryRow(rows, "FOLLOW")).toBe("entry-bbb");
	});

	it("ignores blank and unmatched queries", () => {
		expect(findSessionEntryRow(rows, "  ")).toBeUndefined();
		expect(findSessionEntryRow(rows, "no such text")).toBeUndefined();
	});
});

describe("userMessageHeadline", () => {
	it("takes the first non-empty line of string content", () => {
		expect(userMessageHeadline({ role: "user", content: "\n\n  hello world\nsecond line", timestamp: 0 })).toBe(
			"hello world",
		);
	});

	it("joins text parts of structured content", () => {
		expect(
			userMessageHeadline({
				role: "user",
				content: [
					{ type: "text", text: "part one" },
					{ type: "text", text: "part two" },
				],
				timestamp: 0,
			}),
		).toBe("part one part two");
	});

	it("caps the headline at one display line", () => {
		expect(userMessageHeadline({ role: "user", content: "x".repeat(120), timestamp: 0 })).toHaveLength(80);
	});
});
