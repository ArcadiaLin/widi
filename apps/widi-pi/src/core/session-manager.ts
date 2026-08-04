/**
 * SessionManager owns session repositories used by AgentOrchestrator.
 *
 * Persistent sessions use pi-agent-core JSONL storage, laid out one directory
 * per session by SessionDirectoryRepo so a session can own artifacts beyond its
 * conversation history. WIDI stores profile references in the JSONL session
 * header metadata so resume can rebuild harness context.
 */

import { randomUUID } from "node:crypto";
import type {
	AgentMessage,
	FileError,
	FileSystem,
	JsonlSessionMetadata,
	Session,
	SessionContext,
	SessionForkOptions,
	SessionMetadata,
	SessionTreeEntry,
} from "@widi/agent-core";
import { buildSessionContext, InMemorySessionStore, toSession } from "@widi/agent-core";
import { formatError } from "../utils/errors.ts";
import type { AgentProfile, AgentProfileReference } from "./agent-profile.js";
import { parseAgentProfileReference, toAgentProfileReference } from "./agent-profile.js";
import type { ExtensionInputPresentation, ExtensionMessage } from "./extension/presentation.ts";
import { SessionDirectoryRepo, sessionDirPath } from "./session-repo.ts";
import type { AgentId } from "./types.ts";

export type AgentSessionMetadata = SessionMetadata | JsonlSessionMetadata;

export interface AgentExtensionCustomEntry<T = unknown> {
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
	data?: T;
}

// Core-owned custom entry recording the pre-expansion input of an inline
// command expansion. The user message stores the expanded text (the model's
// factual context); this entry preserves the original input and expansion
// positions for UI replay.
export const COMMAND_EXPANSION_CUSTOM_TYPE = "core:command_expansion";

export interface CommandExpansionEntryData {
	readonly inputId: string;
	readonly originalText: string;
	readonly expansions: ReadonlyArray<{
		readonly commandId: string;
		readonly name: string;
		readonly trigger: string;
		readonly argument: string;
		readonly start: number;
		readonly end: number;
	}>;
}

// Core-owned custom entry recording an extension input rewrite (ME slice 7).
// Same dual-record discipline as command expansion: the session only carries
// the rewritten text the model saw, so the human's original input must stay
// recoverable after resume. Blocked input writes nothing - it never reached
// the model and left no session state to explain.
export const INPUT_TRANSFORM_CUSTOM_TYPE = "core:input_transform";

export interface InputTransformEntryData {
	readonly inputId: string;
	readonly originalText: string;
	readonly text: string;
	readonly transformedBy: readonly string[];
}

// Core-owned custom entry persisting an extension's published presentation
// message. It never becomes model context; the entry id is the stable
// identity consumers dedupe on between live events and hydration.
export const EXTENSION_MESSAGE_CUSTOM_TYPE = "core:extension_message";

export interface ExtensionMessageEntryData {
	readonly extensionId: string;
	readonly message: ExtensionMessage;
}

// Core-owned custom entry recording how a client should render a message an
// extension sent into the agent. The user message carries the model-facing
// text; this entry is appended after that message and names its stable entry
// id, so hydration never depends on adjacency.
export const EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE = "core:extension_input_presentation";

export interface ExtensionInputPresentationEntryData {
	readonly messageEntryId: string;
	readonly extensionId: string;
	readonly presentation: ExtensionInputPresentation;
}

export interface AgentSessionCandidate {
	readonly id: string;
	readonly path: string;
	readonly createdAt: string;
	readonly cwd: string;
	readonly parentSessionPath?: string;
	readonly profile?: AgentProfileReference;
	/** Latest session_info name, when the user named the session. */
	readonly name?: string;
	/** First non-empty line of the first user message. */
	readonly firstUserMessage?: string;
}

export interface AgentSessionSnapshot {
	readonly metadata: AgentSessionMetadata;
	readonly name?: string;
	readonly leafId: string | null;
	readonly pathToRoot: readonly SessionTreeEntry[];
}

export interface AgentSessionTreeSnapshot extends AgentSessionSnapshot {
	readonly entries: readonly SessionTreeEntry[];
}

export interface ForkAgentSessionOptions {
	readonly entryId?: string;
	readonly position?: SessionForkOptions["position"];
}

export type AgentSessionResolutionFailureReason = "not_found" | "ambiguous";

