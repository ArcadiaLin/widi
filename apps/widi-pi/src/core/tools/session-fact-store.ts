import type { Session, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { AgentSessionMetadata } from "../session-manager.ts";
import type {
	SessionFact,
	SessionFactDefinition,
	SessionFactDraft,
	SessionFactQuery,
	SessionFactSource,
	SessionFactStore,
} from "./types.ts";

type CustomSessionEntry = Extract<SessionTreeEntry, { type: "custom" }>;

interface StoredSessionFactData<TPayload = unknown> {
	source: SessionFactSource;
	sourceName: string;
	factType: string;
	version: number;
	payload: TPayload;
	toolCallId?: string;
}

export class SessionBackedSessionFactStore implements SessionFactStore {
	private readonly session: Session<AgentSessionMetadata>;

	constructor(session: Session<AgentSessionMetadata>) {
		this.session = session;
	}

	async append<TPayload>(
		fact: SessionFactDraft<TPayload>,
	): Promise<SessionFact<TPayload>> {
		const entryId = await this.session.appendCustomEntry(fact.namespace, {
			source: fact.source,
			sourceName: fact.sourceName,
			factType: fact.factType,
			version: fact.version,
			payload: fact.payload,
			toolCallId: fact.toolCallId,
		} satisfies StoredSessionFactData<TPayload>);
		const entry = await this.session.getEntry(entryId);
		const stored = entry ? toSessionFact<TPayload>(entry) : undefined;
		if (!stored) {
			throw new Error(`Failed to read appended session fact: ${entryId}`);
		}
		return stored;
	}

	async get<TPayload = unknown>(
		id: string,
	): Promise<SessionFact<TPayload> | undefined> {
		const entry = await this.session.getEntry(id);
		return entry ? toSessionFact<TPayload>(entry) : undefined;
	}

	async find<TPayload = unknown>(
		query: SessionFactQuery = {},
	): Promise<Array<SessionFact<TPayload>>> {
		const facts: Array<SessionFact<TPayload>> = [];
		for (const entry of await this.session.getEntries()) {
			const fact = toSessionFact<TPayload>(entry);
			if (fact && matchesSessionFactQuery(fact, query)) {
				facts.push(fact);
			}
		}
		return facts;
	}

	async restore<TPayload = unknown, TRestored = TPayload>(
		definition: SessionFactDefinition<TPayload, TRestored>,
		query: Omit<SessionFactQuery, "namespace" | "factType" | "version"> = {},
	): Promise<TRestored[]> {
		const factQuery: SessionFactQuery = {
			...query,
			namespace: definition.namespace,
			factType: definition.factType,
			version: definition.version,
		};
		if (definition.source !== undefined) factQuery.source = definition.source;
		if (definition.sourceName !== undefined)
			factQuery.sourceName = definition.sourceName;
		const facts = await this.find<TPayload>(factQuery);
		return Promise.all(facts.map((fact) => definition.restore(fact)));
	}
}

function toSessionFact<TPayload = unknown>(
	entry: SessionTreeEntry,
): SessionFact<TPayload> | undefined {
	if (entry.type !== "custom") return undefined;
	const data = parseSessionFactData<TPayload>(entry);
	if (!data) return undefined;
	return {
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		namespace: entry.customType,
		source: data.source,
		sourceName: data.sourceName,
		factType: data.factType,
		version: data.version,
		payload: data.payload,
		toolCallId: data.toolCallId,
	};
}

function parseSessionFactData<TPayload>(
	entry: CustomSessionEntry,
): StoredSessionFactData<TPayload> | undefined {
	const data = entry.data;
	if (!isRecord(data)) return undefined;
	if (!isSessionFactSource(data.source)) return undefined;
	if (typeof data.sourceName !== "string" || data.sourceName.length === 0)
		return undefined;
	if (typeof data.factType !== "string" || data.factType.length === 0)
		return undefined;
	if (typeof data.version !== "number" || !Number.isInteger(data.version))
		return undefined;
	if (!Object.hasOwn(data, "payload")) return undefined;
	if (data.toolCallId !== undefined && typeof data.toolCallId !== "string")
		return undefined;
	return {
		source: data.source,
		sourceName: data.sourceName,
		factType: data.factType,
		version: data.version,
		payload: data.payload as TPayload,
		toolCallId: data.toolCallId,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSessionFactSource(value: unknown): value is SessionFactSource {
	return value === "tool" || value === "extension" || value === "core";
}

function matchesSessionFactQuery(
	fact: SessionFact,
	query: SessionFactQuery,
): boolean {
	if (query.namespace !== undefined && fact.namespace !== query.namespace)
		return false;
	if (query.source !== undefined && fact.source !== query.source) return false;
	if (query.sourceName !== undefined && fact.sourceName !== query.sourceName)
		return false;
	if (query.factType !== undefined && fact.factType !== query.factType)
		return false;
	if (query.version !== undefined && fact.version !== query.version)
		return false;
	if (query.toolCallId !== undefined && fact.toolCallId !== query.toolCallId)
		return false;
	return true;
}
