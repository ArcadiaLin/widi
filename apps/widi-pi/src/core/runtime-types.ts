import type { Api, Model } from "@earendil-works/pi-ai";

export type RuntimeModel = Model<Api>;

export interface AgentToolsSnapshot {
	readonly toolNames: string[];
	readonly activeToolNames: string[];
}
