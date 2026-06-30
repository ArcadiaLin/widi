/**
 * SessionManager owns session repositories used by AgentOrchestrator.
 *
 * The local JSONL adapter keeps Pi session tree semantics intact and only
 * extends the session header with metadata needed to rebuild harness context.
 */

import type {
	FileSystem,
	Session,
	SessionMetadata,
	SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
	type ExtendedJsonlSessionMetadata,
	type JsonlSessionPathLayout,
	JsonlSessionRepo,
} from "../storage/jsonl-repo.js";
import type { AgentId } from "./agent-orchestrator.js";
import type { AgentProfile } from "./agent-profile.js";
import { toAgentProfileReference } from "./agent-profile.js";

export type AgentSessionMetadata =
	| SessionMetadata
	| ExtendedJsonlSessionMetadata;

export interface AgentExtensionCustomEntry<T = unknown> {
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
	data?: T;
}

export interface SessionManagerConfigs {
	fs: FileSystem;
	cwd: string;
	sessionsRoot: string;
	sessionPathLayout?: JsonlSessionPathLayout;
}

type CreateAgentSessionOptions = {
	agentId: AgentId;
	agentProfile: AgentProfile;
	parentSessionPath?: string;
};

type ResumeAgentSessionOptions = {
	agentId: AgentId;
	metadata: ExtendedJsonlSessionMetadata;
};

export class SessionManager {
	readonly sessionRepo: JsonlSessionRepo;
	private readonly _cwd: string;
	private readonly _agentSessions: Map<AgentId, Session<AgentSessionMetadata>> =
		new Map();
	private readonly _memorySessionRepo: InMemorySessionRepo =
		new InMemorySessionRepo();

	constructor(config: SessionManagerConfigs) {
		this._cwd = config.cwd;
		this.sessionRepo = new JsonlSessionRepo({
			fs: config.fs,
			sessionsRoot: config.sessionsRoot,
			pathLayout: config.sessionPathLayout,
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
	): Promise<Session<ExtendedJsonlSessionMetadata>> {
		// TODO: Add file locking before multiple WIDI processes can write the same sessionsRoot.
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
