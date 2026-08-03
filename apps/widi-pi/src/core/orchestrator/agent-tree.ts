/**
 * Spawn tree persistence: the durable records, the `core:subagent` namespace
 * that holds them, and one agent's membership bound to the branch that owns it.
 *
 * A parent records the agents it spawned, so rewinding past a spawn unmakes the
 * member and forking a branch carries the members that branch could see. The
 * membership is a chain of transitions rather than a snapshot, for the same
 * three reasons a job history is: what gets written is the event itself, a
 * branch rewound to a mid-chain ref reduces to the prefix that was true there,
 * and the fork closure follows the dependency links without being told to.
 *
 * ## What the framework does with this, and what it does not
 *
 * The one thing `core:subagent` needs beyond an ordinary object log is to name
 * other sessions: a `spawned` record points at a child session directory, and
 * `listSessionDependencies` is how the repository learns to fork that directory
 * too. The walk, the deduplication and the cycle detection all stay in
 * `fork-closure.ts` - this namespace only declares.
 *
 * The records name a child by its **directory name inside this session's
 * `agents/`**, never by a `SessionKey`. A fork copies a child under the name it
 * already had but re-parents it, so a stored absolute key would point at the
 * source tree the moment it was copied. The absolute key is computed at open
 * time against the session that owns the storage, which is the only place the
 * answer is known and stays correct.
 *
 * ## Two differences from `core:jobs` worth stating
 *
 * The fork policy is `copy` and there is no `fork` hook. A job's live executor
 * cannot be carried, so a fork has to write it off; a member's child session
 * *is* carried, as a real directory the new tree can resume. Nothing about an
 * inherited member is a lie that needs correcting.
 *
 * There is no seal either. A job the branch has open and the runtime does not
 * recognize is a promise nobody will keep, so it must be closed. A member the
 * branch has live and the runtime does not recognize is the ordinary state of
 * every resume, and the answer is to restore it, not to write it off. Whether
 * to restore, what to do when it fails, and how to resolve an AgentId that two
 * runtimes both used are activation questions, and activation belongs to the
 * orchestrator - see "What persistence does not decide" in `custom-storage.ts`.
 */

import type {
	CustomStorage,
	JsonlPersistenceRepo,
	NamespaceStorageContext,
	PersistenceNamespaceDefinition,
	SessionAddress,
	SessionKey,
} from "../persistence/index.ts";
import { childSessionKey, JsonlObjectStore, OBJECTS_FILE_NAME } from "../persistence/index.ts";
import type { AgentId } from "../types.ts";
import type {
	SessionSubagentStoreOptions,
	SubagentBranchPort,
	SubagentMember,
	SubagentMembership,
	SubagentRecord,
	SubagentRemovedRecord,
	SubagentSpawnedRecord,
	SubagentSpawnRequest,
} from "./types.ts";

export const SUBAGENT_NAMESPACE = "core:subagent";

export const SUBAGENT_FORMAT_VERSION = 1;

/** Bounds a damaged or hand-edited log; content addressing rules out cycles. */
export const MAX_SUBAGENT_CHAIN_LENGTH = 10_000;

// -- records --------------------------------------------------------------

/**
 * Reduce records, oldest first, into the membership they describe.
 *
 * A `removed` record with no `spawned` on this chain is dropped, so a branch
 * rewound past a spawn never sees the member even though the removal happened
 * on some other branch; and the first record of each kind wins, so a replayed
 * or duplicated write cannot rewrite a member that is already recorded.
 */
export function reduceSubagentRecords(records: readonly SubagentRecord[]): readonly SubagentMember[] {
	const members = new Map<string, SubagentMember>();
	for (const record of records) applySubagentRecord(members, record);
	return [...members.values()];
}

/** One step of {@link reduceSubagentRecords}, for a reduction kept up to date live. */
export function applySubagentRecord(members: Map<string, SubagentMember>, record: SubagentRecord): void {
	if (record.kind === "spawned") {
		if (members.has(record.sessionDirName)) return;
		members.set(record.sessionDirName, {
			sessionDirName: record.sessionDirName,
			agentId: record.agentId,
			profileId: record.profileId,
			spawnedAt: record.spawnedAt,
			state: "live",
		});
		return;
	}
	const member = members.get(record.sessionDirName);
	if (!member || member.state !== "live") return;
	members.set(record.sessionDirName, { ...member, state: "removed", removedAt: record.removedAt });
}

