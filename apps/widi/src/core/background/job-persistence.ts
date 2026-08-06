/**
 * Job persistence: the durable records, the `core:jobs` namespace that holds
 * them, and one agent's history bound to the branch that owns it.
 *
 * A history is a chain of transitions rather than a snapshot, so a rewound
 * branch reduces to what it saw instead of to what happened afterwards.
 */

import { getFileSystemResultOrThrow } from "@widi/agent-core";
import type {
	CustomStorage,
	NamespaceForkRequest,
	NamespaceForkResult,
	NamespaceStorageContext,
	PersistenceFileSystem,
	PersistenceNamespaceDefinition,
} from "../persistence/index.ts";
import { contentHash, JsonlObjectStore, OBJECTS_FILE_NAME } from "../persistence/index.ts";
import type {
	BackgroundJobOrigin,
	JobBranchPort,
	JobCloseCause,
	JobClosedRecord,
	JobClosurePlanRequest,
	JobHistory,
	JobHistoryEntry,
	JobRecord,
	JobSealRequest,
	JobSettledRecord,
	JobStartedRecord,
	SessionJobStoreOptions,
} from "./types.ts";
import { MAX_PERSISTED_JOB_MESSAGE_BYTES, MAX_PERSISTED_JOB_OUTPUT_BYTES } from "./types.ts";

export const JOBS_NAMESPACE = "core:jobs";

export const JOBS_FORMAT_VERSION = 1;

/** Directory holding one namespace's job output files. */
export const JOB_OUTPUT_DIR_NAME = "output";

/** Bounds a damaged or hand-edited log; content addressing rules out cycles. */
export const MAX_JOB_CHAIN_LENGTH = 10_000;

const MAX_OUTPUT_NAME_PREFIX = 64;

const CLOSE_CAUSES: ReadonlySet<string> = new Set<JobCloseCause>(["resume", "navigate", "dispose", "fork", "abort"]);

// -- records --------------------------------------------------------------

/**
 * Reduce records, oldest first, into the job table they describe.
 *
 * A terminal record with no head on this chain is dropped, so a branch rewound
 * past a job's start never sees the job; and the first terminal record wins, so
 * a closure racing a settlement cannot rewrite an answer that already arrived.
 */
export function reduceJobRecords(records: readonly JobRecord[]): readonly JobHistoryEntry[] {
	const jobs = new Map<string, JobHistoryEntry>();
	for (const record of records) applyJobRecord(jobs, record);
	return [...jobs.values()];
}

/** One step of {@link reduceJobRecords}, for a reduction kept up to date live. */
export function applyJobRecord(jobs: Map<string, JobHistoryEntry>, record: JobRecord): void {
	if (record.kind === "started") {
		if (jobs.has(record.toolCallId)) return;
		jobs.set(record.toolCallId, {
			toolCallId: record.toolCallId,
			jobId: record.jobId,
			ownerAgentId: record.ownerAgentId,
			sessionId: record.sessionId,
			toolName: record.toolName,
			name: record.name,
			description: record.description,
			origin: record.origin,
			startedAt: record.startedAt,
			backgroundedAt: record.backgroundedAt,
			outputFile: record.outputFile,
			state: "open",
		});
		return;
	}
	const job = jobs.get(record.toolCallId);
	if (!job || job.state !== "open") return;
	jobs.set(
		record.toolCallId,
		record.kind === "settled"
			? {
					...job,
					state: "settled",
					status: record.status,
					stopReason: record.stopReason,
					endedAt: record.endedAt,
					messageText: record.messageText,
					outputTail: record.outputTail,
				}
			: { ...job, state: "closed", cause: record.cause, stopReason: record.stopReason, endedAt: record.closedAt },
	);
}

/**
 * The closures a runtime owes this branch: every job the branch has open that
 * the runtime does not recognize. The membership test is the runtime's memory,
 * never the branch alone - a navigation kills nothing, so a job open on the
 * branch and live in this process must survive it.
 */
export function planJobClosures(request: JobClosurePlanRequest): readonly JobClosedRecord[] {
	const records: JobClosedRecord[] = [];
	for (const job of request.jobs) {
		if (job.state !== "open") continue;
		if (request.recognized.has(job.toolCallId)) continue;
		records.push({
			kind: "closed",
			toolCallId: job.toolCallId,
			cause: request.cause,
			closedAt: request.closedAt,
			...(request.stopReason === undefined ? undefined : { stopReason: request.stopReason }),
		});
	}
	return records;
}

