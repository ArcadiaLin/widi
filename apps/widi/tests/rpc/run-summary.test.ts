/**
 * The accounting rule, tested on synthetic events rather than through a live
 * orchestrator.
 *
 * That is the point rather than a shortcut: what has to be pinned here is the
 * arithmetic - which event moves which counter, and that maintenance never
 * lands on a turn - and a fixture that produced these events for real could not
 * make a split-turn compaction or a 429 happen on demand.
 */

import type { AgentHarnessEvent, CompactionEntry } from "@arcadialin/agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import { RunAccounting } from "../../src/rpc/run-summary.ts";

function usage(input: number, output: number, cost: number, cacheRead = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: input + output + cacheRead,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: usage(10, 5, 0.5),
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function harness(agentId: string, event: AgentHarnessEvent): OrchestratorEvent {
	return { type: "agent_harness_event", agentId, event };
}

/** A clock the test moves by hand, so phase timings are exact rather than flaky. */
function fixedClock(): { now: () => number; advance: (ms: number) => void } {
	let current = 1_000;
	return {
		now: () => current,
		advance: (ms) => {
			current += ms;
		},
	};
}

function compactionEntry(entryUsage?: Usage): CompactionEntry {
	return {
		id: "c1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		type: "compaction",
		summary: "summary",
		tokensBefore: 1_000,
		...(entryUsage === undefined ? undefined : { usage: entryUsage }),
	};
}

describe("RunAccounting", () => {
	it("counts a turn's tokens and cost, itemised", () => {
		const accounting = new RunAccounting();
		accounting.record(harness("a", { type: "message_end", message: assistant() }));
		accounting.record(harness("a", { type: "turn_end", message: assistant(), toolResults: [] }));

		const summary = accounting.summarize();
		expect(summary.total.turns).toBe(1);
		expect(summary.total.turnUsage.input).toBe(10);
		expect(summary.total.turnUsage.output).toBe(5);
		expect(summary.total.turnUsage.totalTokens).toBe(15);
		expect(summary.total.turnUsage.cost.total).toBe(0.5);
		expect(summary.total.lastStopReason).toBe("stop");
	});

	it("keeps maintenance out of the turn it precedes", () => {
		// The rule this file exists for. A sample that happened to trip a compaction
		// must not read as a more expensive turn than one that did not.
		const accounting = new RunAccounting();
		accounting.record(
			harness("a", { type: "session_compact", compactionEntry: compactionEntry(usage(900, 100, 9)), fromHook: false }),
		);
		accounting.record(harness("a", { type: "message_end", message: assistant() }));

		const { total } = accounting.summarize();
		expect(total.maintenance.compactions).toBe(1);
		expect(total.maintenance.usage.totalTokens).toBe(1_000);
		expect(total.maintenance.usage.cost.total).toBe(9);
		// Untouched by the compaction beside it.
		expect(total.turnUsage.totalTokens).toBe(15);
		expect(total.turnUsage.cost.total).toBe(0.5);
	});

	it("counts a branch summary only when one was generated", () => {
		const accounting = new RunAccounting();
		// Tree navigation with no summary made no model call.
		accounting.record(harness("a", { type: "session_tree", newLeafId: "l1", oldLeafId: "l0" }));
		accounting.record(
			harness("a", {
				type: "session_tree",
				newLeafId: "l2",
				oldLeafId: "l1",
				summaryEntry: {
					id: "s1",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					type: "branch_summary",
					fromId: "l1",
					summary: "gist",
					usage: usage(200, 20, 2),
				},
			}),
		);

		const { total } = accounting.summarize();
		expect(total.maintenance.branchSummaries).toBe(1);
		expect(total.maintenance.usage.totalTokens).toBe(220);
	});

	it("counts every provider attempt, and says how many failed", () => {
		// One turn, three HTTP responses: the retries are the difference between
		// "requests made" and "turns completed", and a client cannot see it any
		// other way - the harness's own retry events only cover maintenance.
		const accounting = new RunAccounting();
		accounting.record(harness("a", { type: "after_provider_response", status: 429, headers: {} }));
		accounting.record(harness("a", { type: "after_provider_response", status: 500, headers: {} }));
		accounting.record(harness("a", { type: "after_provider_response", status: 200, headers: {} }));

		const { total } = accounting.summarize();
		expect(total.providerResponses).toBe(3);
		expect(total.providerErrors).toBe(2);
	});

	it("counts maintenance retries separately from turn attempts", () => {
		const accounting = new RunAccounting();
		accounting.record(
			harness("a", {
				type: "retry_scheduled",
				operation: "compaction",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 10,
				errorMessage: "boom",
			}),
		);

		const { total } = accounting.summarize();
		expect(total.maintenance.retries).toBe(1);
		expect(total.providerErrors).toBe(0);
	});

	it("counts tool calls by name, and which failed", () => {
		const accounting = new RunAccounting();
		for (const [toolName, isError] of [
			["read", false],
			["read", false],
			["bash", true],
		] as const) {
			accounting.record(harness("a", { type: "tool_execution_end", toolCallId: "t", toolName, result: {}, isError }));
		}

		const { total } = accounting.summarize();
		expect(total.tools).toEqual({ calls: 3, failed: 1, byName: { bash: 1, read: 2 } });
	});

	it("times the phases from the transitions, closing the open one at the reading", () => {
		const clock = fixedClock();
		const accounting = new RunAccounting({ now: clock.now });
		clock.advance(100);
		accounting.record(harness("a", { type: "phase_change", phase: "turn", previousPhase: "idle" }));
		clock.advance(500);
		accounting.record(harness("a", { type: "phase_change", phase: "compaction", previousPhase: "turn" }));
		clock.advance(200);

		const { total, durationMs } = accounting.summarize();
		expect(durationMs).toBe(800);
		// 100ms before the agent was seen belongs to nobody: its bucket opens on its
		// first event, which is the transition out of idle.
		expect(total.phaseMs.idle).toBe(0);
		expect(total.phaseMs.turn).toBe(500);
		// Still in compaction when the reading was taken.
		expect(total.phaseMs.compaction).toBe(200);
	});

	it("splits per agent and adds them up in the total", () => {
		const accounting = new RunAccounting();
		accounting.record(harness("root", { type: "message_end", message: assistant() }));
		accounting.record(harness("child", { type: "message_end", message: assistant({ usage: usage(1, 1, 0.1) }) }));
		accounting.record(
			harness("child", { type: "tool_execution_end", toolCallId: "t", toolName: "read", result: {}, isError: false }),
		);

		const summary = accounting.summarize();
		expect(summary.agents.map((agent) => agent.agentId)).toEqual(["root", "child"]);
		const child = summary.agents.find((agent) => agent.agentId === "child");
		expect(child?.turnUsage.totalTokens).toBe(2);
		expect(child?.tools.calls).toBe(1);
		expect(summary.total.turnUsage.totalTokens).toBe(17);
		expect(summary.total.tools.calls).toBe(1);
	});

	it("counts a human request even when it belongs to no agent", () => {
		// Startup can ask before any agent exists, and an unattended run that waits
		// out a request has spent real time on nothing. The total must show it.
		const accounting = new RunAccounting();
		accounting.record({
			type: "human_request_pending",
			request: {
				id: "h1",
				kind: "confirm",
				title: "trust?",
				source: { kind: "system" },
				createdAt: new Date(0).toISOString(),
			},
		});
		accounting.record({
			type: "human_request_pending",
			agentId: "a",
			request: {
				id: "h2",
				kind: "confirm",
				title: "ok?",
				source: { kind: "agent", agentId: "a" },
				agentId: "a",
				createdAt: new Date(0).toISOString(),
			},
		});

		const summary = accounting.summarize();
		expect(summary.total.humanRequests).toBe(2);
		expect(summary.agents.find((agent) => agent.agentId === "a")?.humanRequests).toBe(1);
	});

	it("reports the last idle reason, which is not the stop reason", () => {
		const accounting = new RunAccounting();
		accounting.record(harness("a", { type: "message_end", message: assistant({ stopReason: "aborted" }) }));
		accounting.record({ type: "agent_idle", agentId: "a", reason: "aborted", idleAt: new Date(0).toISOString() });

		const { total } = accounting.summarize();
		expect(total.lastStopReason).toBe("aborted");
		expect(total.lastIdleReason).toBe("aborted");
	});

	it("detaches each reading from the accumulator behind it", () => {
		const accounting = new RunAccounting();
		accounting.record(harness("a", { type: "message_end", message: assistant() }));
		const first = accounting.summarize();
		accounting.record(harness("a", { type: "message_end", message: assistant() }));

		expect(first.total.turnUsage.totalTokens).toBe(15);
		expect(accounting.summarize().total.turnUsage.totalTokens).toBe(30);
	});
});