/**
 * The child sessions one record names, resolved against the session that owns
 * the log.
 *
 * A `removed` record names none. That is not an omission: the closure walk
 * visits every object on the chain, so the `spawned` record of a member removed
 * later still contributes its directory, and a fork carries the whole tree the
 * branch ever built rather than only its surviving tip. A branch rewound in the
 * new session to before the removal then still finds the directory it names.
 */
export function subagentSessionDependencies(owner: SessionKey, data: unknown): readonly SessionKey[] {
	const record = toSubagentRecord(data);
	if (record?.kind !== "spawned") return [];
	return [childSessionKey(owner, record.sessionDirName)];
}

/** Read a record back off disk, rejecting anything this build cannot reduce. */
export function toSubagentRecord(value: unknown): SubagentRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.sessionDirName !== "string" || !record.sessionDirName) {
		return undefined;
	}
	switch (record.kind) {
		case "spawned":
			return isSpawnedRecord(record) ? (record as unknown as SubagentSpawnedRecord) : undefined;
		case "removed":
			return typeof record.removedAt === "number" ? (record as unknown as SubagentRemovedRecord) : undefined;
		default:
			return undefined;
	}
}

function isSpawnedRecord(record: Record<string, unknown>): boolean {
	return (
		typeof record.agentId === "string" &&
		!!record.agentId &&
		typeof record.profileId === "string" &&
		typeof record.spawnedAt === "number"
	);
}

// -- namespace storage ----------------------------------------------------

/**
 * The default object log, wrapped for one reason: a membership is a chain, so
 * resolving a state root means walking it and reducing rather than reading one
 * object. Everything else delegates, including the session dependencies, which
 * the log already answers from the callback it was opened with.
 */
export class SubagentTreeStorage implements CustomStorage {
	private readonly _objects: JsonlObjectStore;
	private readonly _sessionKey: SessionKey;

	private constructor(options: { objects: JsonlObjectStore; sessionKey: SessionKey }) {
		this._objects = options.objects;
		this._sessionKey = options.sessionKey;
	}

	static async open(context: NamespaceStorageContext): Promise<SubagentTreeStorage> {
		return new SubagentTreeStorage({
			sessionKey: context.sessionKey,
			objects: await JsonlObjectStore.open({
				fs: context.fs,
				dirPath: context.dirPath,
				filePath: `${context.dirPath}/${OBJECTS_FILE_NAME}`,
				namespace: SUBAGENT_NAMESPACE,
				formatVersion: SUBAGENT_FORMAT_VERSION,
				sessionKey: context.sessionKey,
				diagnostics: context.diagnostics,
				owner: context.owner,
				// Bound to the owning session here, which is the only place both
				// halves of a child's address are known at once.
				sessionDependenciesOf: (data) => subagentSessionDependencies(context.sessionKey, data),
			}),
		});
	}

	/** The session whose tree this is; a member's key is this plus its directory. */
	get sessionKey(): SessionKey {
		return this._sessionKey;
	}

	get storedFormatVersion(): number {
		return this._objects.storedFormatVersion;
	}

	/** Where a member lives, as a persisted record is allowed to name it. */
	childKeyOf(member: SubagentMember): SessionKey {
		return childSessionKey(this._sessionKey, member.sessionDirName);
	}

	/** Undefined means a dangling ref; a damaged chain answers with what it has. */
	async resolveState(stateRoot: string): Promise<SubagentMembership | undefined> {
		if (!this._objects.has(stateRoot)) return undefined;
		const reversed: SubagentRecord[] = [];
		const visited = new Set<string>();
		let truncated = false;
		let current: string | undefined = stateRoot;
		while (current !== undefined) {
			if (visited.has(current) || !this._objects.has(current) || visited.size >= MAX_SUBAGENT_CHAIN_LENGTH) {
				truncated = true;
				break;
			}
			visited.add(current);
			// A link this build cannot read is stepped over, not stopped at: an
			// unreadable fact is not a broken chain.
			const record = toSubagentRecord(await this._objects.resolveState(current));
			if (record) reversed.push(record);
			current = (await this._objects.listDependencies(current))[0];
		}
		return { members: reduceSubagentRecords(reversed.reverse()), truncated };
	}

