/** The scenario most tests read: a parent that delegates, waits, and releases. */

import { assistantEntry, type FixtureSession, noticeEntry, toolResultEntry, userEntry } from "./session-fixture.ts";

export const PARENT_DIR = "20260801T120000Z_root-1";
export const CHILD_DIR = "20260801T120010Z_plan-1";

export function delegationScenario(): FixtureSession {
	return {
		dirName: PARENT_DIR,
		id: "root-1",
		timestamp: "2026-08-01T12:00:00.000Z",
		metadata: { profile: { id: "widi-dev", label: "WIDI Dev" } },
		entries: [
			userEntry("e1", null, "2026-08-01T12:00:01.000Z", "plan the refactor"),
			assistantEntry("e2", "e1", "2026-08-01T12:00:05.000Z", {
				startedAt: "2026-08-01T12:00:02.000Z",
				thinking: "this is big enough to delegate",
				text: "delegating",
				toolCalls: [{ id: "call-1", name: "spawn_agent", arguments: { agents: [{ profile: "plan" }] } }],
			}),
			toolResultEntry("e3", "e2", "2026-08-01T12:00:10.000Z", {
				toolCallId: "call-1",
				toolName: "spawn_agent",
				text: "Spawn requested",
				details: { agents: [{ origin: "new", agentId: "plan-1", profileId: "plan", watching: true }] },
			}),
			assistantEntry("e4", "e3", "2026-08-01T12:00:12.000Z", {
				startedAt: "2026-08-01T12:00:11.000Z",
				text: "waiting",
			}),
			noticeEntry("e5", "e4", "2026-08-01T12:00:40.000Z", {
				senderAgentId: "plan-1",
				body: "here is the plan",
				notice: { status: "idle", reason: "settled" },
			}),
			assistantEntry("e6", "e5", "2026-08-01T12:00:44.000Z", {
				startedAt: "2026-08-01T12:00:41.000Z",
				text: "releasing",
				toolCalls: [{ id: "call-2", name: "dispose_agent", arguments: { agentId: "plan-1" } }],
			}),
			toolResultEntry("e7", "e6", "2026-08-01T12:00:45.000Z", {
				toolCallId: "call-2",
				toolName: "dispose_agent",
				text: "disposed",
				details: { scope: "agent", agents: [{ agentId: "plan-1", state: "disposed" }] },
			}),
			assistantEntry("e8", "e7", "2026-08-01T12:00:47.000Z", { startedAt: "2026-08-01T12:00:46.000Z", text: "done" }),
		],
		children: [
			{
				dirName: CHILD_DIR,
				id: "plan-1",
				timestamp: "2026-08-01T12:00:10.000Z",
				metadata: { profile: { id: "plan" }, origin: { spawnedBy: PARENT_DIR } },
				entries: [
					noticeEntry("c1", null, "2026-08-01T12:00:10.500Z", { senderAgentId: "root-1", body: "plan the refactor" }),
					assistantEntry("c2", "c1", "2026-08-01T12:00:39.000Z", {
						startedAt: "2026-08-01T12:00:11.000Z",
						text: "here is the plan",
					}),
				],
			},
		],
	};
}