export class AgentSessionResolutionError extends Error {
	readonly reason: AgentSessionResolutionFailureReason;
	readonly reference: string;
	readonly candidates: readonly AgentSessionCandidate[];

	constructor(options: {
		readonly reason: AgentSessionResolutionFailureReason;
		readonly reference: string;
		readonly candidates: readonly AgentSessionCandidate[];
	}) {
		const message =
			options.reason === "ambiguous"
				? `Ambiguous agent session reference: ${options.reference}`
				: `Agent session not found: ${options.reference}`;
		super(message);
		this.name = "AgentSessionResolutionError";
		this.reason = options.reason;
		this.reference = options.reference;
		this.candidates = [...options.candidates];
	}
}

export interface SessionManagerConfigs {
	fs: FileSystem;
	cwd: string;
	sessionsRoot: string;
}

type CreateAgentSessionOptions = { agentId: AgentId; agentProfile: AgentProfile; parentSessionPath?: string };

type ResumeAgentSessionOptions = { agentId: AgentId; metadata: JsonlSessionMetadata };

export class SessionManager {
	readonly sessionRepo: SessionDirectoryRepo;
	private readonly _fs: FileSystem;
	private readonly _cwd: string;
	private readonly _agentSessions: Map<AgentId, Session<AgentSessionMetadata>> = new Map();
	/** Runtime AgentId to persisted session directory name. */
	private readonly _agentSessionDirs = new Map<AgentId, string>();
	// Held as a store rather than through pi's SessionRepo: the repo now hands
	// back a snapshot-backed Session that reloads the whole session on every
	// read. Sessions here are long-lived handles, so they stay bound to the
	// stateful storage the store already keeps.
	private readonly _memorySessionStore: InMemorySessionStore = new InMemorySessionStore();
	// Opaque session handles for consumers that must not see filesystem paths.
	private readonly _sessionHandlesByPath: Map<string, string> = new Map();
	private readonly _sessionPathsByHandle: Map<string, string> = new Map();

	constructor(config: SessionManagerConfigs) {
		this._fs = config.fs;
		this._cwd = config.cwd;
		this.sessionRepo = new SessionDirectoryRepo({ fs: config.fs, sessionsRoot: config.sessionsRoot });
	}

	async listAgentSessionCandidates(): Promise<AgentSessionCandidate[]> {
		const sessions = await this.sessionRepo.list({ cwd: this._cwd });
		return await Promise.all(
			sessions.map(async (metadata) => ({
				...toAgentSessionCandidate(metadata),
				...(await this._loadSessionDisplayFacts(metadata.path)),
			})),
		);
	}