	async listDependencies(stateRoot: string): Promise<readonly string[]> {
		return await this._objects.listDependencies(stateRoot);
	}

	async listSessionDependencies(stateRoot: string): Promise<readonly SessionKey[]> {
		return await this._objects.listSessionDependencies(stateRoot);
	}

	async putObject(options: { readonly data: unknown; readonly dependencies?: readonly string[] }): Promise<string> {
		return await this._objects.putObject(options);
	}

	async copyReachable(target: CustomStorage, roots: readonly string[]): Promise<void> {
		await this._objects.copyReachable(target, roots);
	}

	/** Append a transition onto `previousRoot`, returning the new state root. */
	async appendRecord(record: SubagentRecord, previousRoot: string | null): Promise<string> {
		return await this._objects.putObject({ data: record, dependencies: previousRoot === null ? [] : [previousRoot] });
	}
}

/**
 * The namespace definition, ready to register.
 *
 * `copy` with no `fork` hook: the repository copies the objects and forks the
 * child sessions they name, and both come out of the fork as things the new
 * tree genuinely owns. A child the repository could not copy - too deep to
 * nest, or a directory that would not read - is reported by the repository as a
 * `child_not_copied` or `nesting_limit` diagnostic and left named but absent.
 * Pruning it from here is not possible anyway: namespaces are forked before the
 * child sessions are, so this hook would be guessing at an outcome that has not
 * happened yet.
 */
export function createSubagentNamespace(): PersistenceNamespaceDefinition {
	return {
		namespace: SUBAGENT_NAMESPACE,
		version: SUBAGENT_FORMAT_VERSION,
		forkPolicy: "copy",
		openStorage: async (context) => await SubagentTreeStorage.open(context),
	};
}

/**
 * Open this namespace's storage for one session, through the repository.
 *
 * Undefined means nothing is registered for `core:subagent`, which is how a
 * session whose tree this build does not manage still opens. The caller owns
 * the returned handle and closes it.
 */
export async function openSubagentTreeStorage(
	repo: JsonlPersistenceRepo,
	address: SessionAddress,
): Promise<SubagentTreeStorage | undefined> {
	const storage = await repo.openStorage(address, SUBAGENT_NAMESPACE);
	if (storage === undefined) return undefined;
	if (!(storage instanceof SubagentTreeStorage)) {
		throw new Error(`${SUBAGENT_NAMESPACE} is registered with a foreign storage.`);
	}
	return storage;
}

// -- one agent's store ----------------------------------------------------

/**
 * One agent's spawn tree, bound to the branch that owns it.
 *
 * Every record is written twice over: as an immutable object, then as a ref the
 * branch carries. That order is not negotiable - a ref naming an object that is
 * not there yet is a dangling pointer, while an object nothing names is
 * collectable garbage.
 *
 * The branch belongs to somebody else, so this class asks rather than reaches:
 * it never sees the conversation, never builds a ref, and never decides which
 * ref is in force.
 */
export class SessionSubagentStore {
	private readonly _storage: SubagentTreeStorage;
	private readonly _branch: SubagentBranchPort;
	private readonly _members: Map<string, SubagentMember>;
	private readonly _carriedOver: readonly SubagentMember[];
	private readonly _truncated: boolean;
	private _stateRoot: string | null;
	// Appends are serialized because each one chains onto the root the last one
	// produced; two in the same tick would both chain onto the same root and one
	// would fall off the branch.
	private _writes: Promise<unknown> = Promise.resolve();

	private constructor(options: {
		storage: SubagentTreeStorage;
		branch: SubagentBranchPort;
		stateRoot: string | null;
		members: readonly SubagentMember[];
		truncated: boolean;
	}) {
		this._storage = options.storage;
		this._branch = options.branch;
		this._stateRoot = options.stateRoot;
		this._members = new Map(options.members.map((member) => [member.sessionDirName, member]));
		this._carriedOver = options.members.filter((member) => member.state === "live");
		this._truncated = options.truncated;
	}

