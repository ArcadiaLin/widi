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
 */

import type { FileSystem } from "@widi/agent-core";
import type { PersistenceDiagnostics } from "./utils/diagnostics.ts";
import type { SessionKey } from "./utils/layout.ts";
import type { PersistenceRefData } from "./utils/persistence-ref.ts";

export type PersistenceFileSystem = Pick<
	FileSystem,
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
}

export interface PersistenceNamespaceDefinition {
	/** Stable and globally unique, e.g. `core:subagent`. */
	readonly namespace: string;

	/** Format version of this namespace's objects, written into its log. */
	readonly version: number;

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
	 */
	fork?(request: NamespaceForkRequest): Promise<NamespaceForkResult>;

	/**
	 * Upgrade an object or a ref written by an older version of this namespace.
	 * Absent means older versions are not readable, which is reported rather
	 * than thrown.
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