/** A single path segment naming one job's output. */
export function jobOutputFileName(toolCallId: string): string {
	// The hash suffix is unconditional: sanitizing alone would let two ids that
	// differ only in characters a path cannot hold collide on one file.
	const safe = toolCallId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, MAX_OUTPUT_NAME_PREFIX);
	return `${safe}-${contentHash(toolCallId).slice(-8)}.log`;
}

/** Read a record back off disk, rejecting anything this build cannot reduce. */
export function toJobRecord(value: unknown): JobRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.toolCallId !== "string" || !record.toolCallId) {
		return undefined;
	}
	switch (record.kind) {
		case "started":
			return isStartedRecord(record) ? (record as unknown as JobStartedRecord) : undefined;
		case "settled":
			return isSettledRecord(record) ? (record as unknown as JobSettledRecord) : undefined;
		case "closed":
			return isClosedRecord(record) ? (record as unknown as JobClosedRecord) : undefined;
		default:
			return undefined;
	}
}

/** Bound the two texts a settlement carries before they are written down. */
export function boundJobRecord(record: JobRecord): JobRecord {
	if (record.kind !== "settled") return record;
	const outputTail =
		record.outputTail === undefined || record.outputTail.length === 0
			? undefined
			: keepTail(record.outputTail, MAX_PERSISTED_JOB_OUTPUT_BYTES);
	const { outputTail: _stored, ...rest } = record;
	return {
		...rest,
		messageText: keepHead(record.messageText, MAX_PERSISTED_JOB_MESSAGE_BYTES),
		...(outputTail === undefined ? undefined : { outputTail }),
	};
}

function isStartedRecord(record: Record<string, unknown>): boolean {
	return (
		typeof record.jobId === "string" &&
		typeof record.ownerAgentId === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.toolName === "string" &&
		typeof record.outputFile === "string" &&
		typeof record.startedAt === "number" &&
		typeof record.backgroundedAt === "number" &&
		isOrigin(record.origin) &&
		isOptionalString(record.name) &&
		isOptionalString(record.description)
	);
}

function isSettledRecord(record: Record<string, unknown>): boolean {
	return (
		(record.status === "completed" || record.status === "failed" || record.status === "cancelled") &&
		typeof record.endedAt === "number" &&
		typeof record.messageText === "string" &&
		isOptionalString(record.stopReason) &&
		isOptionalString(record.outputTail)
	);
}

function isClosedRecord(record: Record<string, unknown>): boolean {
	return (
		typeof record.cause === "string" &&
		CLOSE_CAUSES.has(record.cause) &&
		typeof record.closedAt === "number" &&
		isOptionalString(record.stopReason)
	);
}