	// Resume pickers need more than header metadata to make a session
	// recognizable: the latest session_info name and the first user message.
	// Unreadable files or lines degrade to header-only facts.
	private async _loadSessionDisplayFacts(path: string): Promise<{ name?: string; firstUserMessage?: string }> {
		const read = await this._fs.readTextFile(path);
		if (!read.ok) return {};
		const facts: { name?: string; firstUserMessage?: string } = {};
		for (const line of read.value.split("\n")) {
			// Cheap substring gate so only relevant lines pay for JSON.parse.
			const wantsMessage = facts.firstUserMessage === undefined && line.includes('"message"');
			const wantsName = line.includes('"session_info"');
			if (!wantsMessage && !wantsName) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof entry !== "object" || entry === null) continue;
			const typed = entry as { type?: unknown; name?: unknown; message?: { role?: unknown; content?: unknown } };
			if (typed.type === "session_info" && typeof typed.name === "string") {
				facts.name = typed.name.trim() || undefined;
				continue;
			}
			if (wantsMessage && typed.type === "message" && typed.message?.role === "user") {
				facts.firstUserMessage = userMessageHeadline(typed.message.content);
			}
		}
		return facts;
	}

	async resolveAgentSessionReference(reference: string): Promise<JsonlSessionMetadata> {
		const normalized = reference.trim();
		if (!normalized) {
			throw new AgentSessionResolutionError({ reason: "not_found", reference, candidates: [] });
		}

		const sessions = await this.sessionRepo.list({ cwd: this._cwd });
		const absoluteReference = fileSystemValueOrThrow(
			await this._fs.absolutePath(normalized),
			`Failed to resolve session reference ${normalized}`,
		);
		const pathMatches = sessions.filter((session) => session.path === normalized || session.path === absoluteReference);
		if (pathMatches.length === 1) return pathMatches[0];
		if (pathMatches.length > 1) {
			throw new AgentSessionResolutionError({
				reason: "ambiguous",
				reference: normalized,
				candidates: pathMatches.map(toAgentSessionCandidate),
			});
		}

		const idMatches = sessions.filter((session) => session.id === normalized);
		if (idMatches.length === 1) return idMatches[0];
		if (idMatches.length > 1) {
			throw new AgentSessionResolutionError({
				reason: "ambiguous",
				reference: normalized,
				candidates: idMatches.map(toAgentSessionCandidate),
			});
		}

		throw new AgentSessionResolutionError({ reason: "not_found", reference: normalized, candidates: [] });
	}

	async createAgentSession(options: CreateAgentSessionOptions): Promise<Session<AgentSessionMetadata>> {
		const cachedSession = this._agentSessions.get(options.agentId);
		if (cachedSession) {
			return cachedSession;
		}

		const session = options.agentProfile.persist
			? await this._createPersistentAgentSession(options)
			: await this._createEphemeralAgentSession(options.agentId);
		this._agentSessions.set(options.agentId, session);
		await this._rememberAgentSessionDir(options.agentId, session);
		return session;
	}

	async resumeAgentSession(options: ResumeAgentSessionOptions): Promise<Session<AgentSessionMetadata>> {
		const cachedSession = this._agentSessions.get(options.agentId);
		if (cachedSession) {
			return cachedSession;
		}
		const session = await this.sessionRepo.open(options.metadata);
		this._agentSessions.set(options.agentId, session);
		this._agentSessionDirs.set(options.agentId, sessionDirNameFromPath(sessionDirPath(options.metadata.path)));
		return session;
	}

	async getAgentSessionSnapshot(agentId: AgentId): Promise<AgentSessionSnapshot> {
		const session = this._requireAgentSession(agentId);
		return await this._snapshotSession(session);
	}

	async getAgentSessionTree(agentId: AgentId): Promise<AgentSessionTreeSnapshot> {
		const session = this._requireAgentSession(agentId);
		return { ...(await this._snapshotSession(session)), entries: await session.getEntries() };
	}

	async buildAgentSessionContext(agentId: AgentId): Promise<SessionContext> {
		const session = this._requireAgentSession(agentId);
		return buildSessionContext(await this._getFullBranch(session));
	}

	async setAgentSessionName(agentId: AgentId, name: string): Promise<AgentSessionSnapshot> {
		const session = this._requireAgentSession(agentId);
		await session.appendSessionName(name);
		return await this._snapshotSession(session);
	}

	async forkAgentSession(agentId: AgentId, options: ForkAgentSessionOptions = {}): Promise<JsonlSessionMetadata> {
		const sourceSession = this._requireAgentSession(agentId);
		const metadata = await sourceSession.getMetadata();
		if (!isJsonlSessionMetadata(metadata)) {
			throw new Error(`Cannot fork ephemeral agent session: ${agentId}`);
		}
		const forkedSession = await this.sessionRepo.fork(metadata, {
			cwd: this._cwd,
			entryId: options.entryId,
			position: options.position,
		});
		const forkedMetadata = await forkedSession.getMetadata();
		this._agentSessions.set(forkedMetadata.id, forkedSession);
		this._agentSessionDirs.set(forkedMetadata.id, sessionDirNameFromPath(sessionDirPath(forkedMetadata.path)));
		return forkedMetadata;
	}

	async getAgentSessionLeafId(agentId: AgentId): Promise<string | null> {
		return await this._requireAgentSession(agentId).getLeafId();
	}

	/**
	 * Resolve the entry written by the harness for a live message event.
	 *
	 * Session append keeps the message object on the in-process entry. Matching
	 * that identity is stable even when the event bridge handles multiple
	 * message_end events concurrently; reading the current leaf is not.
	 */
	async findAgentMessageEntryId(agentId: AgentId, message: AgentMessage): Promise<string | null> {
		const entries = await this._requireAgentSession(agentId).getEntries();
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry?.type === "message" && entry.message === message) {
				return entry.id;
			}
		}
		return null;
	}

	// Directory owning every persisted artifact of an agent's session, for
	// consumers that store more than conversation history. Ephemeral sessions
	// live in memory and have none.
	async getAgentSessionDir(agentId: AgentId): Promise<string | undefined> {
		const metadata = await this._requireAgentSession(agentId).getMetadata();
		return isJsonlSessionMetadata(metadata) ? sessionDirPath(metadata.path) : undefined;
	}

	/** Persisted directory name used by the spawn-tree records. */
	async getAgentSessionDirName(agentId: AgentId): Promise<string | undefined> {
		const remembered = this._agentSessionDirs.get(agentId);
		if (remembered) return remembered;
		const dir = await this.getAgentSessionDir(agentId);
		if (!dir) return undefined;
		const name = sessionDirNameFromPath(dir);
		this._agentSessionDirs.set(agentId, name);
		return name;
	}

	/** Current runtime agent already holding this persisted session, if any. */
	findAgentIdBySessionDir(sessionDir: string): AgentId | undefined {
		for (const [agentId, candidate] of this._agentSessionDirs) {
			if (candidate === sessionDir) return agentId;
		}
		return undefined;
	}

	/** Resolve one persisted session by its directory name, not its reusable id. */
	async resolveAgentSessionByDir(sessionDir: string): Promise<JsonlSessionMetadata> {
		const sessions = await this.sessionRepo.list({ cwd: this._cwd });
		const matches = sessions.filter((metadata) => sessionDirNameFromPath(sessionDirPath(metadata.path)) === sessionDir);
		if (matches.length !== 1) {
			throw new AgentSessionResolutionError({
				reason: matches.length > 1 ? "ambiguous" : "not_found",
				reference: sessionDir,
				candidates: matches.map(toAgentSessionCandidate),
			});
		}
		return matches[0];
	}

	/** Open a session addressed by directory under a runtime-local AgentId. */
	async openSessionByDir(
		sessionDir: string,
		agentId: AgentId,
	): Promise<{ readonly metadata: JsonlSessionMetadata; readonly session: Session<AgentSessionMetadata> }> {
		const metadata = await this.resolveAgentSessionByDir(sessionDir);
		const session = await this.resumeAgentSession({ agentId, metadata });
		return { metadata, session };
	}

	// Retraction for provisional prompt records (expansion/transform entries
	// appended before the harness persists the paired user message). Only
	// rewinds when the branch leaf is still the last provisional entry; if
	// anything landed after it - the user message, a concurrent write - the
	// branch is left untouched.
	async retractAgentSessionEntries(
		agentId: AgentId,
		options: { readonly lastEntryId: string; readonly previousLeafId: string | null },
	): Promise<boolean> {
		const session = this._requireAgentSession(agentId);
		if ((await session.getLeafId()) !== options.lastEntryId) return false;
		await session.moveTo(options.previousLeafId);
		return true;
	}

	async appendCommandExpansionEntry(agentId: AgentId, data: CommandExpansionEntryData): Promise<string> {
		return await this._requireAgentSession(agentId).appendCustomEntry(COMMAND_EXPANSION_CUSTOM_TYPE, data);
	}

	async appendInputTransformEntry(agentId: AgentId, data: InputTransformEntryData): Promise<string> {
		return await this._requireAgentSession(agentId).appendCustomEntry(INPUT_TRANSFORM_CUSTOM_TYPE, data);
	}

	async appendExtensionMessageEntry(agentId: AgentId, data: ExtensionMessageEntryData): Promise<string> {
		return await this._requireAgentSession(agentId).appendCustomEntry(EXTENSION_MESSAGE_CUSTOM_TYPE, data);
	}

	async appendExtensionInputPresentationEntry(
		agentId: AgentId,
		data: ExtensionInputPresentationEntryData,
	): Promise<string> {
		return await this._requireAgentSession(agentId).appendCustomEntry(EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE, data);
	}

	/**
	 * Snapshot any session of the current project, live or historical.
	 *
	 * A reference is a session path or id, resolved by
	 * {@link resolveAgentSessionReference} so an ambiguous id fails loudly
	 * instead of silently picking one. When the reference names a session this
	 * runtime already has open, that live handle answers - opening a second
	 * handle to the same file would read around its unflushed writes.
	 */
	async readSessionSnapshot(reference: string): Promise<AgentSessionTreeSnapshot> {
		const metadata = await this.resolveAgentSessionReference(reference);
		const live = await this._findOpenSession(metadata.path);
		const session = live ?? (await this.sessionRepo.open(metadata));
		return { ...(await this._snapshotSession(session)), entries: await session.getEntries() };
	}

	/**
	 * Mint an opaque handle for a session path, or resolve one back.
	 *
	 * Consumers that must not learn filesystem layout - extensions - address
	 * sessions through these instead of paths. The mapping is runtime-local and
	 * grows only as sessions are listed, so a handle cannot be guessed or
	 * constructed to reach a session the caller was never shown.
	 */
	toSessionHandle(path: string): string {
		const existing = this._sessionHandlesByPath.get(path);
		if (existing) return existing;
		const handle = `session-${randomUUID()}`;
		this._sessionHandlesByPath.set(path, handle);
		this._sessionPathsByHandle.set(handle, path);
		return handle;
	}

	resolveSessionHandle(handle: string): string {
		const path = this._sessionPathsByHandle.get(handle);
		if (!path) {
			throw new Error(`Unknown session handle: ${handle}. Handles come from listing sessions.`);
		}
		return path;
	}

	private async _findOpenSession(path: string): Promise<Session<AgentSessionMetadata> | undefined> {
		for (const session of this._agentSessions.values()) {
			const metadata = await session.getMetadata();
			if (isJsonlSessionMetadata(metadata) && metadata.path === path) {
				return session;
			}
		}
		return undefined;
	}

	async appendExtensionCustomEntry<T = unknown>(
		agentId: AgentId,
		extensionId: string,
		type: string,
		data?: T,
	): Promise<string> {
		const localType = normalizeExtensionCustomType(type);
		assertJsonSerializable(data);
		return await this._requireAgentSession(agentId).appendCustomEntry(
			toPersistedExtensionCustomType(extensionId, localType),
			data,
		);
	}

	async findExtensionCustomEntries<T = unknown>(
		agentId: AgentId,
		extensionId: string,
		type?: string,
	): Promise<AgentExtensionCustomEntry<T>[]> {
		const localType = type === undefined ? undefined : normalizeExtensionCustomType(type);
		const session = this._requireAgentSession(agentId);
		const entries = await this._getFullBranch(session);
		const prefix = toPersistedExtensionCustomTypePrefix(extensionId);
		const result: AgentExtensionCustomEntry<T>[] = [];

		for (const entry of entries) {
			const customEntry = toExtensionCustomEntry<T>(entry, prefix);
			if (!customEntry) continue;
			if (localType !== undefined && customEntry.type !== localType) continue;
			result.push(customEntry);
		}

		return result;
	}

	private async _rememberAgentSessionDir(agentId: AgentId, session: Session<AgentSessionMetadata>): Promise<void> {
		const metadata = await session.getMetadata();
		if (!isJsonlSessionMetadata(metadata)) return;
		this._agentSessionDirs.set(agentId, sessionDirNameFromPath(sessionDirPath(metadata.path)));
	}

	private async _createPersistentAgentSession(
		options: CreateAgentSessionOptions,
	): Promise<Session<JsonlSessionMetadata>> {
		// Persistent JSONL sessions currently follow the M2 single-process storage
		// boundary. Without an ExecutionEnv lock/transaction primitive, multiple
		// WIDI processes writing the same sessionsRoot are unsupported.
		// TODO: Add extension persistence once extension lifecycle and storage boundaries are defined.
		// The session id deliberately equals the creating agent's id: resume
		// restores the agent under it (_resumeAgentHarness). It is unique only
		// within one runtime — across runs it repeats, so consumers resolving a
		// session must reference it by path, never by bare id.
		return this.sessionRepo.create({
			id: options.agentId,
			cwd: this._cwd,
			parentSessionPath: options.parentSessionPath,
			metadata: { profile: toAgentProfileReference(options.agentProfile) },
		});
	}

	private async _createEphemeralAgentSession(agentId: AgentId): Promise<Session<SessionMetadata>> {
		const metadata = await this._memorySessionStore.create({ id: agentId });
		return toSession(await this._memorySessionStore.open(metadata));
	}

	private _requireAgentSession(agentId: AgentId): Session<AgentSessionMetadata> {
		const session = this._agentSessions.get(agentId);
		if (!session) {
			throw new Error(`Unknown agent session: ${agentId}`);
		}
		return session;
	}

	// pi-agent-core's public branch is compaction-aware and may start at a
	// retained-tail checkpoint. WIDI still needs the complete active path for
	// timeline hydration, extension state, and durable runtime configuration.
	private async _getFullBranch(session: Session<AgentSessionMetadata>): Promise<SessionTreeEntry[]> {
		const entries: SessionTreeEntry[] = [];
		const visited = new Set<string>();
		let entryId = await session.getLeafId();
		while (entryId !== null) {
			if (visited.has(entryId)) {
				throw new Error(`Invalid agent session: cycle at entry ${entryId}.`);
			}
			visited.add(entryId);
			const entry = await session.getEntry(entryId);
			if (!entry) {
				throw new Error(`Invalid agent session: entry ${entryId} not found.`);
			}
			entries.unshift(entry);
			entryId = entry.parentId;
		}
		return entries;
	}

	private async _snapshotSession(session: Session<AgentSessionMetadata>): Promise<AgentSessionSnapshot> {
		return {
			metadata: await session.getMetadata(),
			name: await session.getSessionName(),
			leafId: await session.getLeafId(),
			pathToRoot: await this._getFullBranch(session),
		};
	}
}

