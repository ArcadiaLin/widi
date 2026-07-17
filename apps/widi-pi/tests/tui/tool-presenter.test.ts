import { describe, expect, it } from "vitest";
import type { ToolExecutionItem } from "../../src/tui/state.ts";
import { presentToolExecution } from "../../src/tui/tool-presenter.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function toolItem(overrides: Partial<ToolExecutionItem>): ToolExecutionItem {
	return {
		type: "tool-execution",
		id: "tool-1",
		toolCallId: "tool-1",
		durability: "durable",
		createdAt: "2026-01-01T00:00:00.000Z",
		toolName: "ls",
		status: "completed",
		isError: false,
		...overrides,
	};
}

function textResult(text: string): unknown {
	return { content: [{ type: "text", text }] };
}

function plain(lines: string[]): string[] {
	return lines.map((line) => line.replace(ANSI_SEQUENCE, "").trimEnd());
}

describe("presentToolExecution", () => {
	it("summarizes ls calls without dumping raw JSON or entries", () => {
		const item = toolItem({
			toolName: "ls",
			args: { path: "src" },
			result: textResult("a.ts\nb.ts\ncore/\n"),
		});

		const lines = plain(presentToolExecution(item, 80));

		expect(lines).toEqual(["✓ List src · 3 entries"]);
	});

	it("shows read ranges and line counts without file content", () => {
		const item = toolItem({
			toolName: "read",
			args: { path: "notes.txt", offset: 1, limit: 2000 },
			result: textResult("line\n".repeat(100).trimEnd()),
		});

		const lines = plain(presentToolExecution(item, 80));

		expect(lines).toEqual(["✓ Read notes.txt 1–2000 · 100 lines"]);
	});

	it("previews a few bash output lines and reports the rest", () => {
		const item = toolItem({
			toolName: "bash",
			args: { command: "ls -la" },
			result: textResult("one\ntwo\nthree\nfour\nfive\nsix"),
		});

		const lines = plain(presentToolExecution(item, 80));

		expect(lines[0]).toBe("✓ Bash ls -la");
		expect(lines.slice(1)).toEqual([
			"one",
			"two",
			"three",
			"four",
			"… +2 lines",
		]);
	});

	it("marks running calls distinctly", () => {
		const item = toolItem({
			toolName: "bash",
			status: "running",
			args: { command: "sleep 5" },
		});

		const lines = plain(presentToolExecution(item, 80));

		expect(lines).toEqual(["● Bash sleep 5"]);
	});

	it("keeps more detail for errors", () => {
		const item = toolItem({
			toolName: "ls",
			args: { path: "missing" },
			isError: true,
			result: textResult("Path not found: /repo/missing"),
		});

		const lines = plain(presentToolExecution(item, 80));

		expect(lines).toEqual(["✕ List missing", "Path not found: /repo/missing"]);
	});

	it("renders unknown tools with compact key-value arguments", () => {
		const item = toolItem({
			toolName: "deploy",
			args: { target: "staging", dryRun: true },
			result: textResult("ok"),
		});

		const lines = plain(presentToolExecution(item, 80));

		expect(lines[0]).toBe("✓ deploy target: staging, dryRun: true");
	});

	it("truncates every line to the available width", () => {
		const item = toolItem({
			toolName: "bash",
			args: { command: "x".repeat(300) },
			result: textResult(`${"y".repeat(300)}\nsecond`),
		});

		for (const line of presentToolExecution(item, 40)) {
			expect(line.replace(ANSI_SEQUENCE, "").length).toBeLessThanOrEqual(40);
		}
	});
});