function isOrigin(value: unknown): value is BackgroundJobOrigin {
	if (typeof value !== "object" || value === null) return false;
	const origin = value as Record<string, unknown>;
	if (origin.kind === "local") return true;
	return origin.kind === "external" && typeof origin.settlerId === "string";
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

/** Both truncations can split a UTF-8 character; these texts are for reading. */
function keepHead(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf-8");
	if (buffer.length <= maxBytes) return text;
	const dropped = buffer.length - maxBytes;
	return `${buffer.subarray(0, maxBytes).toString("utf-8")}\n[${dropped} more bytes were not stored]`;
}

function keepTail(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf-8");
	if (buffer.length <= maxBytes) return text;
	const dropped = buffer.length - maxBytes;
	return `[${dropped} earlier bytes were not stored]\n${buffer.subarray(dropped).toString("utf-8")}`;
}

// -- namespace storage ----------------------------------------------------

/**
 * The default object log, wrapped because a job history is a chain and its
 * output is a file: resolving walks the chain, and copying takes the output
 * files along so a fork never names bytes the new session cannot read.
 */
export class JobHistoryStorage implements CustomStorage {
	private readonly _fs: PersistenceFileSystem;
	private readonly _objects: JsonlObjectStore;
	private readonly _outputDirPath: string;

	private constructor(options: { fs: PersistenceFileSystem; objects: JsonlObjectStore; outputDirPath: string }) {
		this._fs = options.fs;
		this._objects = options.objects;
		this._outputDirPath = options.outputDirPath;
	}

	static async open(context: NamespaceStorageContext): Promise<JobHistoryStorage> {
		const join = async (segments: string[]): Promise<string> =>
			getFileSystemResultOrThrow(
				await context.fs.joinPath(segments),
				`Failed to resolve a path under ${context.dirPath}`,
			);
		return new JobHistoryStorage({
			fs: context.fs,
			objects: await JsonlObjectStore.open({
				fs: context.fs,
				dirPath: context.dirPath,
				filePath: await join([context.dirPath, OBJECTS_FILE_NAME]),
				namespace: JOBS_NAMESPACE,
				formatVersion: JOBS_FORMAT_VERSION,
				sessionKey: context.sessionKey,
				diagnostics: context.diagnostics,
				owner: context.owner,
			}),
			outputDirPath: await join([context.dirPath, JOB_OUTPUT_DIR_NAME]),
		});
	}

	get storedFormatVersion(): number {
		return this._objects.storedFormatVersion;
	}

	/** Undefined means a dangling ref; a damaged chain answers with what it has. */
	async resolveState(stateRoot: string): Promise<JobHistory | undefined> {
		if (!this._objects.has(stateRoot)) return undefined;
		const reversed: JobRecord[] = [];
		const visited = new Set<string>();
		let truncated = false;
		let current: string | undefined = stateRoot;
		while (current !== undefined) {
			if (visited.has(current) || !this._objects.has(current) || visited.size >= MAX_JOB_CHAIN_LENGTH) {
				truncated = true;
				break;
			}
			visited.add(current);
			// A link this build cannot read is stepped over, not stopped at: an
			// unreadable fact is not a broken chain.
			const record = toJobRecord(await this._objects.resolveState(current));
			if (record) reversed.push(record);
			current = (await this._objects.listDependencies(current))[0];
		}
		return { jobs: reduceJobRecords(reversed.reverse()), truncated };
	}

	async listDependencies(stateRoot: string): Promise<readonly string[]> {
		return await this._objects.listDependencies(stateRoot);
	}

	async putObject(options: { readonly data: unknown; readonly dependencies?: readonly string[] }): Promise<string> {
		return await this._objects.putObject(options);
	}

	async copyReachable(target: CustomStorage, roots: readonly string[]): Promise<void> {
		await this._objects.copyReachable(target, roots);
		if (!(target instanceof JobHistoryStorage)) return;
		const files = new Set<string>();
		for (const root of roots) {
			const record = toJobRecord(await this._objects.resolveState(root));
			if (record?.kind === "started") files.add(record.outputFile);
		}
		for (const file of files) await this._copyOutput(target, file);
	}

	/** Append a transition onto `previousRoot`, returning the new state root. */
	async appendRecord(record: JobRecord, previousRoot: string | null): Promise<string> {
		return await this._objects.putObject({
			data: boundJobRecord(record),
			dependencies: previousRoot === null ? [] : [previousRoot],
		});
	}

	/** The chain under `stateRoot`, tip first. */
	async reachableFrom(stateRoot: string): Promise<readonly string[]> {
		const chain: string[] = [];
		const visited = new Set<string>();
		let current: string | undefined = stateRoot;
		while (
			current !== undefined &&
			!visited.has(current) &&
			this._objects.has(current) &&
			visited.size < MAX_JOB_CHAIN_LENGTH
		) {
			visited.add(current);
			chain.push(current);
			current = (await this._objects.listDependencies(current))[0];
		}
		return chain;
	}

	async outputFilePath(fileName: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this._fs.joinPath([this._outputDirPath, fileName]),
			`Failed to resolve the output file of ${fileName}`,
		);
	}

	/** Created on first write, so a session with no job output grows no directory. */
	async ensureOutputDir(): Promise<void> {
		const created = await this._fs.createDir(this._outputDirPath, { recursive: true });
		if (!created.ok) throw new Error(created.error.message);
	}

	private async _copyOutput(target: JobHistoryStorage, fileName: string): Promise<void> {
		const read = await this._fs.readTextFile(await this.outputFilePath(fileName));
		// A job that printed nothing has no file, which is not a failure to copy.
		if (!read.ok) return;
		await target.ensureOutputDir();
		const wrote = await this._fs.writeFile(await target.outputFilePath(fileName), read.value);
		if (!wrote.ok) throw new Error(wrote.error.message);
	}
}

export function createJobsNamespace(): PersistenceNamespaceDefinition {
	return {
		namespace: JOBS_NAMESPACE,
		version: JOBS_FORMAT_VERSION,
		forkPolicy: "degrade",
		openStorage: async (context) => await JobHistoryStorage.open(context),
		fork: async (request) => await forkJobHistory(request),
	};
}

/**
 * Carry the history over and declare every inherited job interrupted. The
 * closures are written into the target only: nothing is running in the new
 * session, and the source keeps running whatever it was running.
 */
