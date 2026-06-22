import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type {
	ToolContributionSource,
	ToolPatchContribution,
} from "../src/core/tools/types.ts";

export type ToolTrackingMode = "minimal" | "metadata" | "tail" | "full";
export type ToolRunStatus = "running" | "succeeded" | "failed";

export interface ToolRunStart {
	toolCallId: string;
	toolName: string;
	source: ToolContributionSource;
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
	source: ToolContributionSource;
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
	update(
		trackingId: string,
		update: ToolRunUpdate,
	): ToolRunSnapshot | undefined;
	finish(
		trackingId: string,
		finish?: ToolRunFinish,
	): ToolRunSnapshot | undefined;
	fail(
		trackingId: string,
		failure?: ToolRunFailure,
	): ToolRunSnapshot | undefined;
	get(trackingId: string): ToolRunSnapshot | undefined;
	list(): ToolRunSnapshot[];
	wait(trackingId: string): Promise<ToolRunSnapshot | undefined>;
}

export interface ToolTrackingPolicy<TParams = unknown, TDetails = unknown> {
	mode?: ToolTrackingMode;
	describeParams?: (params: TParams) => unknown;
	describeUpdate?: (update: AgentToolResult<TDetails>) => unknown;
	describeResult?: (result: AgentToolResult<TDetails>) => unknown;
	describeError?: (error: unknown) => unknown;
}

export interface ToolTrackerContributionOptions<
	TParamsSchema extends TSchema = TSchema,
	TDetails = unknown,
> {
	source: ToolContributionSource;
	targetToolName: string;
	tracker: ToolTracker;
	policy?: false | ToolTrackingPolicy<Static<TParamsSchema>, TDetails>;
}

type Waiter = (snapshot: ToolRunSnapshot | undefined) => void;

interface MutableToolRun {
	trackingId: string;
	toolCallId: string;
	toolName: string;
	source: ToolContributionSource;
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

	update(
		trackingId: string,
		update: ToolRunUpdate,
	): ToolRunSnapshot | undefined {
		const run = this.runs.get(trackingId);
		if (!run || run.status !== "running")
			return run ? snapshotOf(run) : undefined;
		if (update.metadata !== undefined) run.metadata = update.metadata;
		if (update.update !== undefined) run.updates.push(update.update);
		return snapshotOf(run);
	}

	finish(
		trackingId: string,
		finish: ToolRunFinish = {},
	): ToolRunSnapshot | undefined {
		const run = this.runs.get(trackingId);
		if (!run) return undefined;
		if (run.status !== "running") return snapshotOf(run);
		if (finish.metadata !== undefined) run.metadata = finish.metadata;
		if (finish.result !== undefined) run.result = finish.result;
		this.complete(run, "succeeded");
		return snapshotOf(run);
	}

	fail(
		trackingId: string,
		failure: ToolRunFailure = {},
	): ToolRunSnapshot | undefined {
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

	private complete(
		run: MutableToolRun,
		status: Exclude<ToolRunStatus, "running">,
	): void {
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

export function createToolTrackerContribution(
	options: ToolTrackerContributionOptions,
): ToolPatchContribution<TSchema, unknown, unknown> {
	const { source, targetToolName, tracker, policy } = options;
	return {
		type: "patch",
		source,
		targetToolName,
		patch: {
			aroundExecute: async (next, toolCallId, params, context) => {
				if (policy === false) {
					return next(toolCallId, params, context);
				}
				const started = tracker.start({
					toolCallId,
					toolName: targetToolName,
					source,
					metadata: describeParams(policy, params),
				});
				const trackedOnUpdate: typeof context.onUpdate = (update) => {
					tracker.update(started.trackingId, {
						update: describeUpdate(policy, update),
					});
					context.onUpdate?.(update);
				};
				try {
					const result = await next(toolCallId, params, {
						...context,
						onUpdate: trackedOnUpdate,
					});
					tracker.finish(started.trackingId, {
						result: describeResult(policy, result),
					});
					return result;
				} catch (error) {
					tracker.fail(started.trackingId, {
						error: describeError(policy, error),
					});
					throw error;
				}
			},
		},
	};
}

function describeParams(
	tracking: ToolTrackingPolicy | undefined,
	params: unknown,
): unknown {
	if (!tracking || tracking.mode === "minimal") return undefined;
	return tracking.describeParams?.(params);
}

function describeUpdate(
	tracking: ToolTrackingPolicy | undefined,
	update: AgentToolResult<unknown>,
): unknown {
	if (!tracking || tracking.mode === "minimal") return undefined;
	return tracking.describeUpdate?.(update);
}

function describeResult(
	tracking: ToolTrackingPolicy | undefined,
	result: AgentToolResult<unknown>,
): unknown {
	if (!tracking || tracking.mode === "minimal") return undefined;
	return tracking.describeResult?.(result);
}

function describeError(
	tracking: ToolTrackingPolicy | undefined,
	error: unknown,
): unknown {
	if (!tracking || tracking.mode === "minimal") return undefined;
	return tracking.describeError?.(error);
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
