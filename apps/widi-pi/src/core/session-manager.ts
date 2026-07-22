/**
 * SessionManager owns session repositories used by AgentOrchestrator.
 *
 * Persistent sessions use pi-agent-core JSONL storage. WIDI stores profile
 * references in the JSONL session header metadata so resume can rebuild harness
 * context.
 */

import type {
	FileError,
	FileSystem,
	JsonlSessionMetadata,
	Session,
	SessionContext,
	SessionForkOptions,
	SessionMetadata,
	SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
	buildSessionContext,
	InMemorySessionRepo,
	JsonlSessionRepo,
} from "@earendil-works/pi-agent-core";
import type { AgentProfile, AgentProfileReference } from "./agent-profile.js";
import {
	parseAgentProfileReference,
	toAgentProfileReference,
} from "./agent-profile.js";
import type { ExtensionMessage } from "./extension/presentation.ts";
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

type CreateAgentSessionOptions = {
	agentId: AgentId;
	agentProfile: AgentProfile;
	parentSessionPath?: string;
};

type ResumeAgentSessionOptions = {
	agentId: AgentId;
	metadata: JsonlSessionMetadata;
};

export class SessionManager {
	readonly sessionRepo: JsonlSessionRepo;
	private readonly _fs: FileSystem;
	private readonly _cwd: string;
	private readonly _agentSessions: Map<AgentId, Session<AgentSessionMetadata>> =
		new Map();
	private readonly _memorySessionRepo: InMemorySessionRepo =
		new InMemorySessionRepo();

	constructor(config: SessionManagerConfigs) {
		this._fs = config.fs;
		this._cwd = config.cwd;
		this.sessionRepo = new JsonlSessionRepo({
			fs: config.fs,
			sessionsRoot: config.sessionsRoot,
		});
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
	private async _loadSessionDisplayFacts(
		path: string,
	): Promise<{ name?: string; firstUserMessage?: string }> {
		const read = await this._fs.readTextFile(path);
		if (!read.ok) return {};
		const facts: { name?: string; firstUserMessage?: string } = {};
		for (const line of read.value.split("\n")) {
			// Cheap substring gate so only relevant lines pay for JSON.parse.
			const wantsMessage =
				facts.firstUserMessage === undefined && line.includes('"message"');
			const wantsName = line.includes('"session_info"');
			if (!wantsMessage && !wantsName) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof entry !== "object" || entry === null) continue;
			const typed = entry as {
				type?: unknown;
				name?: unknown;
				message?: { role?: unknown; content?: unknown };
			};
			if (typed.type === "session_info" && typeof typed.name === "string") {
				facts.name = typed.name.trim() || undefined;
				continue;
			}
			if (
				wantsMessage &&
				typed.type === "message" &&
				typed.message?.role === "user"
			) {
				facts.firstUserMessage = userMessageHeadline(typed.message.content);
			}
		}
		return facts;
	}

	async resolveAgentSessionReference(
		reference: string,
	): Promise<JsonlSessionMetadata> {
		const normalized = reference.trim();
		if (!normalized) {
			throw new AgentSessionResolutionError({
				reason: "not_found",
				reference,
				candidates: [],
			});
		}

		const sessions = await this.sessionRepo.list({ cwd: this._cwd });
		const absoluteReference = fileSystemValueOrThrow(
			await this._fs.absolutePath(normalized),
			`Failed to resolve session reference ${normalized}`,
		);
		const pathMatches = sessions.filter(
			(session) =>
				session.path === normalized || session.path === absoluteReference,
		);
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

		throw new AgentSessionResolutionError({
			reason: "not_found",
			reference: normalized,
			candidates: [],
		});
	}

	async createAgentSession(
		options: CreateAgentSessionOptions,
	): Promise<Session<AgentSessionMetadata>> {
		const cachedSession = this._agentSessions.get(options.agentId);
		if (cachedSession) {
			return cachedSession;
		}

		const session = options.agentProfile.persist
			? await this._createPersistentAgentSession(options)
			: await this._createEphemeralAgentSession(options.agentId);
		this._agentSessions.set(options.agentId, session);
		return session;
	}

	async resumeAgentSession(
		options: ResumeAgentSessionOptions,
	): Promise<Session<AgentSessionMetadata>> {
		const cachedSession = this._agentSessions.get(options.agentId);
		if (cachedSession) {
			return cachedSession;
		}
		const session = await this.sessionRepo.open(options.metadata);
		this._agentSessions.set(options.agentId, session);
		return session;
	}

	async getAgentSessionSnapshot(
		agentId: AgentId,
	): Promise<AgentSessionSnapshot> {
		const session = this._requireAgentSession(agentId);
		return await this._snapshotSession(session);
	}

	async getAgentSessionTree(
		agentId: AgentId,
	): Promise<AgentSessionTreeSnapshot> {
		const session = this._requireAgentSession(agentId);
		return {
			...(await this._snapshotSession(session)),
			entries: await session.getEntries(),
		};
	}

