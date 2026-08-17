/**
 * Rollups over a set of records.
 *
 * Two different time measures, kept apart because they answer different
 * questions: `spanMs` is wall time from first start to last end, and `busyMs`
 * is the union of the intervals something was actually running. Summing
 * durations instead of unioning them would double count the tools of one
 * assistant turn, and a run that spent an hour waiting for a human would look
 * like an hour of work.
 */

import type { TrajectoryRecord, TrajectoryStats, UsageSummary } from "./types.ts";
import { emptyStats, emptyUsage } from "./types.ts";

function addUsage(total: UsageSummary, usage: UsageSummary): UsageSummary {
	return {
		input: total.input + usage.input,
		output: total.output + usage.output,
		cacheRead: total.cacheRead + usage.cacheRead,
		cacheWrite: total.cacheWrite + usage.cacheWrite,
		...(usage.reasoning === undefined && total.reasoning === undefined
			? undefined
			: { reasoning: (total.reasoning ?? 0) + (usage.reasoning ?? 0) }),
		total: total.total + usage.total,
		cost: total.cost + usage.cost,
	};
}

/** Total length of the union of a set of intervals. */
function unionLength(intervals: readonly { start: number; end: number }[]): number {
	const sorted = [...intervals].filter((span) => span.end > span.start).sort((left, right) => left.start - right.start);
	let total = 0;
	let coveredUntil = Number.NEGATIVE_INFINITY;
	for (const span of sorted) {
		const start = Math.max(span.start, coveredUntil);
		if (span.end > start) total += span.end - start;
		coveredUntil = Math.max(coveredUntil, span.end);
	}
	return total;
}

export function statsOf(records: readonly TrajectoryRecord[], turns: number): TrajectoryStats {
	if (records.length === 0) return { ...emptyStats(), turns };
	let tokens = emptyUsage();
	let requests = 0;
	let toolCalls = 0;
	let errors = 0;
	let firstAt = Number.POSITIVE_INFINITY;
	let lastAt = Number.NEGATIVE_INFINITY;
	for (const record of records) {
		if (record.usage !== undefined) tokens = addUsage(tokens, record.usage);
		if (record.kind === "assistant") requests++;
		if (record.kind === "tool") toolCalls++;
		if (record.isError === true) errors++;
		if (record.startedAt > 0) firstAt = Math.min(firstAt, record.startedAt);
		lastAt = Math.max(lastAt, record.endedAt);
	}
	const bounded = Number.isFinite(firstAt) && Number.isFinite(lastAt);
	return {
		records: records.length,
		turns,
		requests,
		toolCalls,
		errors,
		tokens,
		spanMs: bounded ? Math.max(0, lastAt - firstAt) : 0,
		busyMs: unionLength(records.map((record) => ({ start: record.startedAt, end: record.endedAt }))),
		firstAt: bounded ? firstAt : null,
		lastAt: bounded ? lastAt : null,
	};
}
