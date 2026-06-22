import { describe, expect, it } from "vitest";
import { InMemoryToolTracker, noopToolTracker } from "../../src/core/tools/tracker.ts";

const source = { kind: "core" as const, id: "builtin" };

describe("InMemoryToolTracker", () => {
	it("tracks run lifecycle snapshots", () => {
		const tracker = new InMemoryToolTracker();
		const started = tracker.start({
			toolCallId: "call-1",
			toolName: "read",
			source,
			metadata: { path: "README.md" },
		});

		expect(started).toMatchObject({
			trackingId: "tool-run-1",
			toolCallId: "call-1",
			toolName: "read",
			source,
			status: "running",
			metadata: { path: "README.md" },
			updates: [],
		});

		const updated = tracker.update(started.trackingId, {
			metadata: { path: "README.md", lines: 10 },
			update: { bytes: 120 },
		});
		expect(updated).toMatchObject({
			status: "running",
			metadata: { path: "README.md", lines: 10 },
			updates: [{ bytes: 120 }],
		});

		const finished = tracker.finish(started.trackingId, {
			result: { ok: true },
		});

		expect(finished).toMatchObject({
			status: "succeeded",
			result: { ok: true },
			updates: [{ bytes: 120 }],
		});
		expect(finished?.endedAt).toBeDefined();
		expect(finished?.durationMs).toBeGreaterThanOrEqual(0);
		expect(tracker.get(started.trackingId)?.status).toBe("succeeded");
		expect(tracker.list()).toHaveLength(1);
	});

	it("resolves wait when a running run finishes", async () => {
		const tracker = new InMemoryToolTracker();
		const started = tracker.start({
			toolCallId: "call-1",
			toolName: "bash",
			source,
		});

		const waited = tracker.wait(started.trackingId);
		tracker.finish(started.trackingId, { result: { exitCode: 0 } });

		await expect(waited).resolves.toMatchObject({
			trackingId: started.trackingId,
			status: "succeeded",
			result: { exitCode: 0 },
		});
	});

	it("returns completed and missing runs immediately from wait", async () => {
		const tracker = new InMemoryToolTracker();
		const started = tracker.start({
			toolCallId: "call-1",
			toolName: "write",
			source,
		});
		tracker.fail(started.trackingId, { error: "boom" });

		await expect(tracker.wait(started.trackingId)).resolves.toMatchObject({
			status: "failed",
			error: "boom",
		});
		await expect(tracker.wait("missing")).resolves.toBeUndefined();
	});

	it("no-op tracker does not store state or throw", async () => {
		const started = noopToolTracker.start({
			toolCallId: "call-1",
			toolName: "read",
			source,
		});

		expect(started.status).toBe("running");
		expect(noopToolTracker.update(started.trackingId, { update: "ignored" })).toBeUndefined();
		expect(noopToolTracker.finish(started.trackingId)).toBeUndefined();
		expect(noopToolTracker.fail(started.trackingId)).toBeUndefined();
		expect(noopToolTracker.get(started.trackingId)).toBeUndefined();
		expect(noopToolTracker.list()).toEqual([]);
		await expect(noopToolTracker.wait(started.trackingId)).resolves.toBeUndefined();
	});
});
