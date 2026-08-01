/**
 * The session directory repository: one entry point for a session's history,
 * its custom storage, and the sessions it owns.
 *
 * It replaces `SessionDirectoryRepo`'s directory-level job and adds the two
 * things that job was missing - the custom storages registered against a
 * session, and the child sessions nested inside it. Nothing here interprets a
 * namespace: the repository executes what a registered namespace declares, and
 * the only thing it knows about `core:subagent` is that a state root can name
 * other sessions.
 *
 * One asymmetry runs through this file. The repository *reads* the session tree
 * and *writes* custom storage, but it never writes to a live session branch:
 * that belongs to `AgentHarness`, which serializes writes and buffers them
 * during a turn. So committing state is two steps by construction -
 * {@link JsonlPersistenceRepo.stageState} writes the object and hands back ref
 * data, and the caller appends that ref through the harness. Object first is
 * also the safe order: a crash between the two leaves a collectable orphan
 * instead of a ref pointing at nothing.
 */

import type { JsonlSessionMetadata, SessionTreeEntry } from "@widi/agent-core";
import type {
	CustomStorage,
	PersistenceFileSystem,
	PersistenceRegistry,
} from "./custom-storage.ts";
import type { JsonlSession } from "./jsonl-session.ts";
import { JsonlObjectStore } from "./object-store.ts";
import type {
	PersistenceDiagnostic,
	PersistenceDiagnostics,
} from "./utils/diagnostics.ts";
import type { ForkPlan } from "./utils/fork-closure.ts";
import {
	canNestUnder,
	childSessionKey,
	createSessionDirName,
	encodeCwd,
	namespaceDirSegments,
	namespaceObjectsSegments,
	type SessionAddress,
	type SessionKey,
	sessionDirSegments,
	sessionFileSegments,
} from "./utils/layout.ts";
import type { PersistenceRefData } from "./utils/persistence-ref.ts";
import { createPersistenceRefData } from "./utils/persistence-ref.ts";
import type {
	BranchProjection,
	StateProvenance,
} from "./utils/state-projection.ts";

/** An open session and the address that identifies its directory. */
export interface PersistedSession {
	readonly address: SessionAddress;
	readonly metadata: JsonlSessionMetadata;
	readonly session: JsonlSession;
}

/** Header facts plus the address, for listing without opening. */
export interface PersistedSessionInfo {
	readonly address: SessionAddress;
	readonly metadata: JsonlSessionMetadata;
}

export interface CreateSessionOptions {
	readonly cwd: string;
	readonly sessionId: string;
	/**
	 * The session spawning this one. Omitted for a top-level session, which is
	 * exactly the set `/resume` lists.
	 */
	readonly parent?: SessionKey;
	readonly metadata?: Record<string, unknown>;
}

export interface ForkSessionOptions {
	readonly sessionId: string;
	readonly entryId?: string;
	readonly position?: "before" | "at";
	/**
	 * Where the fork lands. A fork of a child defaults to a top-level session:
	 * it is a new line of work, not a new member of the source's tree.
	 */
	readonly parent?: SessionKey;
}

export interface ResolvedNamespaceState {
	readonly namespace: string;
	readonly stateRoot: string;
	readonly state: unknown;
	/**
	 * Where this came from, which the caller needs and cannot work out.
	 *
	 * Persistence reports it and stops; deciding what a `forked` or `degraded`
	 * state means for a relaunch is the caller's, per "What persistence does not
	 * decide" in `custom-storage.ts`.
	 */
	readonly provenance: StateProvenance;
}

export interface ResolvedPersistence {
	readonly projection: BranchProjection;
	/** Resolved state per namespace; a namespace missing here did not resolve. */
	readonly states: ReadonlyMap<string, ResolvedNamespaceState>;
	readonly diagnostics: readonly PersistenceDiagnostic[];
}

export class JsonlPersistenceRepo {
	private readonly _fs: PersistenceFileSystem;
	private readonly _rootInput: string;
	private readonly _registry: PersistenceRegistry;
	private _root: string | undefined;

	constructor(options: {
		readonly fs: PersistenceFileSystem;
		/** Persistence root, e.g. `.widi/runs`. */
		readonly root: string;
		readonly registry: PersistenceRegistry;
	}) {
		this._fs = options.fs;
		this._rootInput = options.root;
		this._registry = options.registry;
	}

	// ---------------------------------------------------------------------
	// Sessions
	// ---------------------------------------------------------------------

