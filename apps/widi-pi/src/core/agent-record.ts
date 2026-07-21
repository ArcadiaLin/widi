import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type {
	AgentProfile,
	AgentProfileReference,
	AgentProfileSource,
} from "./agent-profile.js";
import { toAgentProfileReference } from "./agent-profile.js";
import { BackgroundJobTable } from "./background-job.ts";
import type { OrchestratorDiagnostic } from "./diagnostics.ts";
import type {
	ExtensionIdentity,
	ExtensionRunner,
	ExtensionRunnerSnapshot,
} from "./extension/index.ts";
import type { ResourceSource } from "./resource-loader.ts";
import type { AgentSessionMetadata } from "./session-manager.ts";
import type {
	AgentId,
	AgentLifecycleStatus,
	AgentToolsSnapshot,
	RuntimeModel,
} from "./types.ts";

export interface AgentProfileRecordReference {
	readonly reference: AgentProfileReference;
	readonly source?: AgentProfileSource;
	readonly entryId?: string;
}

// Resolved resource provenance facts (ME slice 8): which named resources the
// agent harness was built with and which root or extension each came from.
export interface AgentResourceFact {
	readonly name: string;
	readonly source: ResourceSource;
}

export interface AgentResourcesSnapshot {
	readonly skills: readonly AgentResourceFact[];
	readonly promptTemplates: readonly AgentResourceFact[];
}

export interface AgentRecord {
	readonly agentId: AgentId;
	status: AgentLifecycleStatus;
	readonly profile: AgentProfileRecordReference;
	readonly capabilities?: AgentProfile["capabilities"];
	sessionMetadata?: AgentSessionMetadata;
	model: RuntimeModel;
	harness?: AgentHarness;
	toolSnapshot?: AgentToolsSnapshot;
	resources?: AgentResourcesSnapshot;
	extensionRunner?: ExtensionRunner;
	/**
	 * Pseudo-async background jobs owned by this agent. Job ownership is
	 * structural: every job registered here belongs to this agent, so the
	 * result router knows whose turn to inject the outcome into and dispose can
	 * cascade an abort to all of them.
	 */
	readonly backgroundJobTable: BackgroundJobTable;
	resourceDiagnostics: OrchestratorDiagnostic[];
	extensionDiagnostics: OrchestratorDiagnostic[];
	diagnostics: OrchestratorDiagnostic[];
}

export interface AgentRecordSnapshot {
	readonly agentId: AgentId;
	readonly status: AgentLifecycleStatus;
	readonly profile: AgentProfileRecordReference;
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly model: RuntimeModel;
	readonly hasHarness: boolean;
	readonly toolSnapshot?: AgentToolsSnapshot;
	readonly resources?: AgentResourcesSnapshot;
	readonly extensionIds: readonly string[];
	readonly extensions: readonly ExtensionIdentity[];
	readonly extensionSnapshot: ExtensionRunnerSnapshot;
	readonly resourceDiagnostics: readonly OrchestratorDiagnostic[];
	readonly extensionDiagnostics: readonly OrchestratorDiagnostic[];
	readonly diagnostics: readonly OrchestratorDiagnostic[];
}

export function createAgentRecord(options: {
	readonly agentId: AgentId;
	readonly status: AgentLifecycleStatus;
	readonly resolvedProfile: {
		readonly profile: AgentProfile;
		readonly source: AgentProfileSource;
		readonly entryId: string;
	};
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly model: RuntimeModel;
}): AgentRecord {
	return {
		agentId: options.agentId,
		status: options.status,
		profile: {
			reference: toAgentProfileReference(options.resolvedProfile.profile),
			source: options.resolvedProfile.source,
			entryId: options.resolvedProfile.entryId,
		},
		capabilities: options.resolvedProfile.profile.capabilities,
		sessionMetadata: options.sessionMetadata,
		model: options.model,
		backgroundJobTable: new BackgroundJobTable(),
		resourceDiagnostics: [],
		extensionDiagnostics: [],
		diagnostics: [],
	};
}

export function createAgentRecordFromProfileReference(options: {
	readonly agentId: AgentId;
	readonly status: AgentLifecycleStatus;
	readonly profile: AgentProfileRecordReference;
	readonly capabilities?: AgentProfile["capabilities"];
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly model: RuntimeModel;
}): AgentRecord {
	return {
		agentId: options.agentId,
		status: options.status,
		profile: options.profile,
		capabilities: options.capabilities,
		sessionMetadata: options.sessionMetadata,
		model: options.model,
		backgroundJobTable: new BackgroundJobTable(),
		resourceDiagnostics: [],
		extensionDiagnostics: [],
		diagnostics: [],
	};
}

export function snapshotAgentRecord(record: AgentRecord): AgentRecordSnapshot {
	return {
		agentId: record.agentId,
		status: record.status,
		profile: { ...record.profile },
		sessionMetadata: record.sessionMetadata,
		model: record.model,
		hasHarness: record.harness !== undefined,
		toolSnapshot: record.toolSnapshot
			? {
					toolNames: [...record.toolSnapshot.toolNames],
					activeToolNames: [...record.toolSnapshot.activeToolNames],
				}
			: undefined,
		resources: record.resources
			? {
					skills: [...record.resources.skills],
					promptTemplates: [...record.resources.promptTemplates],
				}
			: undefined,
		extensionIds: record.extensionRunner
			? [...record.extensionRunner.extensionIds]
			: [],
		extensions: record.extensionRunner
			? [...record.extensionRunner.extensions]
			: [],
		extensionSnapshot: record.extensionRunner
			? record.extensionRunner.inspect()
			: createEmptyExtensionSnapshot(),
		resourceDiagnostics: [...record.resourceDiagnostics],
		extensionDiagnostics: [...record.extensionDiagnostics],
		diagnostics: [...record.diagnostics],
	};
}

export function createEmptyExtensionSnapshot(): ExtensionRunnerSnapshot {
	return {
		extensionIds: [],
		extensions: [],
		hooks: [],
		toolContributions: [],
		resourceContributions: [],
		providerContributions: [],
		stale: { stale: false },
	};
}