async function forkJobHistory(request: NamespaceForkRequest): Promise<NamespaceForkResult> {
	await request.source.copyReachable(request.target, request.roots);
	if (request.roots.length === 0) return { stateRoot: null };
	const target = request.target;
	if (!(target instanceof JobHistoryStorage)) {
		throw new Error(`${JOBS_NAMESPACE} was forked into a foreign storage.`);
	}
	const tip = await chainTip(request.source, request.roots);
	const history = await target.resolveState(tip);
	if (!history) {
		throw new Error(`${JOBS_NAMESPACE} could not resolve the forked chain.`);
	}
	const closures = planJobClosures({
		jobs: history.jobs,
		recognized: new Set(),
		cause: "fork",
		closedAt: Date.now(),
		stopReason: "The session this job belonged to was forked.",
	});
	let stateRoot = tip;
	for (const record of closures) {
		stateRoot = await target.appendRecord(record, stateRoot);
	}
	return { stateRoot, origin: closures.length > 0 ? "fork_degraded" : "fork" };
}

/** The one object in the closure nothing else depends on. */
async function chainTip(storage: CustomStorage, roots: readonly string[]): Promise<string> {
	const depended = new Set<string>();
	for (const root of roots) {
		for (const dep of await storage.listDependencies(root)) depended.add(dep);
	}
	const tips = roots.filter((root) => !depended.has(root));
	const tip = tips[0];
	if (tips.length !== 1 || tip === undefined) {
		throw new Error(`${JOBS_NAMESPACE} expected one chain tip, found ${tips.length}.`);
	}
	return tip;
}

// -- one agent's store ----------------------------------------------------