	/**
	 * Create a session, nested under its parent when it has one.
	 *
	 * A parent that is itself unpersisted has no directory to nest under, and
	 * the caller is expected not to ask: persistence follows the directory, so
	 * the child of an ephemeral agent is ephemeral too. A parent too deep to
	 * nest under degrades to a top-level session with a diagnostic rather than
	 * producing a path that cannot be opened.
	 */
	async create(_options: CreateSessionOptions): Promise<PersistedSession> {
		throw new Error("TODO(stage-1): create session directory and history");
	}

	async open(_address: SessionAddress): Promise<PersistedSession> {
		throw new Error("TODO(stage-1): open session history");
	}

	/**
	 * Top-level sessions of one project, newest first.
	 *
	 * Only top-level: a child is part of its root's tree and is restored through
	 * it, so listing them alongside their roots would offer the user a session
	 * that opens the same conversation twice.
	 */
	async list(_options: {
		readonly cwd: string;
	}): Promise<PersistedSessionInfo[]> {
		throw new Error("TODO(stage-1): enumerate top-level session directories");
	}

	/** The sessions nested directly under one session. */
	async listChildren(
		_address: SessionAddress,
	): Promise<PersistedSessionInfo[]> {
		throw new Error("TODO(stage-1): enumerate the agents/ container");
	}

	/**
	 * Delete a session, its custom storage, and every session it owns.
	 *
	 * The subtree goes with it by construction, which is the point of nesting:
	 * the old layout left a deleted root's children on disk forever, reachable
	 * by nothing.
	 */
	async delete(address: SessionAddress): Promise<void> {
		const dirPath = await this._sessionDirPath(address);
		const removed = await this._fs.remove(dirPath, {
			recursive: true,
			force: true,
		});
		if (!removed.ok) {
			throw new Error(
				`Failed to delete session ${dirPath}: ${removed.error.message}`,
			);
		}
	}

	// ---------------------------------------------------------------------
	// Recovery
	// ---------------------------------------------------------------------

	/**
	 * The state every namespace has at a session's current leaf.
	 *
	 * Reads the complete branch, not the compaction-truncated one, and degrades
	 * per namespace: an unresolvable state leaves that namespace out and a
	 * diagnostic in. The conversation stays readable no matter what is broken
	 * below it - that is the invariant the whole layer exists to keep.
	 */
	async resolveState(_address: SessionAddress): Promise<ResolvedPersistence> {
		throw new Error("TODO(stage-4): project the branch and resolve each root");
	}

	// ---------------------------------------------------------------------
	// Writing state
	// ---------------------------------------------------------------------

	/**
	 * Commit an object and return the ref that names it.
	 *
	 * The caller appends the returned data through `AgentHarness`; the
	 * repository deliberately cannot. During a turn that append is buffered and
	 * reports no entry id, so a design where the ref goes first and the object
	 * follows could never work - and an object written first is content
	 * addressed, so the worst a crash leaves behind is an unreferenced line.
	 */
	async stageState(options: {
		readonly address: SessionAddress;
		readonly namespace: string;
		readonly data: unknown;
		readonly dependencies?: readonly string[];
		readonly anchorEntryId?: string;
	}): Promise<PersistenceRefData> {
		const storage = await this.openStorage(options.address, options.namespace);
		if (!storage) {
			throw new Error(
				`Persistence namespace ${options.namespace} is not registered.`,
			);
		}
		const stateRoot = await storage.putObject({
			data: options.data,
			dependencies: options.dependencies,
		});
		return createPersistenceRefData({
			namespace: options.namespace,
			stateRoot,
			anchorEntryId: options.anchorEntryId,
		});
	}

	/** Ref data that clears a namespace from here down the branch. */
	clearState(namespace: string, anchorEntryId?: string): PersistenceRefData {
		return createPersistenceRefData({
			namespace,
			stateRoot: null,
			anchorEntryId,
		});
	}

	/**
	 * Open one namespace's storage for a session.
	 *
	 * Returns undefined when nothing is registered for the namespace. That is
	 * how an older build reads a session written by a newer one, and equally how
	 * a session survives an extension being uninstalled: the ref stays on the
	 * branch and the directory stays on disk, both untouched, so reinstalling
	 * restores the state. Nothing here ever deletes on the strength of an empty
	 * registry - a failed extension load looks exactly the same from in here.
	 *
	 * A namespace that brings its own storage gets its directory and decides the
	 * rest; {@link JsonlObjectStore} is only the default.
	 */
	async openStorage(
		address: SessionAddress,
		namespace: string,
		diagnostics?: PersistenceDiagnostics,
	): Promise<CustomStorage | undefined> {
		const definition = this._registry.get(namespace);
		if (!definition) return undefined;
		const dirPath = await this._join(
			await this._cwdDirPath(address.cwd),
			namespaceDirSegments(address.key, namespace),
		);
		return await definition.openStorage({
			fs: this._fs,
			dirPath,
			sessionKey: address.key,
			diagnostics,
			owner: definition.owner,
		});
	}