function isJsonlSessionMetadata(metadata: AgentSessionMetadata): metadata is JsonlSessionMetadata {
	return (
		"path" in metadata && typeof metadata.path === "string" && "cwd" in metadata && typeof metadata.cwd === "string"
	);
}

function fileSystemValueOrThrow<TValue>(
	result: { ok: true; value: TValue } | { ok: false; error: FileError },
	message: string,
): TValue {
	if (!result.ok) {
		throw new Error(`${message}: ${result.error.message}`);
	}
	return result.value;
}

function toAgentSessionCandidate(metadata: JsonlSessionMetadata): AgentSessionCandidate {
	return {
		id: metadata.id,
		path: metadata.path,
		createdAt: metadata.createdAt,
		cwd: metadata.cwd,
		parentSessionPath: metadata.parentSessionPath,
		profile: parseAgentProfileReference(metadata.metadata?.profile),
	};
}

/** The persisted directory name of a session, as the tree records address it. */
export function sessionDirNameFromPath(path: string): string {
	const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return separator < 0 ? path : path.slice(separator + 1);
}

// The first non-empty line of a user message, bounded for list display.
function userMessageHeadline(content: unknown): string | undefined {
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter(
							(part): part is { type: "text"; text: string } =>
								typeof part === "object" &&
								part !== null &&
								"type" in part &&
								part.type === "text" &&
								"text" in part &&
								typeof part.text === "string",
						)
						.map((part) => part.text)
						.join(" ")
				: "";
	const line = text
		.split("\n")
		.find((candidate) => candidate.trim() !== "")
		?.trim();
	if (!line) return undefined;
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

const EXTENSION_CUSTOM_TYPE_PATTERN = /^[a-zA-Z0-9._:-]+$/;

function normalizeExtensionCustomType(type: string): string {
	const normalized = type.trim();
	if (!normalized) {
		throw new Error("Extension custom entry type must not be empty.");
	}
	if (!EXTENSION_CUSTOM_TYPE_PATTERN.test(normalized)) {
		throw new Error("Extension custom entry type must contain only letters, numbers, '.', '_', ':', and '-'.");
	}
	return normalized;
}

/**
 * The persisted custom type for one extension's namespaced entry.
 *
 * Exported because the write itself belongs to the harness - it owns the live
 * branch - while the naming rule has to stay here, next to the reader that
 * matches on it.
 */
export function toExtensionCustomType(extensionId: string, type: string, data?: unknown): string {
	assertJsonSerializable(data);
	return toPersistedExtensionCustomType(extensionId, normalizeExtensionCustomType(type));
}

function toPersistedExtensionCustomType(extensionId: string, localType: string): string {
	return `${toPersistedExtensionCustomTypePrefix(extensionId)}${localType}`;
}

function toPersistedExtensionCustomTypePrefix(extensionId: string): string {
	return `extension:${extensionId}:`;
}

function assertJsonSerializable(data: unknown): void {
	if (data === undefined) return;
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(data);
	} catch (error) {
		throw new Error(`Extension custom entry data must be JSON serializable: ${formatError(error)}`);
	}
	if (serialized === undefined) {
		throw new Error("Extension custom entry data must be JSON serializable.");
	}
}

function toExtensionCustomEntry<T>(entry: SessionTreeEntry, prefix: string): AgentExtensionCustomEntry<T> | undefined {
	if (entry.type !== "custom") return undefined;
	if (!entry.customType.startsWith(prefix)) return undefined;
	const customEntry: AgentExtensionCustomEntry<T> = {
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		type: entry.customType.slice(prefix.length),
	};
	if (Object.hasOwn(entry, "data")) {
		customEntry.data = entry.data as T;
	}
	return customEntry;
}
