/**
 * Session-owned persistence for background jobs.
 *
 * A `BackgroundJobTable` is per-agent, in-memory, and purely synchronous:
 * a job's whole existence ends with the process. That is fine for the work
 * itself - a local job is a promise, and nothing can revive it - but not for
 * the promise the model was given. At t0 the model is told a result "will
 * arrive later as a separate message"; if the runtime exits first, that message
 * never comes and the session resumes with a handle nothing will ever answer.
 *
 * This store is the durable projection that closes it. It never owns job state
 * (the table stays the single source of truth) and never replays work; it
 * records what the model was promised and what it was told, so a resume can ask
 * "which t0 handles are still unanswered?" and settle each one exactly once.
 *
 * Layout: `<sessionDir>/jobs/jobs.jsonl`, append-only, one JSON record per
 * line, same tolerance as the session history - a torn trailing line from a
 * kill is skipped rather than failing the read.
 *
 * Job ids (`job-N`) restart from 1 in every runtime, so they are not a
 * persistent identity. Each record therefore carries the store's `epoch`, a
 * per-open id, and jobs are keyed by `(epoch, jobId)`. That also answers "which
 * jobs belong to a previous run?" without a second bookkeeping structure:
 * anything whose epoch is not the current one ({@link carriedOverJobs}).
 */

import type { FileSystem } from "@earendil-works/pi-agent-core";
import { getFileSystemResultOrThrow } from "@earendil-works/pi-agent-core";
import type {
	BackgroundJobOrigin,
	BackgroundJobSnapshot,
	BackgroundJobStatus,
} from "./job.ts";
import type { BackgroundJobReportSnapshot } from "./report.ts";

/** Directory owning a session's background job artifacts. */
export const BACKGROUND_JOBS_DIR_NAME = "jobs";

/** Append-only lifecycle log inside {@link BACKGROUND_JOBS_DIR_NAME}. */
export const BACKGROUND_JOBS_FILE_NAME = "jobs.jsonl";

/**
 * Cap on the stored t1 text of a settled job: 64 KiB. The text is a message
 * that may be replayed into a session, so it is bounded by what is reasonable
 * to re-inject rather than by what the tool produced.
 */
export const MAX_PERSISTED_JOB_MESSAGE_BYTES = 64 * 1024;

/** Cap on the stored final output tail of a settled job: 32 KiB. */
export const MAX_PERSISTED_JOB_OUTPUT_BYTES = 32 * 1024;

type BackgroundJobStoreFileSystem = Pick<
	FileSystem,
	"joinPath" | "readTextFile" | "appendFile" | "exists" | "createDir"
>;

/** Facts fixed when a job became observable at t0. */
interface PersistedJobIdentity {
	/** Store epoch that owned the job; jobs are keyed by `(epoch, jobId)`. */
	readonly epoch: string;
	/** Runtime-local job handle the model holds from t0. */
	readonly jobId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	/** Short label the caller named the job with, when it named one. */
	readonly name?: string;
	readonly description?: string;
	readonly origin: BackgroundJobOrigin;
	readonly startedAt: number;
	readonly backgroundedAt: number;
}

/** Replayed state of one persisted job. */
export interface PersistedBackgroundJob extends PersistedJobIdentity {
	/** Latest structured report recorded for the job. */
	readonly report?: BackgroundJobReportSnapshot;
	/** True once an abort was requested, whether or not it was confirmed. */
	readonly abortRequested: boolean;
	/** Terminal status; absent when the job never settled on record. */
	readonly status?: BackgroundJobStatus;
	readonly stopReason?: string;
	readonly endedAt?: number;
	/** Rendered t1 text, present once the job settled. */
	readonly messageText?: string;
	/** Bounded final output tail, present once the job settled. */
	readonly outputTail?: string;
}

type BackgroundJobRecord =
	| ({ readonly type: "backgrounded" } & PersistedJobIdentity)
	| {
			readonly type: "report";
			readonly epoch: string;
			readonly jobId: string;
			readonly report: BackgroundJobReportSnapshot;
	  }
	| {
			readonly type: "aborting";
			readonly epoch: string;
			readonly jobId: string;
			readonly at: number;
			readonly stopReason?: string;
	  }
	| {
			readonly type: "settled";
			readonly epoch: string;
			readonly jobId: string;
			readonly status: BackgroundJobStatus;
			readonly stopReason?: string;
			readonly endedAt?: number;
			readonly messageText: string;
			readonly outputTail?: string;
	  };

/** Mutable replay accumulator; copied out as a plain value by the read APIs. */
interface JobState extends PersistedBackgroundJob {
	report?: BackgroundJobReportSnapshot;
	abortRequested: boolean;
	status?: BackgroundJobStatus;
	stopReason?: string;
	endedAt?: number;
	messageText?: string;
	outputTail?: string;
}