	async buildAgentSessionContext(agentId: AgentId): Promise<SessionContext> {
		const session = this._requireAgentSession(agentId);
		return buildSessionContext(await this._getFullBranch(session));
	}

	async setAgentSessionName(
		agentId: AgentId,
		name: string,
	): Promise<AgentSessionSnapshot> {
		const session = this._requireAgentSession(agentId);
		await session.appendSessionName(name);
		return await this._snapshotSession(session);
	}

	async forkAgentSession(
		agentId: AgentId,
		options: ForkAgentSessionOptions = {},
	): Promise<JsonlSessionMetadata> {
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
		return forkedMetadata;
	}

	async getAgentSessionLeafId(agentId: AgentId): Promise<string | null> {
		return await this._requireAgentSession(agentId).getLeafId();
	}

	// Retraction for provisional prompt records (expansion/transform entries
	// appended before the harness persists the paired user message). Only
	// rewinds when the branch leaf is still the last provisional entry; if
	// anything landed after it - the user message, a concurrent write - the
	// branch is left untouched.
	async retractAgentSessionEntries(
		agentId: AgentId,
		options: {
			readonly lastEntryId: string;
			readonly previousLeafId: string | null;
		},
	): Promise<boolean> {
		const session = this._requireAgentSession(agentId);
		if ((await session.getLeafId()) !== options.lastEntryId) return false;
		await session.moveTo(options.previousLeafId);
		return true;
	}

	async appendCommandExpansionEntry(
		agentId: AgentId,
		data: CommandExpansionEntryData,
	): Promise<string> {
		return await this._requireAgentSession(agentId).appendCustomEntry(
			COMMAND_EXPANSION_CUSTOM_TYPE,
			data,
		);
	}

	async appendInputTransformEntry(
		agentId: AgentId,
		data: InputTransformEntryData,
	): Promise<string> {
		return await this._requireAgentSession(agentId).appendCustomEntry(
			INPUT_TRANSFORM_CUSTOM_TYPE,
			data,
		);
	}

	async appendExtensionMessageEntry(
		agentId: AgentId,
		data: ExtensionMessageEntryData,
	): Promise<string> {
		return await this._requireAgentSession(agentId).appendCustomEntry(
			EXTENSION_MESSAGE_CUSTOM_TYPE,
			data,
		);
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
		const localType =
			type === undefined ? undefined : normalizeExtensionCustomType(type);
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
			metadata: {
				profile: toAgentProfileReference(options.agentProfile),
			},
		});
	}

	private async _createEphemeralAgentSession(
		agentId: AgentId,
	): Promise<Session<SessionMetadata>> {
		return this._memorySessionRepo.create({ id: agentId });
	}

	private _requireAgentSession(
		agentId: AgentId,
	): Session<AgentSessionMetadata> {
		const session = this._agentSessions.get(agentId);
		if (!session) {
			throw new Error(`Unknown agent session: ${agentId}`);
		}
		return session;
	}

	// pi-agent-core's public branch is compaction-aware and may start at a
	// retained-tail checkpoint. WIDI still needs the complete active path for
	// timeline hydration, extension state, and durable runtime configuration.
	private async _getFullBranch(
		session: Session<AgentSessionMetadata>,
	): Promise<SessionTreeEntry[]> {
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

	private async _snapshotSession(
		session: Session<AgentSessionMetadata>,
	): Promise<AgentSessionSnapshot> {
		return {
			metadata: await session.getMetadata(),
			name: await session.getSessionName(),
			leafId: await session.getLeafId(),
			pathToRoot: await this._getFullBranch(session),
		};
	}
}

function isJsonlSessionMetadata(
	metadata: AgentSessionMetadata,
): metadata is JsonlSessionMetadata {
	return (
		"path" in metadata &&
		typeof metadata.path === "string" &&
		"cwd" in metadata &&
		typeof metadata.cwd === "string"
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

function toAgentSessionCandidate(
	metadata: JsonlSessionMetadata,
): AgentSessionCandidate {
	return {
		id: metadata.id,
		path: metadata.path,
		createdAt: metadata.createdAt,
		cwd: metadata.cwd,
		parentSessionPath: metadata.parentSessionPath,
		profile: parseAgentProfileReference(metadata.metadata?.profile),
	};
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
		throw new Error(
			"Extension custom entry type must contain only letters, numbers, '.', '_', ':', and '-'.",
		);
	}
	return normalized;
}

function toPersistedExtensionCustomType(
	extensionId: string,
	localType: string,
): string {
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
		throw new Error(
			`Extension custom entry data must be JSON serializable: ${formatError(error)}`,
		);
	}
	if (serialized === undefined) {
		throw new Error("Extension custom entry data must be JSON serializable.");
	}
}

function toExtensionCustomEntry<T>(
	entry: SessionTreeEntry,
	prefix: string,
): AgentExtensionCustomEntry<T> | undefined {
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

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
