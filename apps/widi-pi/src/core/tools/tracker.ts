import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolContributionSource } from "./types.ts";

export type ToolTrackingMode = "minimal" | "metadata" | "tail" | "full";
export type ToolRunStatus = "running" | "succeeded" | "failed";

export interface ToolTrackingSource {
	kind: ToolContributionSource["kind"];
	id: string;
}

export interface ToolRunStart {
	toolCallId: string;
	toolName: string;
	source: ToolTrackingSource;
	metadata?: unknown;
}

export interface ToolRunUpdate {
	metadata?: unknown;
	update?: unknown;
}

export interface ToolRunFinish {
	metadata?: unknown;
	result?: unknown;
}

export interface ToolRunFailure {
	metadata?: unknown;
	error?: unknown;
}

export interface ToolRunSnapshot {
	trackingId: string;
	toolCallId: string;
	toolName: string;
	source: ToolTrackingSource;
	status: ToolRunStatus;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	metadata?: unknown;
	updates: readonly unknown[];
	result?: unknown;
	error?: unknown;
}

export interface ToolTracker {
	start(run: ToolRunStart): ToolRunSnapshot;
	update(trackingId: string, update: ToolRunUpdate): ToolRunSnapshot | undefined;
	finish(trackingId: string, finish?: ToolRunFinish): ToolRunSnapshot | undefined;
	fail(trackingId: string, failure?: ToolRunFailure): ToolRunSnapshot | undefined;
	get(trackingId: string): ToolRunSnapshot | undefined;
	list(): ToolRunSnapshot[];
	wait(trackingId: string): Promise<ToolRunSnapshot | undefined>;
}

type Waiter = (snapshot: ToolRunSnapshot | undefined) => void;

interface MutableToolRun {
	trackingId: string;
	toolCallId: string;
	toolName: string;
	source: ToolTrackingSource;
	status: ToolRunStatus;
	startedAt: string;
	startedAtMs: number;
	endedAt?: string;
	durationMs?: number;
	metadata?: unknown;
	updates: unknown[];
	result?: unknown;
	error?: unknown;
}

export class InMemoryToolTracker implements ToolTracker {
	private readonly runs = new Map<string, MutableToolRun>();
	private readonly waiters = new Map<string, Waiter[]>();
	private nextId = 1;

	start(run: ToolRunStart): ToolRunSnapshot {
		const startedAtMs = Date.now();
		const trackedRun: MutableToolRun = {
			trackingId: `tool-run-${this.nextId}`,
			toolCallId: run.toolCallId,
			toolName: run.toolName,
			source: { ...run.source },
			status: "running",
			startedAt: new Date(startedAtMs).toISOString(),
			startedAtMs,
			metadata: run.metadata,
			updates: [],
		};
		this.nextId += 1;
		this.runs.set(trackedRun.trackingId, trackedRun);
		return snapshotOf(trackedRun);
	}

	update(trackingId: string, update: ToolRunUpdate): ToolRunSnapshot | undefined {
		const run = this.runs.get(trackingId);
		if (!run || run.status !== "running") return run ? snapshotOf(run) : undefined;
		if (update.metadata !== undefined) run.metadata = update.metadata;
		if (update.update !== undefined) run.updates.push(update.update);
		return snapshotOf(run);
	}

	finish(trackingId: string, finish: ToolRunFinish = {}): ToolRunSnapshot | undefined {
		const run = this.runs.get(trackingId);
		if (!run) return undefined;
		if (run.status !== "running") return snapshotOf(run);
		if (finish.metadata !== undefined) run.metadata = finish.metadata;
		if (finish.result !== undefined) run.result = finish.result;
		this.complete(run, "succeeded");
		return snapshotOf(run);
	}

	fail(trackingId: string, failure: ToolRunFailure = {}): ToolRunSnapshot | undefined {
		const run = this.runs.get(trackingId);
		if (!run) return undefined;
		if (run.status !== "running") return snapshotOf(run);
		if (failure.metadata !== undefined) run.metadata = failure.metadata;
		if (failure.error !== undefined) run.error = failure.error;
		this.complete(run, "failed");
		return snapshotOf(run);
	}

	get(trackingId: string): ToolRunSnapshot | undefined {
		const run = this.runs.get(trackingId);
		return run ? snapshotOf(run) : undefined;
	}

	list(): ToolRunSnapshot[] {
		return Array.from(this.runs.values()).map((run) => snapshotOf(run));
	}

	wait(trackingId: string): Promise<ToolRunSnapshot | undefined> {
		const run = this.runs.get(trackingId);
		if (!run || run.status !== "running") {
			return Promise.resolve(run ? snapshotOf(run) : undefined);
		}
		return new Promise((resolve) => {
			const waiters = this.waiters.get(trackingId) ?? [];
			waiters.push(resolve);
			this.waiters.set(trackingId, waiters);
		});
	}

	private complete(run: MutableToolRun, status: Exclude<ToolRunStatus, "running">): void {
		const endedAtMs = Date.now();
		run.status = status;
		run.endedAt = new Date(endedAtMs).toISOString();
		run.durationMs = Math.max(0, endedAtMs - run.startedAtMs);
		const snapshot = snapshotOf(run);
		const waiters = this.waiters.get(run.trackingId) ?? [];
		this.waiters.delete(run.trackingId);
		for (const resolve of waiters) {
			resolve(snapshot);
		}
	}
}

export const noopToolTracker: ToolTracker = {
	start: (run) => ({
		trackingId: "",
		toolCallId: run.toolCallId,
		toolName: run.toolName,
		source: run.source,
		status: "running",
		startedAt: new Date(0).toISOString(),
		metadata: run.metadata,
		updates: [],
	}),
	update: () => undefined,
	finish: () => undefined,
	fail: () => undefined,
	get: () => undefined,
	list: () => [],
	wait: async () => undefined,
};

export interface ToolTrackingPolicy<TParams = unknown, TDetails = unknown> {
	mode?: ToolTrackingMode;
	describeParams?: (params: TParams) => unknown;
	describeUpdate?: (update: AgentToolResult<TDetails>) => unknown;
	describeResult?: (result: AgentToolResult<TDetails>) => unknown;
	describeError?: (error: unknown) => unknown;
}

function snapshotOf(run: MutableToolRun): ToolRunSnapshot {
	return {
		trackingId: run.trackingId,
		toolCallId: run.toolCallId,
		toolName: run.toolName,
		source: { ...run.source },
		status: run.status,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		durationMs: run.durationMs,
		metadata: run.metadata,
		updates: [...run.updates],
		result: run.result,
		error: run.error,
	};
}