export interface BackgroundJobStoreOptions {
	readonly fs: BackgroundJobStoreFileSystem;
	/** Session directory owning the store, from `SessionManager.getAgentSessionDir`. */
	readonly sessionDir: string;
	/** Injectable epoch id. Defaults to a timestamped random id. */
	readonly epoch?: string;
	/**
	 * Notified for the first write failure only. A store that cannot write is
	 * degraded, not fatal: the runtime keeps running jobs and keeps trying, but
	 * the caller must be able to say so once instead of silently losing records.
	 */
	readonly onWriteFailure?: (error: unknown) => void;
}

export class BackgroundJobStore {
	private readonly _fs: BackgroundJobStoreFileSystem;
	private readonly _dirPath: string;
	private readonly _filePath: string;
	private readonly _epoch: string;
	private readonly _onWriteFailure?: (error: unknown) => void;
	private readonly _jobs = new Map<string, JobState>();
	private readonly _order: string[] = [];
	// Appends are serialized so two settlements in the same tick cannot interleave
	// their lines, and so a caller awaiting a record knows every earlier record
	// already landed.
	private _writes: Promise<void> = Promise.resolve();
	private _dirReady = false;
	private _reportedWriteFailure = false;

	private constructor(options: {
		fs: BackgroundJobStoreFileSystem;
		dirPath: string;
		filePath: string;
		epoch: string;
		onWriteFailure?: (error: unknown) => void;
	}) {
		this._fs = options.fs;
		this._dirPath = options.dirPath;
		this._filePath = options.filePath;
		this._epoch = options.epoch;
		this._onWriteFailure = options.onWriteFailure;
	}

	/**
	 * Open the store for a session directory and replay whatever previous runs
	 * left there. Creates nothing on disk: a session whose agent never
	 * backgrounds a job never grows a jobs directory.
	 */
	static async open(
		options: BackgroundJobStoreOptions,
	): Promise<BackgroundJobStore> {
		const dirPath = getFileSystemResultOrThrow(
			await options.fs.joinPath([options.sessionDir, BACKGROUND_JOBS_DIR_NAME]),
			`Failed to resolve background job directory in ${options.sessionDir}`,
		);
		const filePath = getFileSystemResultOrThrow(
			await options.fs.joinPath([dirPath, BACKGROUND_JOBS_FILE_NAME]),
			`Failed to resolve background job log in ${dirPath}`,
		);
		const store = new BackgroundJobStore({
			fs: options.fs,
			dirPath,
			filePath,
			epoch: options.epoch ?? createEpochId(),
			onWriteFailure: options.onWriteFailure,
		});
		await store._replay();
		return store;
	}

	/** Id stamped on every record written by this open. */
	get epoch(): string {
		return this._epoch;
	}

	/** Every job on record, oldest first, across all epochs. */
	history(): PersistedBackgroundJob[] {
		return this._order
			.map((key) => this._jobs.get(key))
			.filter((job): job is JobState => job !== undefined)
			.map(toPersistedJob);
	}

	/**
	 * Jobs recorded by an earlier run of this session: exactly the t0 handles
	 * whose owning table no longer exists. Whether each still owes the model a
	 * message is not decided here - the session history is the authority on what
	 * the model was actually told.
	 */
	carriedOverJobs(): PersistedBackgroundJob[] {
		return this.history().filter((job) => job.epoch !== this._epoch);
	}

	/** Record a job becoming observable at t0. */
	async recordBackgrounded(snapshot: BackgroundJobSnapshot): Promise<void> {
		await this._write({
			type: "backgrounded",
			epoch: this._epoch,
			jobId: snapshot.jobId,
			toolCallId: snapshot.toolCallId,
			toolName: snapshot.toolName,
			...(snapshot.name === undefined ? undefined : { name: snapshot.name }),
			...(snapshot.description === undefined
				? undefined
				: { description: snapshot.description }),
			origin: snapshot.origin,
			startedAt: snapshot.startedAt,
			backgroundedAt: snapshot.backgroundedAt ?? snapshot.startedAt,
		});
	}

	/** Record the latest structured report of a live job. */
	async recordReport(
		jobId: string,
		report: BackgroundJobReportSnapshot,
	): Promise<void> {
		await this._write({
			type: "report",
			epoch: this._epoch,
			jobId,
			report,
		});
	}

	/** Record that an abort was requested for a job. */
	async recordAborting(snapshot: BackgroundJobSnapshot): Promise<void> {
		await this._write({
			type: "aborting",
			epoch: this._epoch,
			jobId: snapshot.jobId,
			at: Date.now(),
			...(snapshot.stopReason === undefined
				? undefined
				: { stopReason: snapshot.stopReason }),
		});
	}

