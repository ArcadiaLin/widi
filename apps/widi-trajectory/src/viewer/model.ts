/**
 * Derived indexes over the bundle.
 *
 * The bundle stores each link where it was written - on the record of the agent
 * that reached out. Reading a delegation is symmetric though: standing on the
 * child you want to know which turn of the parent created you, and which turn of
 * the parent your report woke. That reverse index is built here once, because it
 * is a join over every agent and no pane can compute it alone.
 *
 * Anchoring is the other half. A link names an agent, not a moment, and jumping
 * to the top of a thousand-record child is not navigation. The moment is
 * recoverable from the clock: a spawn points at the child's first record, a
 * report at the last record the child finished before the parent was told.
 */

import type {
	AgentTrajectory,
	Branch,
	LinkDirection,
	LinkKind,
	TrajectoryBundle,
	TrajectoryRecord,
} from "../model/types.ts";

export interface IncomingRef {
	readonly fromAgentKey: string;
	readonly fromAgentId: string;
	readonly recordId: string;
	readonly kind: LinkKind;
	readonly direction: LinkDirection;
	readonly at: number;
	readonly status?: string;
}

export interface ViewerIndex {
	readonly bundle: TrajectoryBundle;
	readonly agents: readonly AgentTrajectory[];
	readonly agentByKey: ReadonlyMap<string, AgentTrajectory>;
	readonly childrenOf: ReadonlyMap<string, readonly AgentTrajectory[]>;
	readonly roots: readonly AgentTrajectory[];
	readonly recordsByAgent: ReadonlyMap<string, ReadonlyMap<string, TrajectoryRecord>>;
	readonly incoming: ReadonlyMap<string, readonly IncomingRef[]>;
	readonly timeStart: number;
	readonly timeEnd: number;
}

export function buildIndex(bundle: TrajectoryBundle): ViewerIndex {
	const agentByKey = new Map<string, AgentTrajectory>();
	const childrenOf = new Map<string, AgentTrajectory[]>();
	const roots: AgentTrajectory[] = [];
	const recordsByAgent = new Map<string, Map<string, TrajectoryRecord>>();
	const incoming = new Map<string, IncomingRef[]>();
	let timeStart = Number.POSITIVE_INFINITY;
	let timeEnd = Number.NEGATIVE_INFINITY;

	for (const agent of bundle.agents) {
		agentByKey.set(agent.key, agent);
		recordsByAgent.set(agent.key, new Map(agent.records.map((record) => [record.id, record])));
	}
	for (const agent of bundle.agents) {
		if (agent.parentKey === null || !agentByKey.has(agent.parentKey)) {
			roots.push(agent);
			continue;
		}
		const siblings = childrenOf.get(agent.parentKey) ?? [];
		siblings.push(agent);
		childrenOf.set(agent.parentKey, siblings);
	}

	for (const agent of bundle.agents) {
		for (const record of agent.records) {
			if (record.startedAt > 0) timeStart = Math.min(timeStart, record.startedAt);
			if (record.endedAt > 0) timeEnd = Math.max(timeEnd, record.endedAt);
			const link = record.link;
			if (link === undefined) continue;
			// An arriving message is the other half of the sender's own tool call,
			// which is already indexed; indexing it again would show the receiver as
			// having reached out.
			if (link.direction === "in" && link.kind === "message") continue;
			for (const target of link.targets) {
				if (target.agentKey === null || target.agentKey === agent.key) continue;
				const refs = incoming.get(target.agentKey) ?? [];
				refs.push({
					fromAgentKey: agent.key,
					fromAgentId: agent.agentId,
					recordId: record.id,
					kind: link.kind,
					direction: link.direction,
					at: record.startedAt,
					...(link.status === undefined ? undefined : { status: link.status }),
				});
				incoming.set(target.agentKey, refs);
			}
		}
	}
	for (const refs of incoming.values()) refs.sort((left, right) => left.at - right.at);

	return {
		bundle,
		agents: bundle.agents,
		agentByKey,
		childrenOf,
		roots,
		recordsByAgent,
		incoming,
		timeStart: Number.isFinite(timeStart) ? timeStart : 0,
		timeEnd: Number.isFinite(timeEnd) ? timeEnd : 0,
	};
}

export function branchOf(agent: AgentTrajectory, branchId: string): Branch | undefined {
	return agent.branches.find((branch) => branch.id === branchId) ?? agent.branches[0];
}

/** Records of one branch, in branch order, with their turn and step numbers. */
export interface BranchEntry {
	readonly record: TrajectoryRecord;
	readonly turn: number;
	readonly step: number;
	readonly index: number;
}

export function branchEntries(index: ViewerIndex, agent: AgentTrajectory, branch: Branch): BranchEntry[] {
	const records = index.recordsByAgent.get(agent.key);
	if (records === undefined) return [];
	const entries: BranchEntry[] = [];
	for (const row of branch.rows) {
		const record = records.get(row.recordId);
		if (record === undefined) continue;
		entries.push({ record, turn: row.turn, step: row.step, index: entries.length + 1 });
	}
	return entries;
}

/**
 * The record in `agent` a link of this kind, taken at this moment, points at.
 *
 * A link that reached out points forward: the first thing the target did once it
 * had been reached. A link that describes something arriving points backward,
 * and so does a disposal: the last thing the target finished before the moment
 * this record recorded.
 */
export function anchorRecordId(
	index: ViewerIndex,
	agentKey: string,
	kind: LinkKind,
	direction: LinkDirection,
	at: number,
): string | undefined {
	const agent = index.agentByKey.get(agentKey);
	if (agent === undefined) return undefined;
	const branch = branchOf(agent, agent.currentBranchId);
	if (branch === undefined) return undefined;
	const entries = branchEntries(index, agent, branch);
	if (entries.length === 0) return undefined;
	const backward = direction === "in" || kind === "dispose";
	if (backward) {
		let best: BranchEntry | undefined;
		for (const entry of entries) {
			if (entry.record.endedAt <= at) best = entry;
		}
		return (best ?? entries[entries.length - 1]).record.id;
	}
	for (const entry of entries) {
		if (entry.record.startedAt >= at) return entry.record.id;
	}
	return entries[0].record.id;
}

export function agentLabel(agent: AgentTrajectory): string {
	return agent.name ?? agent.agentId;
}
