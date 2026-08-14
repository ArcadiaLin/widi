/**
 * What a run cost, counted once here instead of in every client.
 *
 * Every fact below is already on the event stream, so this adds no source of
 * truth - what it adds is one definition of the totals. A benchmark that sums
 * them itself has to decide what a "request" is and which calls belong to which
 * turn, and two drivers deciding that separately produce two different numbers
 * for the same run.
 *
 * The accounting rule that shapes the whole shape: **maintenance work makes its
 * own provider calls, and they do not belong to the turn that follows it.**
 * Compaction and branch summarization each call the model, and a sample that
 * happened to trip one would otherwise look inexplicably expensive. They are
 * separated structurally rather than by guessing from timing: the turn loop's
 * calls surface as assistant `message_end` and `after_provider_response`, while
 * maintenance never goes through that loop at all (`compact()` takes `Models`
 * directly) and surfaces only as `session_compact` / `session_tree` carrying the
 * usage of the call that produced the entry.
 *
 * What is deliberately not counted:
 *
 * - Usage a tool reports on its own result. A delegating tool's cost is already
 *   counted under the agent that did the work, so adding it here would count it
 *   twice.
 * - Anything an extension spends on its own API calls. Core has no hook for it
 *   and should not; an extension that wants it counted reports it itself.
 *
 * Two limits are worth knowing before reading a number as exact:
 *
 * - Accounting starts when this object does, which is just before `ready`. The
 *   root agent is spawned before the client registers (`docs/rpc.md` section
 *   5.3), so its `agent_spawned` is not among the events seen here. Nothing that
 *   costs anything happens in that window - an agent spawns idle - but the agent
 *   appears in this summary only once it does something.
 * - Maintenance provider *calls* are not countable, only maintenance
 *   *operations*. One compaction of a split turn makes two model calls and emits
 *   one `session_compact`. The usage is complete either way; the call count is
 *   not, and there is nothing on the stream that would make it so.
 */

import type { AgentHarnessEvent, AgentHarnessPhase } from "@arcadialin/agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentId, AgentIdleReason, OrchestratorEvent } from "../core/types.ts";

/** Tokens and money, itemised as the provider reported them. */
export interface RpcUsageTotals {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	/** A subset of `output`, when the provider breaks it out. */
	readonly reasoning: number;
	readonly totalTokens: number;
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
}

/** Compaction and branch summarization: their own calls, kept out of the turns. */
export interface RpcMaintenanceTotals {
	readonly compactions: number;
	readonly branchSummaries: number;
	/** Retried maintenance attempts. The turn loop's own retries are `providerErrors`. */
	readonly retries: number;
	readonly usage: RpcUsageTotals;
}

export interface RpcToolTotals {
	readonly calls: number;
	readonly failed: number;
	readonly byName: Readonly<Record<string, number>>;
}

export interface RpcRunTotals {
	/** Assistant responses the loop completed, tool calls of theirs included. */
	readonly turns: number;
	readonly turnUsage: RpcUsageTotals;
	/**
	 * Provider HTTP responses in the turn loop, one per attempt - so a retried
	 * request counts more than once, and `providerErrors` says how many of those
	 * were the retried ones.
	 */
	readonly providerResponses: number;
	/** Responses with a 4xx/5xx status. */
	readonly providerErrors: number;
	readonly maintenance: RpcMaintenanceTotals;
	readonly tools: RpcToolTotals;
	/**
	 * Wall time per harness phase. Summed over agents in `total`, so it is
	 * agent-time and may exceed the run's own duration when agents ran together.
	 */
	readonly phaseMs: Readonly<Record<AgentHarnessPhase, number>>;
	/**
	 * Human requests raised. Zero is the expected value for an unattended run;
	 * anything else is wall time spent waiting for an answer nobody sent.
	 */
	readonly humanRequests: number;
	/** The provider's word on the last assistant message: `stop`, `length`, `error`... */
	readonly lastStopReason?: string;
	/** The orchestrator's word on the last arrival at idle. A different question. */
	readonly lastIdleReason?: AgentIdleReason;
}

