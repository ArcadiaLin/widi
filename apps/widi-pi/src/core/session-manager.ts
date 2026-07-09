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
	SessionForkOptions,
	SessionMetadata,
	SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
	InMemorySessionRepo,
	JsonlSessionRepo,
} from "@earendil-works/pi-agent-core";
import type { AgentProfile, AgentProfileReference } from "./agent-profile.js";
import {
	parseAgentProfileReference,
	toAgentProfileReference,
} from "./agent-profile.js";
import type { AgentId } from "./runtime-types.ts";

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

export interface AgentSessionCandidate {
	readonly id: string;
	readonly path: string;
	readonly createdAt: string;
	readonly cwd: string;
	readonly parentSessionPath?: string;
	readonly profile?: AgentProfileReference;
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
		return sessions.map(toAgentSessionCandidate);
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

	async appendCommandExpansionEntry(
		agentId: AgentId,
		data: CommandExpansionEntryData,
	): Promise<string> {
		return await this._requireAgentSession(agentId).appendCustomEntry(
			COMMAND_EXPANSION_CUSTOM_TYPE,
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
		const storage = session.getStorage();
		const entries = await storage.getPathToRoot(await storage.getLeafId());
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

	private async _snapshotSession(
		session: Session<AgentSessionMetadata>,
	): Promise<AgentSessionSnapshot> {
		return {
			metadata: await session.getMetadata(),
			name: await session.getSessionName(),
			leafId: await session.getLeafId(),
			pathToRoot: await session.getBranch(),
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
