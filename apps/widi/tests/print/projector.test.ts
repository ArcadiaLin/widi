/**
 * The text rendering, which is the one part of print that has no second source
 * of truth: json frames can be re-read, a terminal's output cannot.
 *
 * The two properties worth holding still are that assistant text goes out
 * verbatim - so redirecting stdout gives the answer and not a transcript of one
 * - and that everything else is prefixed, so a reader tells them apart without
 * a parser.
 */

import { describe, expect, it } from "vitest";
import type { PrintFrame } from "../../src/print/frames.ts";
import type { PrintWriter } from "../../src/print/output.ts";
import { PrintTextOutput } from "../../src/print/projector.ts";
import type { RpcRunSummary } from "../../src/rpc/run-summary.ts";

class MemoryWriter implements PrintWriter {
	text = "";

	write(chunk: string): void {
		this.text += chunk;
	}

	async drain(): Promise<void> {}
}

function textDelta(agentId: string, delta: string): PrintFrame {
	return {
		type: "event",
		event: {
			type: "agent_harness_event",
			agentId,
			event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } },
		},
	} as PrintFrame;
}

const EMPTY_SUMMARY: RpcRunSummary = {
	startedAt: "1970-01-01T00:00:00.000Z",
	durationMs: 12,
	total: {
		turns: 1,
		turnUsage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		providerResponses: 1,
		providerErrors: 0,
		maintenance: {
			compactions: 0,
			branchSummaries: 0,
			retries: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
		tools: { calls: 1, failed: 0, byName: { read: 1 } },
		phaseMs: { idle: 0, turn: 12, compaction: 0, branch_summary: 0, retry: 0 },
		humanRequests: 0,
	},
	agents: [],
};

describe("PrintTextOutput", () => {
	it("streams assistant text verbatim and labels the speaker only when it changes", () => {
		const writer = new MemoryWriter();
		const output = new PrintTextOutput({ writer });

		output.emit(textDelta("agent-1", "Hello, "));
		output.emit(textDelta("agent-1", "world."));
		output.emit(textDelta("agent-2", "And me."));

		expect(writer.text).toBe("[agent-1]\nHello, world.\n[agent-2]\nAnd me.");
	});

	it("gives a tool call one line and an extension event one line", () => {
		const writer = new MemoryWriter();
		const output = new PrintTextOutput({ writer });

		output.emit({
			type: "event",
			event: {
				type: "agent_harness_event",
				agentId: "agent-1",
				event: { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "/x" } },
			},
		} as PrintFrame);
		output.emit({
			type: "extension_event",
			event: {
				name: "drill:step",
				payload: { n: 1 },
				sourceExtensionId: "drill",
				sourceAgentId: "agent-1",
				emittedAt: "1970-01-01T00:00:00.000Z",
			},
		});

		expect(writer.text).toBe('→ read {"path":"/x"}\n« drill:step [drill] {"n":1}\n');
	});

	it("sends startup diagnostics to the note channel, keeping stdout to the run", () => {
		const writer = new MemoryWriter();
		const notes: string[] = [];
		const output = new PrintTextOutput({ writer, note: (text) => notes.push(text) });

		output.emit({
			type: "ready",
			protocolVersion: 1,
			rootAgentId: "agent-1",
			cwd: "/w",
			agentDir: "/a",
			diagnostics: [{ severity: "warning", code: "model.none_available", message: "no auth" }],
		});

		expect(writer.text).toBe("");
		expect(notes.join("")).toContain("model.none_available: no auth");
	});

	it("closes an open line of assistant text before the report and the totals", () => {
		const writer = new MemoryWriter();
		const output = new PrintTextOutput({ writer });

		output.emit(textDelta("agent-1", "unterminated"));
		output.emit({ type: "report", agentId: "agent-1", report: "THE ANSWER" });
		output.emit({ type: "run_summary", status: "ok", exitCode: 0, summary: EMPTY_SUMMARY });

		const lines = writer.text.split("\n");
		expect(lines).toContain("unterminated");
		expect(lines).toContain("THE ANSWER");
		expect(writer.text).toContain("status       ok (exit 0)");
		expect(writer.text).toContain("tools        1 call(s), 0 failed — read×1");
	});
});
