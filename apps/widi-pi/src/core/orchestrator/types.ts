import type { AgentHarness, Skill } from "@widi/agent-core";
import type { AgentProfile, AgentProfileSource } from "../agent-profile.js";
import { toAgentProfileReference } from "../agent-profile.js";
import type { OwnerAttachment } from "../background/index.ts";
import type { OrchestratorDiagnostic } from "../diagnostics.ts";
import type { ExtensionRunner, ExtensionRunnerSnapshot } from "../extension/index.ts";
import type { NamespaceProjection } from "../persistence/index.ts";
import type { ResourceSource } from "../resource-loader.js";
import type { AgentSessionMetadata } from "../session-manager.ts";
import type { ProjectContextFile } from "../system-prompt.ts";
import type { ResolvedAgentHarnessTool, ToolAdapterContext } from "../tool-registry.ts";
import type { AgentActivitySnapshot, AgentContextUsage, AgentId, AgentToolsSnapshot, RuntimeModel } from "../types.ts";
import type { SubagentTreeStorage } from "./agent-tree.ts";

/**
 * The serializable identity of a live agent's profile, for display and for the
 * tree records.
 *
 * `source` and `entryId` are required. They were optional only to support the
 * failure path that built an `unavailable` record from a session's profile
 * reference so the TUI could still show a session it could not open; with
 * `unavailable` gone, every profile here has actually been resolved.
 */
export interface AgentProfileRecordReference {
	readonly reference: { readonly id: string; readonly label?: string };
	readonly source: AgentProfileSource;
	readonly entryId: string;
}

export interface AgentResourceFact {
	readonly name: string;
	readonly source: ResourceSource;
}

export interface AgentResourcesSnapshot {
	readonly skills: readonly AgentResourceFact[];
	readonly promptTemplates: readonly AgentResourceFact[];
}

/** Static facts used to compose the system prompt for every turn. */
export interface AgentSystemPromptFacts {
	readonly basePrompt: string;
	readonly skills: readonly Skill[];
	readonly appendSections: readonly string[];
	readonly contextFiles: readonly ProjectContextFile[];
	readonly includeSkills?: boolean;
	readonly cwd?: string;
}

/** The concrete AgentHarness instantiation used by every WIDI agent. */
export type WidiAgentHarness = AgentHarness<ToolAdapterContext, ResolvedAgentHarnessTool>;

/**
 * Per-agent settings the harness cannot answer after construction.
 *
 * This is a construction snapshot, not a second SettingManager.
 */
export interface AgentSettings {
	readonly retry: { readonly enabled: boolean; readonly maxRetries: number; readonly baseDelayMs: number };
	readonly providerRetry: {
		readonly timeoutMs?: number;
		readonly maxRetries?: number;
		readonly maxRetryDelayMs: number;
	};
	readonly compaction: { readonly enabled: boolean; readonly reserveTokens: number; readonly keepRecentTokens: number };
	readonly blockImages: boolean;
}

export type AgentActiveToolSelection =
	| { readonly mode: "default_all" }
	| { readonly mode: "explicit"; readonly toolNames: readonly string[] };

/**
 * Declarative tool intent. The harness owns the resolved installed/active
 * tools; this value exists only so extension reload can resolve that intent
 * again against a replacement runner.
 */
export interface AgentToolPolicy {
	readonly requestedToolNames?: readonly string[];
	readonly activeToolSelection: AgentActiveToolSelection;
}

export interface ExtensionRunnerBindings {
	readonly release: () => Promise<void>;
}

/** All in-memory state for one currently routable agent generation. */
export interface LiveAgent {
	readonly agentId: AgentId;
	readonly generation: number;
	readonly profile: AgentProfileRecordReference;
	readonly resolvedProfile: AgentProfile;
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly resources: AgentResourcesSnapshot;
	readonly systemPrompt: AgentSystemPromptFacts;
	readonly harness: WidiAgentHarness;
	readonly settings: AgentSettings;
	readonly backgroundAttachment: OwnerAttachment;
	extensionRunner: ExtensionRunner;
	extensionBindings: ExtensionRunnerBindings;
	toolPolicy: AgentToolPolicy;
	readonly releaseHarnessBindings: () => Promise<void>;
}