	static async open(options: SessionSubagentStoreOptions): Promise<SessionSubagentStore> {
		const named = (await options.branch.projection())?.stateRoot ?? null;
		const membership = named === null ? undefined : await options.storage.resolveState(named);
		// A ref naming an object nobody can find gets a fresh chain rather than a
		// chain rooted at a pointer that will never resolve again.
		return new SessionSubagentStore({
			storage: options.storage,
			branch: options.branch,
			stateRoot: membership === undefined ? null : named,
			members: membership?.members ?? [],
			truncated: membership === undefined ? named !== null : membership.truncated,
		});
	}

	/** The membership on record is incomplete, in a way nobody can size. */
	get truncated(): boolean {
		return this._truncated;
	}

	get stateRoot(): string | null {
		return this._stateRoot;
	}

	/** Every member the branch ever recorded, removed ones included. */
	members(): readonly SubagentMember[] {
		return [...this._members.values()];
	}

	/**
	 * The members that were live when this store was opened: exactly the agents
	 * the branch expects to exist and this runtime has not built. Frozen at open,
	 * so an agent this run spawns never joins it.
	 */
	carriedOverMembers(): readonly SubagentMember[] {
		return this._carriedOver;
	}

	/**
	 * The newest live member recorded under an AgentId.
	 *
	 * Newest because an AgentId is only unique within one runtime: a resumed root
	 * that spawns `coder-1` again records a second live member under the same id,
	 * and the one this runtime means is the one it just made. Resolving that
	 * ambiguity for good is the orchestrator's remapping, not this layer's.
	 */
	liveMemberOf(agentId: AgentId): SubagentMember | undefined {
		let found: SubagentMember | undefined;
		for (const member of this._members.values()) {
			if (member.agentId !== agentId || member.state !== "live") continue;
			if (found === undefined || member.spawnedAt >= found.spawnedAt) found = member;
		}
		return found;
	}

	/** Where a member's session lives, for a caller about to open it. */
	childKeyOf(member: SubagentMember): SessionKey {
		return this._storage.childKeyOf(member);
	}

	/** Record that a child session joined this tree. */
	async recordSpawn(request: SubagentSpawnRequest): Promise<string> {
		return await this.append({
			kind: "spawned",
			sessionDirName: request.sessionDirName,
			agentId: request.agentId,
			profileId: request.profileId,
			spawnedAt: request.spawnedAt ?? Date.now(),
		});
	}

	/**
	 * Record that a member left for good, if the branch still has it live, and
	 * answer with the new state root or nothing when there was nothing to record.
	 *
	 * A member the branch does not have live costs no ref, so a dispose that
	 * arrives twice - or one aimed at an agent this branch was rewound past -
	 * writes nothing. The check runs inside the write tail rather than before it,
	 * or two concurrent removals would both find the member live. Removal is the
	 * caller's judgement: only a dispose meant as removal comes here, and a
	 * runtime shutdown never does.
	 */
	recordRemoval(sessionDirName: string, removedAt?: number): Promise<string | undefined> {
		const next = this._writes.then(async () => {
			const member = this._members.get(sessionDirName);
			if (!member || member.state !== "live") return undefined;
			return await this._append({ kind: "removed", sessionDirName, removedAt: removedAt ?? Date.now() });
		});
		this._writes = next.catch(() => {});
		return next;
	}

	/**
	 * Record one transition and return the state root the branch now names.
	 * Rejects when either write fails, after the in-process reduction has already
	 * been updated: this runtime stays consistent with itself even when the branch
	 * stops being a complete record of it.
	 */
	append(record: SubagentRecord): Promise<string> {
		const next = this._writes.then(async () => await this._append(record));
		this._writes = next.catch(() => {});
		return next;
	}

	private async _append(record: SubagentRecord): Promise<string> {
		applySubagentRecord(this._members, record);
		const stateRoot = await this._storage.appendRecord(record, this._stateRoot);
		await this._branch.commit(stateRoot);
		this._stateRoot = stateRoot;
		return stateRoot;
	}
}