	/**
	 * Record a job's terminal outcome together with the exact t1 text it settled
	 * into. Storing the rendered message rather than the tool result keeps replay
	 * free of tool-specific detail shapes and bounded in size.
	 */
	async recordSettled(
		snapshot: BackgroundJobSnapshot,
		outcome: { readonly messageText: string; readonly outputTail?: string },
	): Promise<void> {
		const outputTail =
			outcome.outputTail === undefined || outcome.outputTail.length === 0
				? undefined
				: keepTail(outcome.outputTail, MAX_PERSISTED_JOB_OUTPUT_BYTES);
		await this._write({
			type: "settled",
			epoch: this._epoch,
			jobId: snapshot.jobId,
			status: snapshot.status ?? "completed",
			...(snapshot.stopReason === undefined
				? undefined
				: { stopReason: snapshot.stopReason }),
			...(snapshot.endedAt === undefined
				? undefined
				: { endedAt: snapshot.endedAt }),
			messageText: keepHead(
				outcome.messageText,
				MAX_PERSISTED_JOB_MESSAGE_BYTES,
			),
			...(outputTail === undefined ? undefined : { outputTail }),
		});
	}

	private async _replay(): Promise<void> {
		const exists = await this._fs.exists(this._filePath);
		if (!exists.ok || !exists.value) return;
		const read = await this._fs.readTextFile(this._filePath);
		if (!read.ok) return;
		for (const line of read.value.split("\n")) {
			if (line.trim().length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				// A torn trailing line is the expected shape of a killed runtime, and
				// a corrupt middle line loses one fact rather than the whole log.
				continue;
			}
			if (isBackgroundJobRecord(parsed)) this._apply(parsed);
		}
	}

	private _apply(record: BackgroundJobRecord): void {
		const key = `${record.epoch} ${record.jobId}`;
		if (record.type === "backgrounded") {
			if (!this._jobs.has(key)) this._order.push(key);
			this._jobs.set(key, {
				epoch: record.epoch,
				jobId: record.jobId,
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
		// Every other record refines a job that must already have a t0 head. One
		// without it is unusable on its own, so it is dropped rather than
		// materializing a job whose identity nobody recorded.
		const job = this._jobs.get(key);
		if (!job) return;
		switch (record.type) {
			case "report":
				job.report = record.report;
				return;
			case "aborting":
				job.abortRequested = true;
				job.stopReason ??= record.stopReason;
				return;
			case "settled":
				job.status = record.status;
				job.stopReason = record.stopReason ?? job.stopReason;
				job.endedAt = record.endedAt;
				job.messageText = record.messageText;
				job.outputTail = record.outputTail;
				return;
		}
	}

	private _write(record: BackgroundJobRecord): Promise<void> {
		this._apply(record);
		const next = this._writes.then(() => this._appendRecord(record));
		this._writes = next;
		return next;
	}

	// Never rejects: a failed write is reported once and the in-memory replay
	// state stays authoritative for this run, so a degraded store cannot break
	// job delivery or the caller's ordering.
	private async _appendRecord(record: BackgroundJobRecord): Promise<void> {
		try {
			if (!this._dirReady) {
				const created = await this._fs.createDir(this._dirPath, {
					recursive: true,
				});
				if (!created.ok) throw new Error(created.error.message);
				this._dirReady = true;
			}
			const appended = await this._fs.appendFile(
				this._filePath,
				`${JSON.stringify(record)}\n`,
			);
			if (!appended.ok) throw new Error(appended.error.message);
		} catch (error) {
			if (this._reportedWriteFailure) return;
			this._reportedWriteFailure = true;
			this._onWriteFailure?.(error);
		}
	}
}

function toPersistedJob(job: JobState): PersistedBackgroundJob {
	return { ...job };
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

function isBackgroundJobRecord(value: unknown): value is BackgroundJobRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<BackgroundJobRecord>;
	if (typeof record.epoch !== "string" || typeof record.jobId !== "string") {
		return false;
	}
	switch (record.type) {
		case "backgrounded":
			return (
				typeof record.toolCallId === "string" &&
				typeof record.toolName === "string" &&
				typeof record.startedAt === "number" &&
				typeof record.backgroundedAt === "number" &&
				typeof record.origin === "object" &&
				record.origin !== null
			);
		case "report":
			return typeof record.report === "object" && record.report !== null;
		case "aborting":
			return true;
		case "settled":
			return (
				typeof record.status === "string" &&
				typeof record.messageText === "string"
			);
		default:
			return false;
	}
}
