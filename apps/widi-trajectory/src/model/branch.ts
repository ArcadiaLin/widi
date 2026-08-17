/**
 * Branches, turns and steps.
 *
 * A session file is a tree, not a transcript: rewinding to an earlier entry and
 * continuing leaves the old path in the file. Reading only the last line would
 * therefore show a run that never happened. Every path that ends somewhere is
 * materialised here, and the one the session was left on is marked - so an
 * abandoned attempt stays visible without being mistaken for the outcome.
 *
 * `leaf` entries are excluded from the graph. They record where the leaf moved,
 * are never anyone's parent, and counting them as nodes would invent a branch
 * per rewind.
 *
 * Turn and step numbering is branch-local, which is why it lives on the branch
 * rows rather than on the records: the same entry can be the third turn of one
 * path and the first of another.
 */

import type { RawEntry } from "../load/session-file.ts";
import { statsOf } from "./stats.ts";
import type { Branch, BranchRow, TrajectoryRecord, TurnSummary } from "./types.ts";

export interface BuildBranchesOptions {
	readonly entries: readonly RawEntry[];
	readonly leafId: string | null;
	readonly records: readonly TrajectoryRecord[];
	readonly byEntryId: ReadonlyMap<string, readonly string[]>;
}

export interface BranchSet {
	readonly branches: readonly Branch[];
	readonly currentBranchId: string;
}

/** Records that open a turn: anything delivered into the model's context. */
function isInput(record: TrajectoryRecord): boolean {
	return record.kind === "user" || record.kind === "notice";
}

function pathTo(leafId: string, parentOf: ReadonlyMap<string, string | null>): string[] {
	const path: string[] = [];
	const seen = new Set<string>();
	let current: string | undefined = leafId;
	while (current !== undefined && !seen.has(current)) {
		seen.add(current);
		path.push(current);
		const parent = parentOf.get(current);
		current = parent === null || parent === undefined ? undefined : parent;
	}
	return path.reverse();
}

function formatClock(at: number): string {
	if (!Number.isFinite(at) || at <= 0) return "";
	return new Date(at).toISOString().replace("T", " ").slice(0, 19);
}

export function buildBranches(options: BuildBranchesOptions): BranchSet {
	const { entries, leafId, records, byEntryId } = options;
	const recordById = new Map(records.map((record) => [record.id, record]));
	const parentOf = new Map<string, string | null>();
	const hasChild = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "leaf") continue;
		parentOf.set(entry.id, entry.parentId);
		if (entry.parentId !== null) hasChild.add(entry.parentId);
	}

	const leafIds = new Set<string>();
	for (const id of parentOf.keys()) {
		if (!hasChild.has(id)) leafIds.add(id);
	}
	if (leafId !== null && parentOf.has(leafId)) leafIds.add(leafId);

	const branches: Branch[] = [];
	for (const id of leafIds) {
		const entryIds = pathTo(id, parentOf);
		const rows: BranchRow[] = [];
		const turns: TurnSummary[] = [];
		const branchRecords: TrajectoryRecord[] = [];
		let turn = 0;
		let step = 0;
		let previousWasInput = false;
		let turnRecords: TrajectoryRecord[] = [];
		let turnTitle = "";
		let turnSteps = 0;
		let turnFirstRecordId = "";

		const closeTurn = (): void => {
			if (turnRecords.length === 0) return;
			turns.push({
				turn,
				title: turnTitle,
				startedAt: Math.min(...turnRecords.map((record) => record.startedAt)),
				endedAt: Math.max(...turnRecords.map((record) => record.endedAt)),
				recordCount: turnRecords.length,
				stepCount: turnSteps,
				firstRecordId: turnFirstRecordId,
				stats: statsOf(turnRecords, 1),
			});
			turnRecords = [];
			turnSteps = 0;
		};

		for (const entryId of entryIds) {
			for (const recordId of byEntryId.get(entryId) ?? []) {
				const record = recordById.get(recordId);
				if (record === undefined) continue;
				const input = isInput(record);
				if (input && !previousWasInput) {
					closeTurn();
					turn++;
					step = 0;
					turnTitle = record.summary === "" ? record.title : record.summary;
					turnFirstRecordId = record.id;
				}
				if (turn === 0) {
					// Records before the first input still belong somewhere; they open
					// turn 1 rather than sitting outside the numbering.
					turn = 1;
					turnTitle = record.summary === "" ? record.title : record.summary;
					turnFirstRecordId = record.id;
				}
				if (record.kind === "assistant") {
					step++;
					turnSteps++;
				}
				previousWasInput = input;
				rows.push({ recordId, turn, step });
				branchRecords.push(record);
				turnRecords.push(record);
			}
		}
		closeTurn();

		if (rows.length === 0) continue;
		const endsAt = Math.max(...branchRecords.map((record) => record.endedAt));
		branches.push({
			id,
			label: `${rows.length} records · ends ${formatClock(endsAt)}`,
			current: id === leafId,
			rows,
			turns,
			stats: statsOf(branchRecords, turns.length),
		});
	}

	branches.sort((left, right) => {
		if (left.current !== right.current) return left.current ? -1 : 1;
		return (right.stats.lastAt ?? 0) - (left.stats.lastAt ?? 0);
	});

	return { branches, currentBranchId: branches.find((branch) => branch.current)?.id ?? branches[0]?.id ?? "" };
}