/**
 * One agent's job history, bound to the branch that owns it.
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
export class SessionJobStore {
	private readonly _storage: JobHistoryStorage;
	private readonly _branch: JobBranchPort;
	private readonly _jobs: Map<string, JobHistoryEntry>;
	private readonly _carriedOver: readonly JobHistoryEntry[];
	private _truncated: boolean;
	private _stateRoot: string | null;
	// Appends are serialized because each one chains onto the root the last one
	// produced; two in the same tick would both chain onto the same root and one
	// would fall off the branch.
	private _writes: Promise<unknown> = Promise.resolve();

	private constructor(options: {
		storage: JobHistoryStorage;
		branch: JobBranchPort;
		stateRoot: string | null;
		jobs: readonly JobHistoryEntry[];
		truncated: boolean;
	}) {
		this._storage = options.storage;
		this._branch = options.branch;
		this._stateRoot = options.stateRoot;
		this._jobs = new Map(options.jobs.map((job) => [job.toolCallId, job]));
		this._carriedOver = options.jobs.filter((job) => job.state === "open");
		this._truncated = options.truncated;
	}

	static async open(options: SessionJobStoreOptions): Promise<SessionJobStore> {
		const named = (await options.branch.projection())?.stateRoot ?? null;
		const history = named === null ? undefined : await options.storage.resolveState(named);
		// A ref naming an object nobody can find gets a fresh chain rather than a
		// chain rooted at a pointer that will never resolve again.
		return new SessionJobStore({
			storage: options.storage,
			branch: options.branch,
			stateRoot: history === undefined ? null : named,
			jobs: history?.jobs ?? [],
			truncated: history === undefined ? named !== null : history.truncated,
		});
	}

	/** The history on record is incomplete, in a way nobody can size. */
	get truncated(): boolean {
		return this._truncated;
	}

	get stateRoot(): string | null {
		return this._stateRoot;
	}

	history(): readonly JobHistoryEntry[] {
		return [...this._jobs.values()];
	}

	/**
	 * Jobs the branch had open when this store was opened: exactly the t0 handles
	 * whose executor this runtime never had. Frozen at open, so a job this run
	 * starts never joins it.
	 */
	carriedOverJobs(): readonly JobHistoryEntry[] {
		return this._carriedOver;
	}

	/**
	 * Record one transition and return the state root the branch now names.
	 * Rejects when either write fails, after the in-process reduction has already
	 * been updated: this runtime stays consistent with itself even when the branch
	 * stops being a complete record of it.
	 */
	append(record: JobRecord): Promise<string> {
		const next = this._writes.then(async () => await this._append(record));
		this._writes = next.catch(() => {});
		return next;
	}

	/**
	 * Re-read the branch, then settle the difference between what it shows and
	 * what this runtime knows.
	 *
	 * Navigation moves the leaf and stops nothing, so afterwards this store's
	 * chain head can belong to a branch nobody is on any more. Rebinding is what
	 * keeps the next append from extending an abandoned chain.
	 *
	 * A job the branch has open then has three possible answers. One this runtime
	 * still holds an executor for is left alone. One this runtime watched finish
	 * has its settlement recorded again - the outcome is a fact about the world,
	 * and this branch is the one that asked for it, so it is owed the answer
	 * rather than a notice that none is coming. Only a job with neither is closed.
	 *
	 * `announce` runs after the re-read and before the first record is written.
	 * That order is the same one settlement uses and for the same reason: a record
	 * claiming the model was told has to be the later of the two writes, so a
	 * crash between them repeats a message instead of losing one.
	 */
	async rebind(
		request: JobSealRequest,
		announce: (jobs: readonly JobHistoryEntry[]) => Promise<void>,
	): Promise<readonly JobRecord[]> {
		const known = new Map(this._jobs);
		await this._reproject();
		const recovered = new Map<string, JobSettledRecord>();
		for (const job of this._jobs.values()) {
			if (job.state !== "open" || request.recognized.has(job.toolCallId)) continue;
			const settled = toSettledRecord(known.get(job.toolCallId));
			if (settled) recovered.set(job.toolCallId, settled);
		}
		const records: JobRecord[] = [
			...recovered.values(),
			...planJobClosures({
				jobs: this.history(),
				// A recovered outcome is this runtime's own answer, so the job it
				// belongs to is no longer one nobody can account for.
				recognized: new Set([...request.recognized, ...recovered.keys()]),
				cause: request.cause,
				closedAt: request.closedAt ?? Date.now(),
				...(request.stopReason === undefined ? undefined : { stopReason: request.stopReason }),
			}),
		];
		if (records.length === 0) return records;
		// Described from the reduction these records produce, so each job is named
		// in the words of the answer it actually got.
		const described = new Map(this._jobs);
		for (const record of records) applyJobRecord(described, record);
		await announce(records.flatMap((record) => described.get(record.toolCallId) ?? []));
		for (const record of records) await this.append(record);
		return records;
	}

	/** Close every job the branch has open that `recognized` does not name. */
	async seal(request: JobSealRequest): Promise<readonly JobClosedRecord[]> {
		const records = planJobClosures({
			jobs: this.history(),
			recognized: request.recognized,
			cause: request.cause,
			closedAt: request.closedAt ?? Date.now(),
			...(request.stopReason === undefined ? undefined : { stopReason: request.stopReason }),
		});
		for (const record of records) await this.append(record);
		return records;
	}

	async outputFilePath(toolCallId: string): Promise<string> {
		return await this._storage.outputFilePath(jobOutputFileName(toolCallId));
	}

	async ensureOutputDir(): Promise<void> {
		await this._storage.ensureOutputDir();
	}

	private async _append(record: JobRecord): Promise<string> {
		applyJobRecord(this._jobs, record);
		const stateRoot = await this._storage.appendRecord(record, this._stateRoot);
		await this._branch.commit(stateRoot);
		this._stateRoot = stateRoot;
		return stateRoot;
	}

	/**
	 * Take the branch's current word for this namespace as the whole truth. Same
	 * rule as `open`, including the fresh chain a dangling ref falls back to.
	 * `carriedOverJobs` is deliberately not recomputed: it answers what this
	 * runtime inherited when it attached, which no later navigation changes.
	 */
	private async _reproject(): Promise<void> {
		const named = (await this._branch.projection())?.stateRoot ?? null;
		const history = named === null ? undefined : await this._storage.resolveState(named);
		this._stateRoot = history === undefined ? null : named;
		this._truncated = history === undefined ? named !== null : history.truncated;
		this._jobs.clear();
		for (const job of history?.jobs ?? []) this._jobs.set(job.toolCallId, job);
	}
}

/**
 * One runtime's own answer for a job, in a shape another branch can record.
 *
 * Undefined for anything that is not a complete settlement this build can
 * reproduce - a job still open, one closed rather than settled, one whose t1
 * text is missing. There is nothing to hand a branch in those cases, and
 * inventing a settlement is worse than declaring the job closed.
 */
function toSettledRecord(job: JobHistoryEntry | undefined): JobSettledRecord | undefined {
	if (job?.state !== "settled") return undefined;
	if (job.status === undefined || job.endedAt === undefined || job.messageText === undefined) return undefined;
	return {
		kind: "settled",
		toolCallId: job.toolCallId,
		status: job.status,
		endedAt: job.endedAt,
		messageText: job.messageText,
		...(job.stopReason === undefined ? undefined : { stopReason: job.stopReason }),
		...(job.outputTail === undefined ? undefined : { outputTail: job.outputTail }),
	};
}
