import type {
	FileError,
	FileSystem,
	SessionForkOptions,
	SessionStorage,
	SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
	Session,
	SessionError,
	toError,
	uuidv7,
} from "@earendil-works/pi-agent-core";
import {
	type ExtendedJsonlSessionMetadata,
	type JsonlSessionHeaderMetadata,
	JsonlSessionStorage,
	loadJsonlSessionMetadata,
} from "./jsonl-storage.ts";

export type JsonlSessionPathLayout = "by-cwd" | "flat";
export type {
	ExtendedJsonlSessionMetadata,
	JsonlSessionHeaderMetadata,
} from "./jsonl-storage.ts";

export interface ExtendedJsonlSessionCreateOptions {
	id?: string;
	cwd: string;
	parentSessionPath?: string;
	metadata?: JsonlSessionHeaderMetadata;
}

export interface ExtendedJsonlSessionListOptions {
	cwd?: string;
}

type JsonlSessionRepoFileSystem = Pick<
	FileSystem,
	| "cwd"
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

function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function createTimestamp(): string {
	return new Date().toISOString();
}

function getFileSystemResultOrThrow<TValue>(
	result: { ok: true; value: TValue } | { ok: false; error: FileError },
	message: string,
): TValue {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(
			code,
			`${message}: ${result.error.message}`,
			result.error,
		);
	}
	return result.value;
}

async function getEntriesToFork(
	storage: SessionStorage,
	options: { entryId?: string; position?: "before" | "at" },
): Promise<SessionTreeEntry[]> {
	if (!options.entryId) return storage.getEntries();
	const target = await storage.getEntry(options.entryId);
	if (!target) {
		throw new SessionError(
			"invalid_fork_target",
			`Entry ${options.entryId} not found`,
		);
	}
	if ((options.position ?? "before") === "at") {
		return storage.getPathToRoot(target.id);
	}
	if (target.type !== "message" || target.message.role !== "user") {
		throw new SessionError(
			"invalid_fork_target",
			`Entry ${options.entryId} is not a user message`,
		);
	}
	return storage.getPathToRoot(target.parentId);
}

export class JsonlSessionRepo {
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly sessionsRootInput: string;
	private readonly pathLayout: JsonlSessionPathLayout;
	private sessionsRoot: string | undefined;

	constructor(options: {
		fs: JsonlSessionRepoFileSystem;
		sessionsRoot: string;
		pathLayout?: JsonlSessionPathLayout;
	}) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
		this.pathLayout = options.pathLayout ?? "by-cwd";
	}

	private async getSessionsRoot(): Promise<string> {
		if (!this.sessionsRoot) {
			this.sessionsRoot = getFileSystemResultOrThrow(
				await this.fs.absolutePath(this.sessionsRootInput),
				`Failed to resolve sessions root ${this.sessionsRootInput}`,
			);
		}
		return this.sessionsRoot;
	}

	private async getSessionDir(cwd: string): Promise<string> {
		if (this.pathLayout === "flat") {
			return await this.getSessionsRoot();
		}

		return getFileSystemResultOrThrow(
			await this.fs.joinPath([await this.getSessionsRoot(), encodeCwd(cwd)]),
			`Failed to resolve session directory for ${cwd}`,
		);
	}

	private async createSessionFilePath(
		cwd: string,
		sessionId: string,
		timestamp: string,
	): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([
				await this.getSessionDir(cwd),
				`${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
			]),
			`Failed to resolve session file path for ${sessionId}`,
		);
	}

	async create(
		options: ExtendedJsonlSessionCreateOptions,
	): Promise<Session<ExtendedJsonlSessionMetadata>> {
		const id = options.id ?? uuidv7();
		const createdAt = createTimestamp();
		const sessionDir = await this.getSessionDir(options.cwd);
		getFileSystemResultOrThrow(
			await this.fs.createDir(sessionDir, { recursive: true }),
			`Failed to create session directory ${sessionDir}`,
		);
		const filePath = await this.createSessionFilePath(
			options.cwd,
			id,
			createdAt,
		);
		const storage = await JsonlSessionStorage.create(this.fs, filePath, {
			cwd: options.cwd,
			sessionId: id,
			parentSessionPath: options.parentSessionPath,
			metadata: options.metadata,
		});
		return new Session(storage);
	}

	async open(
		metadata: ExtendedJsonlSessionMetadata,
	): Promise<Session<ExtendedJsonlSessionMetadata>> {
		if (
			!getFileSystemResultOrThrow(
				await this.fs.exists(metadata.path),
				`Failed to check session ${metadata.path}`,
			)
		) {
			throw new SessionError(
				"not_found",
				`Session not found: ${metadata.path}`,
			);
		}
		const storage = await JsonlSessionStorage.open(this.fs, metadata.path);
		return new Session(storage);
	}

	async list(
		options: ExtendedJsonlSessionListOptions = {},
	): Promise<ExtendedJsonlSessionMetadata[]> {
		const dirs = options.cwd
			? [await this.getSessionDir(options.cwd)]
			: await this.listSessionDirs();
		const sessions: ExtendedJsonlSessionMetadata[] = [];
		for (const dir of dirs) {
			if (
				!getFileSystemResultOrThrow(
					await this.fs.exists(dir),
					`Failed to check session directory ${dir}`,
				)
			) {
				continue;
			}
			const files = getFileSystemResultOrThrow(
				await this.fs.listDir(dir),
				`Failed to list sessions in ${dir}`,
			).filter(
				(file) => file.kind !== "directory" && file.name.endsWith(".jsonl"),
			);
			for (const file of files) {
				try {
					sessions.push(await loadJsonlSessionMetadata(this.fs, file.path));
				} catch (error) {
					const cause = toError(error);
					if (
						!(cause instanceof SessionError) ||
						cause.code !== "invalid_session"
					)
						throw cause;
				}
			}
		}
		sessions.sort(
			(a, b) =>
				new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
		);
		return sessions;
	}

	async delete(metadata: ExtendedJsonlSessionMetadata): Promise<void> {
		getFileSystemResultOrThrow(
			await this.fs.remove(metadata.path, { force: true }),
			`Failed to delete session ${metadata.path}`,
		);
	}

	async fork(
		sourceMetadata: ExtendedJsonlSessionMetadata,
		options: ExtendedJsonlSessionCreateOptions & SessionForkOptions,
	): Promise<Session<ExtendedJsonlSessionMetadata>> {
		const source = await this.open(sourceMetadata);
		const forkedEntries = await getEntriesToFork(source.getStorage(), options);
		const id = options.id ?? uuidv7();
		const createdAt = createTimestamp();
		const sessionDir = await this.getSessionDir(options.cwd);
		getFileSystemResultOrThrow(
			await this.fs.createDir(sessionDir, { recursive: true }),
			`Failed to create session directory ${sessionDir}`,
		);
		const storage = await JsonlSessionStorage.create(
			this.fs,
			await this.createSessionFilePath(options.cwd, id, createdAt),
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
		return new Session(storage);
	}

	private async listSessionDirs(): Promise<string[]> {
		const sessionsRoot = await this.getSessionsRoot();
		if (
			!getFileSystemResultOrThrow(
				await this.fs.exists(sessionsRoot),
				`Failed to check sessions root ${sessionsRoot}`,
			)
		) {
			return [];
		}
		const entries = getFileSystemResultOrThrow(
			await this.fs.listDir(sessionsRoot),
			`Failed to list sessions root ${sessionsRoot}`,
		);
		return entries
			.filter((entry) => entry.kind === "directory")
			.map((entry) => entry.path);
	}
}
