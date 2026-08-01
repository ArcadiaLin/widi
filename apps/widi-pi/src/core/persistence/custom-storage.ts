/**
 * The contract every kind of persisted state implements to join the framework.
 *
 * The framework promises a namespace exactly three things: a directory of its
 * own inside the session, a way to be named from a conversation branch, and a
 * recursive copy when that branch is forked. In exchange a namespace has to
 * answer four questions - what does this state root mean, what does it depend
 * on, what happens to it on a fork, and how do I read an older version of it.
 *
 * Nothing else is prescribed. A namespace may keep append-only objects, a tree,
 * a single snapshot, or something with no analogue here at all; the session
 * layer's own nesting rules in `layout.ts` are for `jsonl-session.ts` and do not
 * reach inside a namespace directory. The only hard requirement is that a state
 * root is *immutable*: the branch names it, and a branch that is no longer
 * current must still resolve to what it named.
 *
 * The repository drives every walk. A namespace declares its dependencies and
 * never recurses into another namespace itself, so cycle detection and
 * deduplication have exactly one implementation.
 *
 * ## What persistence does not decide
 *
 * Restoring a session has three parts, and only the first two are here.
 * *Projection* - which state root is in force at a branch point - belongs to
 * the framework and admits no per-namespace override, or rewinding would mean
 * something different depending on what a session happens to persist.
 * *Resolution* - what that root's bytes are - belongs to the namespace.
 * *Activation* - what to do with the result, whether to relaunch an agent, to
 * reattach to a process, to warn - belongs to the caller, and there is
 * deliberately no hook for it.
 *
 * The reason is that activation depends on things this layer cannot see: is the
 * process still alive, does the current config still permit this extension, is
 * the user resuming or continuing or running a fork for the first time. A hook
 * here would force every namespace to guess at them, and guess wrong invisibly.
 * What the layer owes the caller instead is the facts it alone has, which is
 * why a resolved state carries its `StateProvenance`.
 *
 * The same line separates a namespace nothing is registered for. This layer
 * cannot tell an uninstalled extension from one that failed to load, one the
 * user disabled, or one this build never implemented - it sees only an empty
 * slot in the registry. So it does the single safe thing for all four: it
 * leaves the ref and the directory alone and reports. Reclaiming that disk is a
 * caller's decision, and it must never be driven by registry state; a load
 * failure would then destroy the state of a working extension.
 */

import type { FileSystem } from "@widi/agent-core";
import type { PersistenceDiagnostics } from "./utils/diagnostics.ts";
import type { SessionKey } from "./utils/layout.ts";
import type {
	PersistenceRefData,
	PersistenceRefOrigin,
} from "./utils/persistence-ref.ts";

export type PersistenceFileSystem = Pick<
	FileSystem,
	| "absolutePath"
	| "joinPath"
	| "readTextFile"
	| "readTextLines"
	| "writeFile"
	| "appendFile"
	| "listDir"
	| "exists"
	| "createDir"
	| "remove"
>;

/**
 * What a fork does with a namespace.
 *
 * `copy` is for state that is just data. `omit` is for state that is a handle
 * on something outside the session - a pid, a socket, a credential - which a
 * copy would misrepresent as still valid. `degrade` is for state that is both:
 * a job's history is worth carrying, its live process is not.
 */
export type PersistenceForkPolicy = "copy" | "omit" | "degrade";

export interface NamespaceStorageContext {
	readonly fs: PersistenceFileSystem;
	/** Absolute directory this namespace owns, created on first write. */
	readonly dirPath: string;
	/** The session owning that directory, for diagnostics and session deps. */
	readonly sessionKey: SessionKey;
	/** Where a damaged or unreadable log is reported, when the caller cares. */
	readonly diagnostics?: PersistenceDiagnostics;
	/** {@link PersistenceNamespaceDefinition.owner}, passed through. */
	readonly owner?: string;
}

/** One namespace's storage, opened against one session directory. */
export interface CustomStorage {
	/**
	 * The state a branch takes on when it names this root.
	 *
	 * Returns undefined when the root is not present, which is a dangling ref:
	 * reported, not thrown.
	 */
	resolveState(stateRoot: string): Promise<unknown | undefined>;

	/** State roots this root needs, within this same namespace and session. */
	listDependencies(stateRoot: string): Promise<readonly string[]>;

	/**
	 * The format version the state on disk was written with, when this storage
	 * tracks one. Below the definition's version it triggers
	 * {@link PersistenceNamespaceDefinition.migrate}; omitted means never.
	 */
	readonly storedFormatVersion?: number;

	/**
	 * Other sessions this root needs, when the state names them.
	 *
	 * This is how the spawn tree gets forked without the repository knowing what
	 * a spawn tree is: `core:subagent` answers with the child sessions its
	 * membership set contains, and the repository copies those subtrees. A
	 * namespace with no such state omits the method.
	 */
	listSessionDependencies?(stateRoot: string): Promise<readonly SessionKey[]>;