export interface RpcAgentRunSummary extends RpcRunTotals {
	readonly agentId: AgentId;
}

export interface RpcRunSummary {
	/** When accounting began, which is startup and not the first command. */
	readonly startedAt: string;
	readonly durationMs: number;
	/**
	 * Every agent's numbers added up, plus what belongs to no agent - a human
	 * request raised during startup has no `agentId` and is counted only here.
	 */
	readonly total: RpcRunTotals;
	/** Per agent, in the order each was first seen. Disposed agents stay. */
	readonly agents: readonly RpcAgentRunSummary[];
}

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * One accumulator. `phase` and `phaseSince` are state rather than results, which
 * is why the wire shape is projected rather than returned directly.
 */
function emptyBucket(startedAt: number) {
	return {
		turns: 0,
		turnUsage: emptyUsage(),
		providerResponses: 0,
		providerErrors: 0,
		maintenance: { compactions: 0, branchSummaries: 0, retries: 0, usage: emptyUsage() },
		tools: { calls: 0, failed: 0, byName: new Map<string, number>() },
		phaseMs: { idle: 0, turn: 0, compaction: 0, branch_summary: 0, retry: 0 } as Record<AgentHarnessPhase, number>,
		humanRequests: 0,
		lastStopReason: undefined as string | undefined,
		lastIdleReason: undefined as AgentIdleReason | undefined,
		// An agent starts idle, and the bucket starts when the agent is first seen.
		phase: "idle" as AgentHarnessPhase,
		phaseSince: startedAt,
	};
}

type Bucket = ReturnType<typeof emptyBucket>;
type MutableUsage = ReturnType<typeof emptyUsage>;

function copyUsage(usage: MutableUsage): RpcUsageTotals {
	return { ...usage, cost: { ...usage.cost } };
}

function addUsage(into: MutableUsage, usage: Usage): void {
	into.input += usage.input;
	into.output += usage.output;
	into.cacheRead += usage.cacheRead;
	into.cacheWrite += usage.cacheWrite;
	into.reasoning += usage.reasoning ?? 0;
	into.totalTokens += usage.totalTokens;
	into.cost.input += usage.cost.input;
	into.cost.output += usage.cost.output;
	into.cost.cacheRead += usage.cost.cacheRead;
	into.cost.cacheWrite += usage.cost.cacheWrite;
	into.cost.total += usage.cost.total;
}

export class RunAccounting {
	private readonly _startedAt: number;
	private readonly _now: () => number;
	/** Everything, including what no agent owns. Its phase pointer is unused. */
	private readonly _total: Bucket;
	private readonly _agents = new Map<AgentId, Bucket>();

	constructor(options: { readonly now?: () => number } = {}) {
		this._now = options.now ?? Date.now;
		this._startedAt = this._now();
		this._total = emptyBucket(this._startedAt);
	}

	/**
	 * Fold one event in. Called for every event the client receives, so it stays
	 * synchronous and allocation-light: it sits directly in front of the write
	 * tail that the model loop's backpressure runs through.
	 */
	record(event: OrchestratorEvent): void {
		if (event.type === "human_request_pending") {
			this._total.humanRequests += 1;
			if (event.agentId !== undefined) this._bucket(event.agentId).humanRequests += 1;
			return;
		}
		if (event.type === "agent_idle") {
			this._total.lastIdleReason = event.reason;
			this._bucket(event.agentId).lastIdleReason = event.reason;
			return;
		}
		if (event.type !== "agent_harness_event") return;
		this._recordHarness(this._bucket(event.agentId), event.event);
	}

	summarize(): RpcRunSummary {
		const now = this._now();
		const agents: RpcAgentRunSummary[] = [];
		const phaseMs = { idle: 0, turn: 0, compaction: 0, branch_summary: 0, retry: 0 } as Record<
			AgentHarnessPhase,
			number
		>;
		for (const [agentId, bucket] of this._agents) {
			const closed = closePhase(bucket, now);
			for (const phase of Object.keys(phaseMs) as AgentHarnessPhase[]) phaseMs[phase] += closed[phase];
			agents.push({ agentId, ...project(bucket, closed) });
		}
		return {
			startedAt: new Date(this._startedAt).toISOString(),
			durationMs: now - this._startedAt,
			total: project(this._total, phaseMs),
			agents,
		};
	}

