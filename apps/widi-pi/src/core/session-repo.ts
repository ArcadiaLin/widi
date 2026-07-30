/**
 * SessionDirectoryRepo gives every persisted session its own directory instead
 * of a bare JSONL file, so a session can own more than its conversation
 * history: setting overrides, background job state, and extension storage all
 * belong under the same path and disappear with it when the session is deleted.
 *
 * Layout: <sessionsRoot>/<encoded-cwd>/<timestamp>_<sessionId>/session.jsonl
 *
 * The history file itself is unchanged. pi's JsonlSessionStorage is
 * file-addressed and blind to the surrounding layout, so only path
 * construction, listing, and deletion differ from pi's JsonlSessionRepo.
 * `JsonlSessionMetadata.path` keeps pointing at the JSONL file; the session
 * directory is its parent, via {@link sessionDirPath}.
 */

import type {
	FileSystem,
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionRepoApi,
	Session,
} from "@widi/agent-core";
import {
	createSessionId,
	createTimestamp,
	getEntriesToFork,
	getFileSystemResultOrThrow,
	JsonlSessionStorage,
	loadJsonlSessionMetadata,
	SessionError,
	toError,
	toSession,
} from "@widi/agent-core";

/** History file name inside a session directory. */
export const SESSION_FILE_NAME = "session.jsonl";

type SessionDirectoryRepoFileSystem = Pick<
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
 * Directory owning every persisted artifact of a session, given the path of its
 * history file. Session files are always repo-created, so they always sit in
 * such a directory.
 */
export function sessionDirPath(sessionFilePath: string): string {
	const separator = Math.max(
		sessionFilePath.lastIndexOf("/"),
		sessionFilePath.lastIndexOf("\\"),
	);
	return separator <= 0 ? "/" : sessionFilePath.slice(0, separator);
}

// Sessions are grouped per project, and a cwd is not a legal path segment.
function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

// Directory names sort chronologically and stay recognizable when browsed.
function sessionDirName(sessionId: string, timestamp: string): string {
	return `${timestamp.replace(/[:.]/g, "-")}_${sessionId}`;
}

export class SessionDirectoryRepo implements JsonlSessionRepoApi {
	private readonly fs: SessionDirectoryRepoFileSystem;
	private readonly sessionsRootInput: string;
	private sessionsRoot: string | undefined;