	/**
	 * Copy the closure of `roots` into another storage of the same namespace.
	 *
	 * Called after the repository has resolved the closure, so an implementation
	 * copies what it is given and does not walk again. Copying an object that is
	 * already there must be a no-op - several refs naming one root is the normal
	 * case, not an error.
	 */
	copyReachable(target: CustomStorage, roots: readonly string[]): Promise<void>;

	/** Write an object, returning its state root. Idempotent by content. */
	putObject(options: {
		readonly data: unknown;
		readonly dependencies?: readonly string[];
	}): Promise<string>;

	/** Release handles. Never throws; the session may be going away regardless. */
	close?(): Promise<void>;
}

export interface NamespaceForkRequest {
	readonly source: CustomStorage;
	readonly target: CustomStorage;
	/** Roots visible on the forked branch, already deduplicated. */
	readonly roots: readonly string[];
	readonly diagnostics: PersistenceDiagnostics;
}

export interface NamespaceForkResult {
	/**
	 * The state root the new session's ref should name.
	 *
	 * Usually the same root, because the objects were copied verbatim. A
	 * `degrade` policy returns a *new* root describing what survived, and `null`
	 * means the new branch carries no ref for this namespace at all.
	 */
	readonly stateRoot: string | null;

	/**
	 * What the new session's ref records about where this came from. Defaults to
	 * the fork policy, so only a namespace that degraded under a `copy` policy
	 * has to say so.
	 */
	readonly origin?: PersistenceRefOrigin;
}

export interface PersistenceNamespaceDefinition {
	/** Stable and globally unique, e.g. `core:subagent`. */
	readonly namespace: string;

	/** Format version of this namespace's objects, written into its log. */
	readonly version: number;

	/**
	 * Who is entitled to this namespace's directory, e.g. an extension id.
	 * Omitted by namespaces this build ships itself.
	 *
	 * A namespace name is globally unique but not reserved: an extension can be
	 * uninstalled and a different one claim the same name, and it would then
	 * read the first one's objects and interpret them against its own schema.
	 * The owner is written into the log header and checked on open, which turns
	 * that into a refusal instead of a silent misreading.
	 *
	 * It must be a *stable* identity with no version in it. An extension upgrade
	 * bumps {@link version} and keeps its own state; changing the owner would
	 * lock the upgraded build out of everything the old one wrote.
	 */
	readonly owner?: string;

	readonly forkPolicy: PersistenceForkPolicy;

	/**
	 * Whether a ref is well-formed *for this namespace*, past the generic checks
	 * `parsePersistenceRef` already made.
	 */
	validateRef?(data: PersistenceRefData): string | undefined;

	openStorage(context: NamespaceStorageContext): Promise<CustomStorage>;

	/**
	 * Perform the copy for this namespace once the repository has determined the
	 * object set. Omitted means the default: copy the closure and keep the root.
	 *
	 * A fork never writes to the source. A `degrade` policy has to invent an
	 * object - a job history with its running job marked interrupted - and that
	 * object belongs to the new session, not to the one being read: writing it
	 * into the source would leave it holding state only somebody else needs.
	 */
	fork?(request: NamespaceForkRequest): Promise<NamespaceForkResult>;

	/**
	 * Read an object written by an older version of this namespace, returning
	 * the state root of its current-version equivalent.
	 *
	 * The new object goes into the same log and the old-to-new mapping is
	 * recomputed on every open. The branch is never rewritten: a ref names the
	 * old root forever, and appending a corrected ref would make one leaf
	 * resolve differently depending on which build opened it.
	 *
	 * Absent means older versions are not readable, which is reported and
	 * degraded rather than thrown.
	 */
	migrate?(options: {
		readonly fromVersion: number;
		readonly stateRoot: string;
		readonly storage: CustomStorage;
	}): Promise<string | undefined>;
}

/**
 * The set of namespaces this build understands.
 *
 * A session can always be opened, listed and read with an empty registry; only
 * the states it carries go unresolved. That is deliberate: an old build must
 * still be able to read a session written by a newer one.
 */
export class PersistenceRegistry {
	private readonly _definitions = new Map<
		string,
		PersistenceNamespaceDefinition
	>();

	register(definition: PersistenceNamespaceDefinition): void {
		if (this._definitions.has(definition.namespace)) {
			throw new Error(
				`Persistence namespace ${definition.namespace} is already registered.`,
			);
		}
		this._definitions.set(definition.namespace, definition);
	}

	get(namespace: string): PersistenceNamespaceDefinition | undefined {
		return this._definitions.get(namespace);
	}

	get namespaces(): readonly string[] {
		return [...this._definitions.keys()];
	}
}
