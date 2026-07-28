import type {
	AgentHarness,
	PromptTemplate,
	Skill,
} from "@earendil-works/pi-agent-core";
import type {
	AgentProfile,
	AgentProfileReference,
	AgentProfileSource,
} from "./agent-profile.js";
import { toAgentProfileReference } from "./agent-profile.js";
import type { BackgroundJobStore } from "./background/index.ts";
import { BackgroundJobTable } from "./background/index.ts";
import type { OrchestratorDiagnostic } from "./diagnostics.ts";
import type {
	ExtensionIdentity,
	ExtensionRunner,
	ExtensionRunnerSnapshot,
} from "./extension/index.ts";
import type { ResourceSource } from "./resource-loader.ts";
import type { AgentSessionMetadata } from "./session-manager.ts";
import type { ProjectContextFile } from "./system-prompt.ts";
import type {
	ResolvedAgentHarnessTool,
	ToolAdapterContext,
} from "./tool-registry.ts";
import type {
	AgentContextUsage,
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

/** Everything the system prompt callback needs beyond the live harness state. */
export interface AgentSystemPromptFacts {
	/** Appended sections owned by the profile and the settings, in that order. */
	readonly appendSections: readonly string[];
	readonly contextFiles: readonly ProjectContextFile[];
	/** The working directory to state, or undefined to leave it out. */
	readonly cwd?: string;
}

/** The concrete AgentHarness instantiation used by every WIDI agent. */
export type WidiAgentHarness = AgentHarness<
	ToolAdapterContext,
	Skill,
	PromptTemplate,
	ResolvedAgentHarnessTool
>;

export interface AgentRecord {
	readonly agentId: AgentId;
	status: AgentLifecycleStatus;
	readonly profile: AgentProfileRecordReference;
	/**
	 * The profile the harness was actually built from, including any override.
	 * Absent only for an agent that never got that far - an unavailable session
	 * is registered from its stored profile reference alone.
	 *
	 * Keeping it means a later question about this agent's role is answered from
	 * what it was built with, instead of re-reading a profile file that may since
	 * have changed underneath it.
	 */
	readonly resolvedProfile?: AgentProfile;
	/** The agent whose tool spawned this one; unset for user-side spawns. */
	readonly spawnedBy?: AgentId;
	sessionMetadata?: AgentSessionMetadata;
	model: RuntimeModel;
	harness?: WidiAgentHarness;
	toolSnapshot?: AgentToolsSnapshot;
	resources?: AgentResourcesSnapshot;
	/**
	 * System prompt composition resolved from the profile and the settings, plus
	 * the project instruction files loaded for it. Held here because the harness
	 * rebuilds its system prompt every turn through a synchronous callback that
	 * cannot go back to disk.
	 */
	systemPrompt?: AgentSystemPromptFacts;
	/**
	 * Last measured context occupancy of the active branch. Cached rather than
	 * derived on read: measuring walks the whole branch, and every consumer -
	 * the compaction trigger, the client gauge, extensions - wants the same
	 * number from the same moment. Absent until the branch carries an assistant
	 * usage to measure.
	 */
	contextUsage?: AgentContextUsage;
	/**
	 * Messages the harness has accepted but not yet read, as last reported by
	 * its `queue_update`. Mirrored here because the harness keeps its steer,
	 * follow-up, and next-turn queues private, and text delivered through the
	 * low-level `steerAgent`/`followUpAgent` primitives never passes through
	 * the orchestrator's own delivery queue.
	 */
	harnessQueuedMessageCount?: number;
	extensionRunner?: ExtensionRunner;
	/**
	 * Pseudo-async background jobs owned by this agent. Job ownership is
	 * structural: every job registered here belongs to this agent, so the
	 * result router knows whose turn to inject the outcome into and dispose can
	 * cascade an abort to all of them.
	 */
	readonly backgroundJobTable: BackgroundJobTable;
	/**
	 * Durable projection of {@link backgroundJobTable} into the agent's session
	 * directory. Absent for an ephemeral session, which owns no directory and
	 * therefore cannot outlive the runtime it would be recovered into.
	 */
	backgroundJobStore?: BackgroundJobStore;
	resourceDiagnostics: OrchestratorDiagnostic[];
	extensionDiagnostics: OrchestratorDiagnostic[];
	diagnostics: OrchestratorDiagnostic[];
}

export interface AgentRecordSnapshot {
	readonly agentId: AgentId;
	readonly status: AgentLifecycleStatus;
	readonly profile: AgentProfileRecordReference;
	readonly spawnedBy?: AgentId;
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly model: RuntimeModel;
	readonly hasHarness: boolean;
	readonly toolSnapshot?: AgentToolsSnapshot;
	readonly resources?: AgentResourcesSnapshot;
	readonly contextUsage?: AgentContextUsage;
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
	readonly spawnedBy?: AgentId;
}): AgentRecord {
	return {
		agentId: options.agentId,
		status: options.status,
		profile: {
			reference: toAgentProfileReference(options.resolvedProfile.profile),
			source: options.resolvedProfile.source,
			entryId: options.resolvedProfile.entryId,
		},
		resolvedProfile: options.resolvedProfile.profile,
		spawnedBy: options.spawnedBy,
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
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly model: RuntimeModel;
}): AgentRecord {
	return {
		agentId: options.agentId,
		status: options.status,
		profile: options.profile,
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
		spawnedBy: record.spawnedBy,
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
		contextUsage: record.contextUsage ? { ...record.contextUsage } : undefined,
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
		providerContributions: [],
		systemPromptContributions: [],
		divisions: [],
		stale: { stale: false },
	};
}
