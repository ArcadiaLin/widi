import { describe, expect, it } from "vitest";
import { discoverSession, resolveTarget } from "../src/load/discover.ts";
import { buildBundle } from "../src/model/bundle.ts";
import { CHILD_DIR, delegationScenario, PARENT_DIR } from "./helpers/scenario.ts";
import { makeTempDir, userEntry, writeSessionTree } from "./helpers/session-fixture.ts";

async function bundleOfScenario() {
	const root = await makeTempDir();
	const dirPath = await writeSessionTree(root, delegationScenario());
	return { root, bundle: await buildBundle({ session: await discoverSession(dirPath) }) };
}

describe("buildBundle", () => {
	it("recovers the spawn tree from the directory layout", async () => {
		const { bundle } = await bundleOfScenario();
		expect(bundle.agents.map((agent) => [agent.agentId, agent.parentKey, agent.depth])).toEqual([
			["root-1", null, 0],
			["plan-1", PARENT_DIR, 1],
		]);
		expect(bundle.agents[1].key).toBe(`${PARENT_DIR}/${CHILD_DIR}`);
		expect(bundle.agents[0].profile).toEqual({ id: "widi-dev", label: "WIDI Dev" });
		expect(bundle.diagnostics).toEqual([]);
	});

	it("resolves a spawn link to the child's session key", async () => {
		const { bundle } = await bundleOfScenario();
		const spawn = bundle.agents[0].records.find((record) => record.title === "spawn_agent");
		expect(spawn?.link).toEqual({
			kind: "spawn",
			direction: "out",
			targets: [{ agentId: "plan-1", agentKey: `${PARENT_DIR}/${CHILD_DIR}`, note: "plan · watched" }],
		});
	});

	it("resolves a report back to the child, and the child's task back to the parent", async () => {
		const { bundle } = await bundleOfScenario();
		const notice = bundle.agents[0].records.find((record) => record.kind === "notice");
		expect(notice?.link?.direction).toBe("in");
		expect(notice?.link?.targets[0].agentKey).toBe(`${PARENT_DIR}/${CHILD_DIR}`);
		expect(notice?.link?.status).toBe("idle");

		const task = bundle.agents[1].records[0];
		expect(task.link).toEqual({
			kind: "message",
			direction: "in",
			targets: [{ agentId: "root-1", agentKey: PARENT_DIR, note: "sent to this agent" }],
		});
	});

	it("keeps a link to an agent that left no session, with a null key", async () => {
		const root = await makeTempDir();
		const scenario = delegationScenario();
		const dirPath = await writeSessionTree(root, { ...scenario, children: [] });
		const bundle = await buildBundle({ session: await discoverSession(dirPath) });
		const spawn = bundle.agents[0].records.find((record) => record.title === "spawn_agent");
		expect(spawn?.link?.targets[0]).toEqual({ agentId: "plan-1", agentKey: null, note: "plan · watched" });
	});

	it("rolls up tokens, cost and both time measures per agent", async () => {
		const { bundle } = await bundleOfScenario();
		const stats = bundle.agents[0].stats;
		expect(stats.requests).toBe(4);
		expect(stats.toolCalls).toBe(2);
		expect(stats.turns).toBe(2);
		expect(stats.tokens.total).toBe(480);
		expect(stats.tokens.cost).toBeCloseTo(0.04, 10);
		expect(stats.spanMs).toBe(46_000);
		// Idle time between the reply and the report is not busy time.
		expect(stats.busyMs).toBeLessThan(stats.spanMs);
	});

	it("reports an unreadable session without losing the rest of the tree", async () => {
		const root = await makeTempDir();
		const scenario = delegationScenario();
		const dirPath = await writeSessionTree(root, {
			...scenario,
			children: [{ dirName: CHILD_DIR, id: "plan-1", timestamp: "2026-08-01T12:00:10.000Z", entries: [], trailer: "" }],
		});
		const { writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		await writeFile(join(dirPath, "agents", CHILD_DIR, "session.jsonl"), "not json\n", "utf8");
		const bundle = await buildBundle({ session: await discoverSession(dirPath) });
		expect(bundle.agents.map((agent) => agent.agentId)).toEqual(["root-1"]);
		expect(bundle.diagnostics[0].code).toBe("unreadable_session");
	});
});

describe("resolveTarget", () => {
	it("accepts a runs root and picks the newest session under it", async () => {
		const root = await makeTempDir();
		const { mkdir } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const group = join(root, "--work--");
		await mkdir(group, { recursive: true });
		await writeSessionTree(group, {
			dirName: "20260801T100000Z_old",
			id: "old",
			timestamp: "2026-08-01T10:00:00.000Z",
			entries: [userEntry("e1", null, "2026-08-01T10:00:01.000Z", "old")],
		});
		const newer = await writeSessionTree(group, {
			dirName: "20260801T110000Z_new",
			id: "new",
			timestamp: "2026-08-01T11:00:00.000Z",
			entries: [userEntry("e1", null, "2026-08-01T11:00:01.000Z", "new")],
		});
		const resolved = await resolveTarget(root);
		expect(resolved.session.dirPath).toBe(newer);
	});
});