	private _bucket(agentId: AgentId): Bucket {
		const existing = this._agents.get(agentId);
		if (existing) return existing;
		const bucket = emptyBucket(this._now());
		this._agents.set(agentId, bucket);
		return bucket;
	}

	private _recordHarness(bucket: Bucket, event: AgentHarnessEvent): void {
		switch (event.type) {
			case "turn_end":
				bucket.turns += 1;
				this._total.turns += 1;
				return;
			case "message_end": {
				// Also emitted for user and toolResult messages; only an assistant one
				// is a provider response, and only it carries usage.
				if (event.message.role !== "assistant") return;
				bucket.lastStopReason = event.message.stopReason;
				this._total.lastStopReason = event.message.stopReason;
				addUsage(bucket.turnUsage, event.message.usage);
				addUsage(this._total.turnUsage, event.message.usage);
				return;
			}
			case "after_provider_response": {
				bucket.providerResponses += 1;
				this._total.providerResponses += 1;
				if (event.status < 400) return;
				bucket.providerErrors += 1;
				this._total.providerErrors += 1;
				return;
			}
			case "tool_execution_end": {
				for (const target of [bucket, this._total]) {
					target.tools.calls += 1;
					if (event.isError) target.tools.failed += 1;
					target.tools.byName.set(event.toolName, (target.tools.byName.get(event.toolName) ?? 0) + 1);
				}
				return;
			}
			case "session_compact": {
				for (const target of [bucket, this._total]) {
					target.maintenance.compactions += 1;
					if (event.compactionEntry.usage) addUsage(target.maintenance.usage, event.compactionEntry.usage);
				}
				return;
			}
			case "session_tree": {
				// Tree navigation without a summary entry made no model call.
				if (event.summaryEntry === undefined) return;
				for (const target of [bucket, this._total]) {
					target.maintenance.branchSummaries += 1;
					if (event.summaryEntry.usage) addUsage(target.maintenance.usage, event.summaryEntry.usage);
				}
				return;
			}
			case "retry_scheduled":
				bucket.maintenance.retries += 1;
				this._total.maintenance.retries += 1;
				return;
			case "phase_change": {
				const now = this._now();
				bucket.phaseMs[bucket.phase] += now - bucket.phaseSince;
				bucket.phase = event.phase;
				bucket.phaseSince = now;
				return;
			}
			default:
				return;
		}
	}
}

/** The open interval closed at `now`, without disturbing the accumulator. */
function closePhase(bucket: Bucket, now: number): Record<AgentHarnessPhase, number> {
	const closed = { ...bucket.phaseMs };
	closed[bucket.phase] += now - bucket.phaseSince;
	return closed;
}

/**
 * A reading, detached from the accumulator behind it. Copied rather than
 * referenced: the accumulator keeps going, and a client that holds a summary
 * across later events must not watch it change under them.
 */
function project(bucket: Bucket, phaseMs: Record<AgentHarnessPhase, number>): RpcRunTotals {
	return {
		turns: bucket.turns,
		turnUsage: copyUsage(bucket.turnUsage),
		providerResponses: bucket.providerResponses,
		providerErrors: bucket.providerErrors,
		maintenance: { ...bucket.maintenance, usage: copyUsage(bucket.maintenance.usage) },
		tools: {
			calls: bucket.tools.calls,
			failed: bucket.tools.failed,
			byName: Object.fromEntries([...bucket.tools.byName].sort(([left], [right]) => left.localeCompare(right))),
		},
		phaseMs,
		humanRequests: bucket.humanRequests,
		...(bucket.lastStopReason === undefined ? undefined : { lastStopReason: bucket.lastStopReason }),
		...(bucket.lastIdleReason === undefined ? undefined : { lastIdleReason: bucket.lastIdleReason }),
	};
}
