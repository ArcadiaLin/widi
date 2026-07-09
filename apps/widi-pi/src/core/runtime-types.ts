import type { Api, Model } from "@earendil-works/pi-ai";

export type RuntimeModel = Model<Api>;

/** Runtime-local agent identity allocated by the orchestrator. */
export type AgentId = string;

export type AgentLifecycleStatus =
	| "creating"
	| "running"
	| "idle"
	| "unavailable"
	| "disposed";

export interface AgentToolsSnapshot {
	readonly toolNames: string[];
	readonly activeToolNames: string[];
}
