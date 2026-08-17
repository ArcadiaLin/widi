/**
 * The contract between the generator and the viewer.
 *
 * One JSON value is embedded into the generated page and the browser code reads
 * nothing else. Keeping the shape here - free of Node and of DOM - is what lets
 * both sides be type checked against the same declaration while they compile
 * under different lib settings.
 *
 * Two rules shape it:
 *
 * 1. Records are branch independent. A session file is a tree, and the same
 *    entry can sit on several branches; duplicating its content per branch
 *    would multiply the largest part of the payload. A branch is therefore an
 *    ordered list of record ids plus the numbering that is genuinely
 *    branch-local (turn and step).
 * 2. A cross-agent link names an agent by {@link AgentTrajectory.key}, resolved
 *    while loading. The viewer never has to know how sessions sit on disk, and
 *    a link to an agent that was never persisted degrades to a label instead of
 *    a dead reference.
 */

export const TRAJECTORY_BUNDLE_VERSION = 1;

export interface TrajectoryBundle {
	readonly version: number;
	readonly generatedAt: string;
	readonly source: TrajectorySource;
	/** Preorder: every agent is followed by its subtree. */
	readonly agents: readonly AgentTrajectory[];
	readonly diagnostics: readonly LoadDiagnostic[];
}

export interface TrajectorySource {
	/** Absolute path of the root session directory that was read. */
	readonly rootPath: string;
	/** Project directory the root session ran against. */
	readonly cwd: string;
}

export interface LoadDiagnostic {
	readonly severity: "warning" | "error";
	readonly code: string;
	readonly message: string;
	readonly agentKey?: string;
}

export interface AgentTrajectory {
	/** Session key: root directory name plus one directory name per generation. */
	readonly key: string;
	readonly agentId: string;
	readonly parentKey: string | null;
	readonly depth: number;
	readonly cwd: string;
	readonly createdAt: number;
	/** Session name set through the runtime, when one was set. */
	readonly name?: string;
	readonly profile?: AgentProfileRef;
	readonly origin?: SessionOriginRef;
	readonly records: readonly TrajectoryRecord[];
	readonly branches: readonly Branch[];
	/** Branch the session was left on. */
	readonly currentBranchId: string;
	readonly stats: TrajectoryStats;
}

export interface AgentProfileRef {
	readonly id: string;
	readonly label?: string;
}

export interface SessionOriginRef {
	readonly spawnedBy?: string;
	readonly forkedFrom?: string;
	readonly forkEntryId?: string;
}

export interface Branch {
	/** Entry id of the branch leaf; stable across regenerations. */
	readonly id: string;
	readonly label: string;
	readonly current: boolean;
	readonly rows: readonly BranchRow[];
	readonly turns: readonly TurnSummary[];
	readonly stats: TrajectoryStats;
}

export interface BranchRow {
	readonly recordId: string;
	/** 1-based turn number inside this branch. */
	readonly turn: number;
	/** 1-based model request number inside the turn; 0 before the first one. */
	readonly step: number;
}

export interface TurnSummary {
	readonly turn: number;
	readonly title: string;
	readonly startedAt: number;
	readonly endedAt: number;
	readonly recordCount: number;
	readonly stepCount: number;
	readonly firstRecordId: string;
	readonly stats: TrajectoryStats;
}

/**
 * Thinking is its own kind rather than a block inside the assistant record.
 * Reasoning and the reply are different acts - one is the model working, the
 * other is what it chose to say - and folding them into one line means the
 * ledger shows whichever came first and hides the other.
 */
export type RecordKind = "user" | "assistant" | "thinking" | "tool" | "notice" | "compaction" | "meta";

export interface TrajectoryRecord {
	/** Entry id, or `<entryId>#<toolCallId>` for a tool record. */
	readonly id: string;
	readonly entryId: string;
	readonly kind: RecordKind;
	/** Short kind-specific name: a role, a tool name, an entry type. */
	readonly title: string;
	/** Single-line preview shown in the ledger. */
	readonly summary: string;
	readonly startedAt: number;
	readonly endedAt: number;
	readonly isError?: boolean;
	readonly label?: string;
	readonly usage?: UsageSummary;
	readonly model?: ModelRef;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	/** Input side: user content, assistant text and thinking, compaction summary. */
	readonly blocks?: readonly ContentBlock[];
	/** Output side: a tool result, or the text a message was delivered as. */
	readonly output?: readonly ContentBlock[];
	/** Pretty-printed structured payload the runtime attached to the entry. */
	readonly details?: string;
	readonly toolCall?: ToolCallRef;
	readonly link?: RecordLink;
	readonly source?: MessageSourceRef;
	/** Free-form facts a record kind carries beyond the common shape. */
	readonly facts?: readonly RecordFact[];
}

export interface RecordFact {
	readonly name: string;
	readonly value: string;
}

export interface ToolCallRef {
	readonly id: string;
	readonly name: string;
	/** Pretty-printed call arguments. */
	readonly argumentsJson: string;
	/** False when the call has no recorded result on any branch. */
	readonly settled: boolean;
}

export interface ModelRef {
	readonly provider: string;
	readonly model: string;
	readonly api?: string;
}

export interface MessageSourceRef {
	readonly kind: string;
	readonly label?: string;
}

export type ContentBlock =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "thinking"; readonly text: string }
	| { readonly type: "json"; readonly text: string }
	| { readonly type: "image"; readonly mimeType: string; readonly data?: string; readonly note?: string };

export type LinkKind = "spawn" | "message" | "dispose" | "watch" | "notice";

/**
 * Which way the thing the link describes travelled, relative to the agent whose
 * record carries it. A spawn reaches out; a delivered message arrived. Without
 * this a reverse index reads every link backwards - the record where a child was
 * handed its task names the parent, and would otherwise look like the child
 * messaging the parent.
 */
export type LinkDirection = "out" | "in";

export interface RecordLink {
	readonly kind: LinkKind;
	readonly direction: LinkDirection;
	readonly targets: readonly LinkTarget[];
	/** Notice only: the runtime status that produced it. */
	readonly status?: string;
	readonly reason?: string;
}

export interface LinkTarget {
	readonly agentId: string;
	/** Resolved session key, or null when that agent left no session on disk. */
	readonly agentKey: string | null;
	readonly note?: string;
}

export interface UsageSummary {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning?: number;
	readonly total: number;
	readonly cost: number;
}

export interface TrajectoryStats {
	readonly records: number;
	readonly turns: number;
	readonly requests: number;
	readonly toolCalls: number;
	readonly errors: number;
	readonly tokens: UsageSummary;
	/** Wall time from the first record start to the last record end. */
	readonly spanMs: number;
	/** Summed record durations; below `spanMs` by the time nothing ran. */
	readonly busyMs: number;
	readonly firstAt: number | null;
	readonly lastAt: number | null;
}

export function emptyUsage(): UsageSummary {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

export function emptyStats(): TrajectoryStats {
	return {
		records: 0,
		turns: 0,
		requests: 0,
		toolCalls: 0,
		errors: 0,
		tokens: emptyUsage(),
		spanMs: 0,
		busyMs: 0,
		firstAt: null,
		lastAt: null,
	};
}
