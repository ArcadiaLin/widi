/**
 * The owner's append-only background job journal.
 *
 * At t0 the model is told a result "will arrive later as a separate message". If
 * the runtime exits first that message never comes, and the session resumes with
 * a handle nothing will ever answer. This file is what makes that answerable: it
 * records the lifecycle facts of jobs that actually became observable, so a
 * resume can ask which t0 handles are still open and close each one exactly
 * once.
 *
 * It is a journal, not a store of live state - the distinction the old name got
 * wrong. Nothing here owns a job, revives a job, or decides a job's state; the
 * runtime is the only reducer, and this is the durable half of the same
 * reduction. Replay yields history, never live work.
 *
 * Layout: `<sessionDir>/jobs/jobs.jsonl`, append-only, one JSON record per line.
 * Job ids restart in every process, so records are keyed by `(epoch, jobId)`;
 * anything from another epoch belongs to a previous run ({@link carriedOverJobs}).
 *
 * Writes never swallow their failures. `append` rejects, because whether a
 * failed write means "fall back to inline" or "degrade and keep going" depends
 * on where in the lifecycle it happened - which only the runtime knows.
 */

import type { FileSystem } from "@widi/agent-core";
import { getFileSystemResultOrThrow } from "@widi/agent-core";
import {
	BACKGROUND_JOB_JOURNAL_SCHEMA_VERSION,
	type BackgroundJobJournal,
	type BackgroundJobJournalRecord,
	MAX_PERSISTED_JOB_MESSAGE_BYTES,
	MAX_PERSISTED_JOB_OUTPUT_BYTES,
	type PersistedBackgroundJob,
} from "./types.ts";

/** Directory owning a session's background job artifacts. */
export const BACKGROUND_JOBS_DIR_NAME = "jobs";

/** Append-only lifecycle log inside {@link BACKGROUND_JOBS_DIR_NAME}. */
export const BACKGROUND_JOBS_FILE_NAME = "jobs.jsonl";

type JournalFileSystem = Pick<
	FileSystem,
	"joinPath" | "readTextFile" | "appendFile" | "exists" | "createDir"
>;

export interface SessionJobJournalOptions {
	readonly fs: JournalFileSystem;
	/** Session directory owning the journal, from the session manager. */
	readonly sessionDir: string;
	/** Injectable epoch id. Defaults to a timestamped random id. */
	readonly epoch?: string;
}

/** Mutable replay accumulator; copied out as a plain value by the read APIs. */
interface JobState {
	schemaVersion: number;
	epoch: string;
	jobId: string;
	ownerAgentId: string;
	sessionId: string;
	toolCallId: string;
	toolName: string;
	name?: string;
	description?: string;
	origin: PersistedBackgroundJob["origin"];
	startedAt: number;
	backgroundedAt: number;
	report?: PersistedBackgroundJob["report"];
	abortRequested: boolean;
	status?: PersistedBackgroundJob["status"];
	stopReason?: string;
	endedAt?: number;
	messageText?: string;
	outputTail?: string;
}

export class SessionJobJournal implements BackgroundJobJournal {
	private readonly _fs: JournalFileSystem;
	private readonly _dirPath: string;
	private readonly _filePath: string;
	private readonly _epoch: string;
	private readonly _jobs = new Map<string, JobState>();
	private readonly _order: string[] = [];
	// Appends are serialized so two settlements in the same tick cannot interleave
	// their lines, and so a caller awaiting one record knows every earlier record
	// already landed.
	private _writes: Promise<void> = Promise.resolve();
	private _dirReady = false;
	private _corrupted = false;

	private constructor(options: {
		fs: JournalFileSystem;
		dirPath: string;
		filePath: string;
		epoch: string;
	}) {
		this._fs = options.fs;
		this._dirPath = options.dirPath;
		this._filePath = options.filePath;
		this._epoch = options.epoch;
	}

	/**
	 * Open the journal for a session directory and replay what earlier runs left
	 * there. Creates nothing on disk: a session whose agent never backgrounds a
	 * job never grows a jobs directory.
	 */
	static async open(
		options: SessionJobJournalOptions,
	): Promise<SessionJobJournal> {
		const dirPath = getFileSystemResultOrThrow(
			await options.fs.joinPath([options.sessionDir, BACKGROUND_JOBS_DIR_NAME]),
			`Failed to resolve background job directory in ${options.sessionDir}`,
		);
		const filePath = getFileSystemResultOrThrow(
			await options.fs.joinPath([dirPath, BACKGROUND_JOBS_FILE_NAME]),
			`Failed to resolve background job journal in ${dirPath}`,
		);
		const journal = new SessionJobJournal({
			fs: options.fs,
			dirPath,
			filePath,
			epoch: options.epoch ?? createEpochId(),
		});
		await journal._replay();
		return journal;
	}

	get epoch(): string {
		return this._epoch;
	}

	get corrupted(): boolean {
		return this._corrupted;
	}

	/** Every job on record, oldest first, across all epochs. */
	history(): readonly PersistedBackgroundJob[] {
		return this._order
			.map((key) => this._jobs.get(key))
			.filter((job): job is JobState => job !== undefined)
			.map((job) => ({ ...job }));
	}

	/**
	 * Jobs recorded by an earlier run of this session: exactly the t0 handles
	 * whose owning runtime no longer exists. Whether each still owes the model a
	 * message is not decided here - the session history is the authority on what
	 * the model was actually told.
	 */
	carriedOverJobs(): readonly PersistedBackgroundJob[] {
		return this.history().filter((job) => job.epoch !== this._epoch);
	}