/** Public projection of a live agent. Gone agents have no snapshot. */
export interface AgentSnapshot {
	readonly agentId: AgentId;
	readonly generation: number;
	readonly profile: AgentProfileRecordReference;
	readonly spawnedBy?: AgentId;
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly model: RuntimeModel;
	readonly thinkingLevel: ReturnType<WidiAgentHarness["getThinkingLevel"]>;
	readonly tools: AgentToolsSnapshot;
	readonly activity: AgentActivitySnapshot;
	readonly extensions: ExtensionRunnerSnapshot;
	readonly diagnostics: readonly OrchestratorDiagnostic[];
	readonly contextUsage?: AgentContextUsage;
}

export function createAgentProfileRecordReference(resolved: {
	readonly profile: AgentProfile;
	readonly source: AgentProfileSource;
	readonly entryId: string;
}): AgentProfileRecordReference {
	return { reference: toAgentProfileReference(resolved.profile), source: resolved.source, entryId: resolved.entryId };
}

// ---------------------------------------------------------------------------
// Spawn tree persistence
//
// The vocabulary of `core:subagent`: what a parent writes down about the agents
// it spawned. See `agent-tree.ts` for what the records mean and why the tree is
// a chain rather than a snapshot.
// ---------------------------------------------------------------------------

/**
 * A child session joined this session's tree.
 *
 * The key is {@link sessionDirName}, not the AgentId. An AgentId is unique only
 * within one runtime - a resumed root that spawns `coder-1` again reuses it -
 * while a directory name carries a timestamp and is unique inside one parent.
 * Keying on the directory is also what keeps a record meaningful after a fork,
 * since a fork copies a child under the name it already had.
 */
export interface SubagentSpawnedRecord {
	readonly kind: "spawned";
	/** Directory name of the child inside this session's `agents/`. Never a path. */
	readonly sessionDirName: string;
	/** The id this member was routable under when it was recorded. */
	readonly agentId: AgentId;
	readonly profileId: string;
	readonly spawnedAt: number;
}

/**
 * A member left the tree and is not meant to come back.
 *
 * It carries no cause, and the contrast with a job's `closed` record is the
 * reason: five different runtime situations declare a job over, so a reader
 * needs to be told which one, whereas a member is removed by exactly one act -
 * a dispose whose intent was removal. A runtime shutdown writes nothing at all,
 * which is what makes restoring a tree possible in the first place.
 */
export interface SubagentRemovedRecord {
	readonly kind: "removed";
	readonly sessionDirName: string;
	readonly removedAt: number;
}

export type SubagentRecord = SubagentSpawnedRecord | SubagentRemovedRecord;

export type SubagentMemberState = "live" | "removed";

/** One member, reduced from every record on the chain that named it. */
export interface SubagentMember {
	readonly sessionDirName: string;
	readonly agentId: AgentId;
	readonly profileId: string;
	readonly spawnedAt: number;
	readonly state: SubagentMemberState;
	/** Present only for `removed`. */
	readonly removedAt?: number;
}

/** What one state root resolves to. */
export interface SubagentMembership {
	/** Oldest member first, in the order the branch recorded them. */
	readonly members: readonly SubagentMember[];
	/** The walk stopped before the chain's first record. */
	readonly truncated: boolean;
}

export interface SubagentSpawnRequest {
	readonly sessionDirName: string;
	readonly agentId: AgentId;
	readonly profileId: string;
	readonly spawnedAt?: number;
}

/**
 * The branch, as this namespace is allowed to see it. Already scoped to one
 * agent and to `core:subagent`, so neither appears in a signature.
 *
 * The same two methods as `JobBranchPort`, and deliberately a separate type:
 * both are narrowings of the one capability the orchestrator will hand out, and
 * the shape to share is the one taken from two working implementations rather
 * than from the first.
 */
export interface SubagentBranchPort {
	/** This namespace's state on the branch; undefined when it names none. */
	projection(): Promise<NamespaceProjection | undefined>;
	/** Ask the branch's owner to record this root. The object must be durable. */
	commit(stateRoot: string | null): Promise<void>;
}

export interface SessionSubagentStoreOptions {
	readonly storage: SubagentTreeStorage;
	readonly branch: SubagentBranchPort;
}
