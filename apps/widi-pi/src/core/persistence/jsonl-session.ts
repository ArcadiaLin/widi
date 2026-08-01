/**
 * WIDI's own JSONL session file.
 *
 * Ported from pi's `JsonlSessionStorage` so the evolution boundary sits here
 * rather than in vendored code. The port stays byte-compatible with the v3
 * header and entry format: an existing session must keep opening, and a session
 * WIDI writes must keep opening in pi.
 *
 * What this file owns beyond the port:
 *
 * - {@link getFullBranch}, the complete root-to-leaf path. pi's public path
 *   stops at a compaction checkpoint because that is what the model gets;
 *   persistence needs the whole branch, since a ref older than the checkpoint
 *   still applies.
 * - {@link getEntriesToFork}, which for the same reason must not hand a fork
 *   the compaction-truncated prefix - the refs above the checkpoint would be
 *   silently dropped and the new session would come back missing state.
 *
 * It knows what a persistence ref *is* only far enough to find one. What a
 * namespace's state means never enters here.
 */

import type {
	JsonlSessionMetadata,
	LeafEntry,
	SessionEntryCursorOptions,
	SessionStorage,
	SessionTreeEntry,
} from "@widi/agent-core";
import { SessionError } from "@widi/agent-core";
import type { PersistenceFileSystem } from "./custom-storage.ts";

export const SESSION_FORMAT_VERSION = 3;

export interface SessionHeader {
	readonly type: "session";
	readonly version: typeof SESSION_FORMAT_VERSION;
	readonly id: string;
	readonly timestamp: string;
	readonly cwd: string;
	readonly parentSession?: string;
	readonly metadata?: Record<string, unknown>;
}

/**
 * The complete path from the root to `leafId`, oldest first.
 *
 * Unlike pi's `getPathToRootOrCompaction` this never stops early. Cycles are a
 * corrupt file rather than a recoverable condition, so they throw.
 */
export function getFullBranch(
	entries: readonly SessionTreeEntry[],
	leafId: string | null,
): SessionTreeEntry[] {
	if (leafId === null) return [];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionTreeEntry[] = [];
	const visited = new Set<string>();
	let current = byId.get(leafId);
	if (!current) {
		throw new SessionError("not_found", `Entry ${leafId} not found`);
	}
	while (current) {
		if (visited.has(current.id)) {
			throw new SessionError(
				"invalid_session",
				`Session has a cycle at entry ${current.id}`,
			);
		}
		visited.add(current.id);
		branch.unshift(current);
		if (!current.parentId) break;
		const parent = byId.get(current.parentId);
		if (!parent) {
			throw new SessionError(
				"invalid_session",
				`Entry ${current.parentId} not found`,
			);
		}
		current = parent;
	}
	return branch;
}

/**
 * The entries a fork copies.
 *
 * Without a target this is the whole tree, every branch included. With one it
 * is the full branch ending at the effective leaf - full, not
 * compaction-truncated, which is the one behavioural difference from pi's
 * helper and the reason this is not simply re-exported.
 */
export function getEntriesToFork(
	entries: readonly SessionTreeEntry[],
	options: { readonly entryId?: string; readonly position?: "before" | "at" },
): SessionTreeEntry[] {
	if (!options.entryId) return [...entries];
	const target = entries.find((entry) => entry.id === options.entryId);
	if (!target) {
		throw new SessionError(
			"invalid_fork_target",
			`Entry ${options.entryId} not found`,
		);
	}
	if ((options.position ?? "before") === "at") {
		return getFullBranch(entries, target.id);
	}
	if (target.type !== "message" || target.message.role !== "user") {
		throw new SessionError(
			"invalid_fork_target",
			`Entry ${options.entryId} is not a user message`,
		);
	}
	return getFullBranch(entries, target.parentId);
}

/**
 * One session's history file.
 *
 * TODO(stage-1): port pi's `JsonlSessionStorage` body verbatim - header and
 * entry parsing with their exact error codes, the label cache, the id
 * generator, `getPathToRootOrCompaction`, and the stats reduction. The shape
 * below is the surface the repository builds on; nothing above it should need
 * to change when the body lands.
 */
export class JsonlSession implements SessionStorage<JsonlSessionMetadata> {
	private readonly _fs: PersistenceFileSystem;
	private readonly _filePath: string;

	private constructor(fs: PersistenceFileSystem, filePath: string) {
		this._fs = fs;
		this._filePath = filePath;
	}

	static async open(
		_fs: PersistenceFileSystem,
		_filePath: string,
	): Promise<JsonlSession> {
		throw new Error("TODO(stage-1): port JsonlSessionStorage.open");
	}

	static async create(
		_fs: PersistenceFileSystem,
		_filePath: string,
		_options: {
			readonly cwd: string;
			readonly sessionId: string;
			readonly parentSessionPath?: string;
			readonly metadata?: Record<string, unknown>;
		},
	): Promise<JsonlSession> {
		throw new Error("TODO(stage-1): port JsonlSessionStorage.create");
	}

	/** Header-only read, for listing without parsing whole files. */
	static async loadMetadata(
		_fs: PersistenceFileSystem,
		_filePath: string,
	): Promise<JsonlSessionMetadata> {
		throw new Error("TODO(stage-1): port loadJsonlSessionMetadata");
	}

	get filePath(): string {
		return this._filePath;
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		throw new Error("TODO(stage-1)");
	}

	async getLeafId(): Promise<string | null> {
		throw new Error("TODO(stage-1)");
	}

	async setLeafId(_leafId: string | null): Promise<LeafEntry> {
		throw new Error("TODO(stage-1)");
	}

	async createEntryId(): Promise<string> {
		throw new Error("TODO(stage-1)");
	}

	async appendEntry(_entry: SessionTreeEntry): Promise<void> {
		throw new Error("TODO(stage-1)");
	}

	async getEntry(_id: string): Promise<SessionTreeEntry | undefined> {
		throw new Error("TODO(stage-1)");
	}

	async findEntries<TType extends SessionTreeEntry["type"]>(
		_type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		throw new Error("TODO(stage-1)");
	}

	async getLabel(_id: string): Promise<string | undefined> {
		throw new Error("TODO(stage-1)");
	}

	async getSessionName(): Promise<string | undefined> {
		throw new Error("TODO(stage-1)");
	}

	async getSessionStats(): Promise<never> {
		throw new Error("TODO(stage-1)");
	}

	async getPathToRootOrCompaction(
		_leafId: string | null,
	): Promise<SessionTreeEntry[]> {
		throw new Error("TODO(stage-1)");
	}

	async getEntries(
		_options?: SessionEntryCursorOptions,
	): Promise<SessionTreeEntry[]> {
		throw new Error("TODO(stage-1)");
	}

	/** The full branch ending at the current leaf. */
	async getFullBranch(): Promise<SessionTreeEntry[]> {
		return getFullBranch(await this.getEntries(), await this.getLeafId());
	}
}