	/**
	 * Apply a record to the in-memory reduction, then land it. Rejects when the
	 * write fails, after the reduction has already been updated: the caller stays
	 * consistent for this process even when the history stops being complete.
	 */
	append(record: BackgroundJobJournalRecord): Promise<void> {
		this._apply(record);
		const next = this._writes.then(() => this._appendLine(record));
		// Keep the chain alive for the next append even when this one rejects, and
		// do not turn a handled rejection into an unhandled one.
		this._writes = next.catch(() => {});
		return next;
	}

	private async _replay(): Promise<void> {
		const exists = await this._fs.exists(this._filePath);
		if (!exists.ok || !exists.value) return;
		const read = await this._fs.readTextFile(this._filePath);
		if (!read.ok) return;
		const lines = read.value.split("\n");
		for (const [index, line] of lines.entries()) {
			if (line.trim().length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				// A torn last line is the expected shape of a killed runtime. Anywhere
				// else it means the history has a hole, and a hole nobody can size is
				// worth reporting rather than reading past.
				if (index < lines.length - 1) this._corrupted = true;
				continue;
			}
			// Records this build does not recognize (a future type, or a line from
			// before the schema was versioned) are skipped without claiming
			// corruption: an unreadable fact is not a broken file.
			if (isJournalRecord(parsed)) this._apply(parsed);
		}
	}

	private _apply(record: BackgroundJobJournalRecord): void {
		const key = `${record.epoch} ${record.jobId}`;
		if (record.type === "job_backgrounded") {
			if (!this._jobs.has(key)) this._order.push(key);
			this._jobs.set(key, {
				schemaVersion: record.schemaVersion,
				epoch: record.epoch,
				jobId: record.jobId,
				ownerAgentId: record.ownerAgentId,
				sessionId: record.sessionId,
				toolCallId: record.toolCallId,
				toolName: record.toolName,
				name: record.name,
				description: record.description,
				origin: record.origin,
				startedAt: record.startedAt,
				backgroundedAt: record.backgroundedAt,
				abortRequested: false,
			});
			return;
		}
		// Every other record refines a job that must already have a head. One
		// without it cannot stand alone, so it is dropped rather than materializing
		// a job whose identity nobody recorded.
		const job = this._jobs.get(key);
		if (!job) return;
		switch (record.type) {
			case "job_reported":
				job.report = record.report;
				return;
			case "job_abort_requested":
				job.abortRequested = true;
				job.stopReason ??= record.stopReason;
				return;
			case "job_settled":
				job.status = record.status;
				job.stopReason = record.stopReason ?? job.stopReason;
				job.endedAt = record.endedAt;
				job.messageText = record.messageText;
				job.outputTail = record.outputTail;
				return;
		}
	}

	private async _appendLine(record: BackgroundJobJournalRecord): Promise<void> {
		if (!this._dirReady) {
			const created = await this._fs.createDir(this._dirPath, {
				recursive: true,
			});
			if (!created.ok) throw new Error(created.error.message);
			this._dirReady = true;
		}
		const appended = await this._fs.appendFile(
			this._filePath,
			`${JSON.stringify(bound(record))}\n`,
		);
		if (!appended.ok) throw new Error(appended.error.message);
	}
}

/**
 * Bound the two texts a settled record carries. The t1 text may be replayed
 * into a session, so it is capped by what is reasonable to re-inject rather
 * than by what the tool produced; the output tail is a diagnostic aid.
 */
function bound(record: BackgroundJobJournalRecord): BackgroundJobJournalRecord {
	if (record.type !== "job_settled") return record;
	const outputTail =
		record.outputTail === undefined || record.outputTail.length === 0
			? undefined
			: keepTail(record.outputTail, MAX_PERSISTED_JOB_OUTPUT_BYTES);
	return {
		...record,
		messageText: keepHead(record.messageText, MAX_PERSISTED_JOB_MESSAGE_BYTES),
		...(outputTail === undefined ? undefined : { outputTail }),
	};
}

function createEpochId(): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Keep the first `maxBytes` of a stored text, marking the elision. Both
 * truncations can split a UTF-8 character, which decodes to a replacement
 * character; these values are for reading and replay, not byte-exact transport.
 */
function keepHead(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf-8");
	if (buffer.length <= maxBytes) return text;
	const dropped = buffer.length - maxBytes;
	return `${buffer.subarray(0, maxBytes).toString("utf-8")}\n[${dropped} more bytes were not stored]`;
}

/** Keep the last `maxBytes` of a stored text, marking the elision. */
function keepTail(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf-8");
	if (buffer.length <= maxBytes) return text;
	const dropped = buffer.length - maxBytes;
	return `[${dropped} earlier bytes were not stored]\n${buffer.subarray(dropped).toString("utf-8")}`;
}

function isJournalRecord(value: unknown): value is BackgroundJobJournalRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<BackgroundJobJournalRecord>;
	if (
		record.schemaVersion !== BACKGROUND_JOB_JOURNAL_SCHEMA_VERSION ||
		typeof record.epoch !== "string" ||
		typeof record.jobId !== "string"
	) {
		return false;
	}
	switch (record.type) {
		case "job_backgrounded":
			return (
				typeof record.ownerAgentId === "string" &&
				typeof record.toolCallId === "string" &&
				typeof record.toolName === "string" &&
				typeof record.startedAt === "number" &&
				typeof record.backgroundedAt === "number" &&
				typeof record.origin === "object" &&
				record.origin !== null
			);
		case "job_reported":
			return typeof record.report === "object" && record.report !== null;
		case "job_abort_requested":
			return typeof record.at === "number";
		case "job_settled":
			return (
				typeof record.status === "string" &&
				typeof record.messageText === "string"
			);
		default:
			return false;
	}
}
