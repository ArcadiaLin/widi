import type { AgentId } from "./types.ts";

export const AGENTS_DIR_NAME = "agents";
export const AGENT_TREE_FILE_NAME = "tree.jsonl";
export const AGENT_PARENT_FILE_NAME = "parent.json";

export interface AgentTreeSpawnRecord {
	readonly v: 1;
	readonly type: "spawned";
	readonly agentId: AgentId;
	/** Directory name relative to the encoded cwd directory. */
	readonly sessionDir: string;
	readonly profileId: string;
	readonly spawnedBy: AgentId;
	readonly at: string;
}

export interface AgentTreeRemovedRecord {
	readonly v: 1;
	readonly type: "removed";
	readonly agentId: AgentId;
	readonly at: string;
}

export type AgentTreeRecord = AgentTreeSpawnRecord | AgentTreeRemovedRecord;

export interface AgentParentPointer {
	readonly v: 1;
	readonly rootSessionDir: string;
	readonly parentAgentId: AgentId;
	readonly agentId: AgentId;
}

export function parseAgentTreeRecord(
	value: unknown,
): AgentTreeRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Partial<AgentTreeRecord>;
	if (
		record.v !== 1 ||
		typeof record.type !== "string" ||
		typeof record.agentId !== "string" ||
		typeof record.at !== "string"
	) {
		return undefined;
	}
	if (record.type === "removed") {
		return record as AgentTreeRemovedRecord;
	}
	if (
		record.type === "spawned" &&
		typeof record.sessionDir === "string" &&
		typeof record.profileId === "string" &&
		typeof record.spawnedBy === "string"
	) {
		return record as AgentTreeSpawnRecord;
	}
	return undefined;
}

export function parseAgentParentPointer(
	value: unknown,
): AgentParentPointer | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const pointer = value as Partial<AgentParentPointer>;
	return pointer.v === 1 &&
		typeof pointer.rootSessionDir === "string" &&
		typeof pointer.parentAgentId === "string" &&
		typeof pointer.agentId === "string"
		? (pointer as AgentParentPointer)
		: undefined;
}