	/** The default storage a namespace gets when it does not bring its own. */
	async openDefaultStorage(options: {
		readonly address: SessionAddress;
		readonly namespace: string;
		readonly formatVersion: number;
		readonly diagnostics?: PersistenceDiagnostics;
		readonly owner?: string;
	}): Promise<JsonlObjectStore> {
		const cwdDir = await this._cwdDirPath(options.address.cwd);
		return await JsonlObjectStore.open({
			fs: this._fs,
			dirPath: await this._join(
				cwdDir,
				namespaceDirSegments(options.address.key, options.namespace),
			),
			filePath: await this._join(
				cwdDir,
				namespaceObjectsSegments(options.address.key, options.namespace),
			),
			namespace: options.namespace,
			formatVersion: options.formatVersion,
			sessionKey: options.address.key,
			diagnostics: options.diagnostics,
			owner: options.owner,
		});
	}

	// ---------------------------------------------------------------------
	// Fork
	// ---------------------------------------------------------------------

	/**
	 * Fork a session at a point on its tree, carrying everything that point can
	 * see.
	 *
	 * Order matters and is not an implementation detail:
	 *
	 * 1. copy the conversation entries;
	 * 2. project the *source's* full branch to per-namespace state roots - not
	 *    the copied entries, whose prefix may have been truncated at a
	 *    compaction and would silently drop older refs;
	 * 3. plan the closure, objects and child sessions alike;
	 * 4. copy objects, recursively fork the child sessions the plan named, and
	 *    apply each namespace's policy;
	 * 5. append one fresh ref per surviving namespace to the new session, since
	 *    the source's ref entries may not be among the copied ones. Each carries
	 *    an `origin`, so the new session can tell state it inherited from state
	 *    it later wrote itself.
	 *
	 * Afterwards the new session reads nothing from the source directory, which
	 * is the property the whole design is checked against.
	 */
	async fork(
		_source: SessionAddress,
		_options: ForkSessionOptions,
	): Promise<{
		readonly session: PersistedSession;
		readonly plan: ForkPlan;
		readonly diagnostics: PersistenceDiagnostics;
	}> {
		throw new Error("TODO(stage-5): copy entries, closure, and child subtrees");
	}

	// ---------------------------------------------------------------------
	// Low-level session tree access
	//
	// Reads only. Writes to a live branch go through AgentHarness; these exist
	// for fork, hydration and offline inspection of a session nobody has open.
	// ---------------------------------------------------------------------

	async getEntries(_address: SessionAddress): Promise<SessionTreeEntry[]> {
		throw new Error("TODO(stage-1)");
	}

	async getFullBranch(_address: SessionAddress): Promise<SessionTreeEntry[]> {
		throw new Error("TODO(stage-1)");
	}

	// ---------------------------------------------------------------------
	// Paths
	// ---------------------------------------------------------------------

	/** Where a new child of `parent` would live, or undefined if too deep. */
	nextChildKey(
		parent: SessionKey,
		sessionId: string,
		timestamp: string,
	): SessionKey | undefined {
		if (!canNestUnder(parent)) return undefined;
		return childSessionKey(parent, createSessionDirName(sessionId, timestamp));
	}

	async sessionFilePath(address: SessionAddress): Promise<string> {
		return await this._join(
			await this._cwdDirPath(address.cwd),
			sessionFileSegments(address.key),
		);
	}

	private async _sessionDirPath(address: SessionAddress): Promise<string> {
		return await this._join(
			await this._cwdDirPath(address.cwd),
			sessionDirSegments(address.key),
		);
	}

	private async _cwdDirPath(cwd: string): Promise<string> {
		return await this._join(await this._rootPath(), [encodeCwd(cwd)]);
	}

	private async _rootPath(): Promise<string> {
		if (this._root === undefined) {
			const resolved = await this._fs.joinPath([this._rootInput]);
			if (!resolved.ok) {
				throw new Error(
					`Failed to resolve persistence root ${this._rootInput}: ${resolved.error.message}`,
				);
			}
			this._root = resolved.value;
		}
		return this._root;
	}

	private async _join(base: string, segments: string[]): Promise<string> {
		const joined = await this._fs.joinPath([base, ...segments]);
		if (!joined.ok) {
			throw new Error(
				`Failed to resolve ${segments.join("/")} under ${base}: ${joined.error.message}`,
			);
		}
		return joined.value;
	}
}