	constructor(options: {
		fs: SessionDirectoryRepoFileSystem;
		sessionsRoot: string;
	}) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
	}

	async create(
		options: JsonlSessionCreateOptions,
	): Promise<Session<JsonlSessionMetadata>> {
		const id = options.id ?? createSessionId();
		const storage = await JsonlSessionStorage.create(
			this.fs,
			await this._createSessionFilePath(options.cwd, id, createTimestamp()),
			{
				cwd: options.cwd,
				sessionId: id,
				parentSessionPath: options.parentSessionPath,
				metadata: options.metadata,
			},
		);
		return toSession(storage);
	}

	async open(
		metadata: JsonlSessionMetadata,
	): Promise<Session<JsonlSessionMetadata>> {
		const exists = getFileSystemResultOrThrow(
			await this.fs.exists(metadata.path),
			`Failed to check session ${metadata.path}`,
		);
		if (!exists) {
			throw new SessionError(
				"not_found",
				`Session not found: ${metadata.path}`,
			);
		}
		return toSession(await JsonlSessionStorage.open(this.fs, metadata.path));
	}

	async list(
		options: JsonlSessionListOptions = {},
	): Promise<JsonlSessionMetadata[]> {
		const cwdDirs = options.cwd
			? [await this._getCwdDir(options.cwd)]
			: await this._listCwdDirs();
		const sessions: JsonlSessionMetadata[] = [];
		for (const cwdDir of cwdDirs) {
			for (const sessionDir of await this._listChildDirs(cwdDir)) {
				const filePath = await this._joinPath(
					[sessionDir, SESSION_FILE_NAME],
					`Failed to resolve session file in ${sessionDir}`,
				);
				const exists = getFileSystemResultOrThrow(
					await this.fs.exists(filePath),
					`Failed to check session ${filePath}`,
				);
				if (!exists) continue;
				try {
					sessions.push(await loadJsonlSessionMetadata(this.fs, filePath));
				} catch (error) {
					const cause = toError(error);
					if (
						!(cause instanceof SessionError) ||
						cause.code !== "invalid_session"
					) {
						throw cause;
					}
				}
			}
		}
		sessions.sort(
			(a, b) =>
				new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
		);
		return sessions;
	}

	/** Deletes the whole session directory: history plus every session-owned artifact. */
	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		const dir = sessionDirPath(metadata.path);
		getFileSystemResultOrThrow(
			await this.fs.remove(dir, { recursive: true, force: true }),
			`Failed to delete session ${dir}`,
		);
	}

	/**
	 * Forks the conversation history only. Other session-owned artifacts carry
	 * per-kind semantics the repo cannot decide for, so the new session starts
	 * with an otherwise empty directory.
	 */
	async fork(
		sourceMetadata: JsonlSessionMetadata,
		options: JsonlSessionCreateOptions & {
			entryId?: string;
			position?: "before" | "at";
			id?: string;
		},
	): Promise<Session<JsonlSessionMetadata>> {
		const source = await this.open(sourceMetadata);
		const forkedEntries = await getEntriesToFork(source.getStorage(), options);
		const id = options.id ?? createSessionId();
		const storage = await JsonlSessionStorage.create(
			this.fs,
			await this._createSessionFilePath(options.cwd, id, createTimestamp()),
			{
				cwd: options.cwd,
				sessionId: id,
				parentSessionPath: options.parentSessionPath ?? sourceMetadata.path,
				metadata: options.metadata ?? sourceMetadata.metadata,
			},
		);
		for (const entry of forkedEntries) {
			await storage.appendEntry(entry);
		}
		return toSession(storage);
	}

	private async _getSessionsRoot(): Promise<string> {
		if (!this.sessionsRoot) {
			this.sessionsRoot = getFileSystemResultOrThrow(
				await this.fs.absolutePath(this.sessionsRootInput),
				`Failed to resolve sessions root ${this.sessionsRootInput}`,
			);
		}
		return this.sessionsRoot;
	}

	private async _getCwdDir(cwd: string): Promise<string> {
		return await this._joinPath(
			[await this._getSessionsRoot(), encodeCwd(cwd)],
			`Failed to resolve session directory for ${cwd}`,
		);
	}

	private async _createSessionFilePath(
		cwd: string,
		sessionId: string,
		timestamp: string,
	): Promise<string> {
		const dir = await this._joinPath(
			[await this._getCwdDir(cwd), sessionDirName(sessionId, timestamp)],
			`Failed to resolve session directory for ${sessionId}`,
		);
		getFileSystemResultOrThrow(
			await this.fs.createDir(dir, { recursive: true }),
			`Failed to create session directory ${dir}`,
		);
		return await this._joinPath(
			[dir, SESSION_FILE_NAME],
			`Failed to resolve session file path for ${sessionId}`,
		);
	}

	private async _listCwdDirs(): Promise<string[]> {
		return await this._listChildDirs(await this._getSessionsRoot());
	}

	private async _listChildDirs(dir: string): Promise<string[]> {
		const exists = getFileSystemResultOrThrow(
			await this.fs.exists(dir),
			`Failed to check session directory ${dir}`,
		);
		if (!exists) return [];
		return getFileSystemResultOrThrow(
			await this.fs.listDir(dir),
			`Failed to list sessions in ${dir}`,
		)
			.filter((entry) => entry.kind === "directory")
			.map((entry) => entry.path);
	}

	private async _joinPath(parts: string[], message: string): Promise<string> {
		return getFileSystemResultOrThrow(await this.fs.joinPath(parts), message);
	}
}
