/**
 * The orchestrator's collaboration capabilities, bound to one agent's identity.
 *
 * The binding supplies the identity so a holder never passes it: that is how
 * the surface is built, not what it is for.
 */

import type { ThinkingLevel } from "@widi/agent-core";
import type { BackgroundJobHost } from "./background/index.ts";
import type { HumanRequestDraft, HumanResponse } from "./human-request.ts";
import type { MessageSendOutcome } from "./message.ts";
import type { AgentActivity, AgentId } from "./types.ts";

export interface AgentProfileBrief {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly whenToUse?: string;
	readonly persist: boolean;
}

/** Model-visible summary of one currently live agent. */
export interface AgentBrief {
	readonly agentId: AgentId;
	readonly profileId: string;
	readonly label?: string;
	readonly activity: AgentActivity;
	/** The caller is subscribed to this agent's next stop. */
	readonly watchedByCaller: boolean;
}

/**
 * Where a spawned agent's context comes from. Narrower than the orchestrator's
 * own origin type, which also carries a full profile override: a profile is the
 * unit an agent may choose from, not a set of fields it may assemble.
 */
export type AgentSpawnOrigin =
	/** Fresh context from a profile; omitted takes the runtime default. */
	| { readonly kind: "new"; readonly profileId?: string }
	/** Reopen a session left behind by an agent that is no longer running. */
	| { readonly kind: "resume"; readonly reference: string }
	/** Copy a live agent's branch. Only for a source whose profile persists. */
	| { readonly kind: "fork"; readonly sourceAgentId: AgentId; readonly entryId?: string };

export interface AgentSpawnRequest {
	readonly origin: AgentSpawnOrigin;
	/** Model reference (`provider/id`); refused when the runtime does not have it. */
	readonly model?: string;
	readonly thinkingLevel?: ThinkingLevel;
}

/**
 * `taken` means another agent already watches the target: a stop has exactly
 * one reader. The rest mirror the dispose vocabulary.
 */
export type AgentWatchOutcome = "watching" | "not_watching" | "taken" | "outside_tree" | "self" | "unknown";

/**
 * One node of the caller's agent tree: an agent running now, or the session
 * directory an agent that is no longer running left behind.
 *
 * Only a running entry carries an AgentId, and that is deliberate. A closed
 * entry cannot be messaged or disposed, and the id its agent once had is both
 * useless for that and re-used by later runs, so showing it would only invite
 * the call that fails. A closed entry is for knowing what was done before, and
 * for deciding whether to spawn a fresh agent on the same profile.
 */
export type AgentTreeEntry = AgentTreeRunningEntry | AgentTreeClosedEntry;

export interface AgentTreeRunningEntry {
	readonly status: "running";
	readonly agentId: AgentId;
	readonly activity: AgentActivity;
	readonly profileId: string;
	readonly label?: string;
	/** Address of its session directory; absent for an ephemeral agent. */
	readonly sessionRef?: string;
	/** The caller is subscribed to this agent's next stop. */
	readonly watchedByCaller: boolean;
	readonly children: readonly AgentTreeEntry[];
}

export interface AgentTreeClosedEntry {
	readonly status: "closed";
	/**
	 * Address of the session directory, which is this entry's whole identity.
	 *
	 * The full address rather than the bare directory name: below the top level
	 * the name alone resolves to nothing, and the address is the form `/resume`
	 * and every other session reference already take.
	 */
	readonly sessionRef: string;
	/** Absent when the session header predates profile references. */
	readonly profileId?: string;
	readonly label?: string;
	readonly createdAt: string;
	readonly children: readonly AgentTreeEntry[];
}

export interface AgentTreeListing {
	/** The tree roots, normally exactly one: the root of the caller's own tree. */
	readonly entries: readonly AgentTreeEntry[];
	/**
	 * Set when the session directories could not be read, so the listing holds
	 * running agents only. Reported rather than thrown: a broken filesystem
	 * should not take out the caller's view of who is running.
	 */
	readonly closedUnavailable?: boolean;
}

export type AgentDisposeScope = "agent" | "subtree";

export interface AgentRequestedDisposeOptions {
	readonly scope: AgentDisposeScope;
	readonly reason: string;
}

export type AgentRequestedDisposeOutcome =
	| { readonly kind: "disposed"; readonly agentIds: readonly AgentId[] }
	| { readonly kind: "already_disposed" | "outside_tree" | "self" | "unknown" };

/**
 * What one agent can ask of the orchestrator, with the asking agent already
 * bound.
 *
 * Every method is missing the same parameter - who is asking - because the
 * binding already carries it. That is what makes this one surface usable by any
 * runtime allowed to act as the agent: `spawn` parents under it, `listAgents`
 * scopes to its level, `dispose` checks their shared tree, and `sendMessage`
 * attributes to it, whoever is holding the object. Tools are the first holder.
 *
 * Modules that are not agent-scoped hold something else: the background runtime
 * serves every agent and speaks as a job rather than as an agent, so it takes a
 * message sink and none of this.
 */
export interface AgentToOrchestratorHost {
	readonly agentId: AgentId;
	listProfiles(): Promise<readonly AgentProfileBrief[]>;
	listAgents(): Promise<AgentTreeListing>;
	describe(agentId: AgentId): AgentBrief | undefined;
	spawn(request: AgentSpawnRequest): Promise<AgentId>;
	sendMessage(targetAgentId: AgentId, body: string): Promise<MessageSendOutcome>;
	/**
	 * Subscribe to, or unsubscribe from, the target's next stop. It registers a
	 * subscription and never waits for one to fire.
	 *
	 * Subscribe *before* sending the work. A pending delivery already counts the
	 * target as busy, so a subscription registered first cannot miss the stop
	 * that follows; registered after the send, it races one.
	 */
	watch(targetAgentId: AgentId, watching: boolean): AgentWatchOutcome;
	dispose(agentId: AgentId, options: AgentRequestedDisposeOptions): Promise<AgentRequestedDisposeOutcome>;
	readonly jobs: BackgroundJobHost;
	requestHuman(request: HumanRequestDraft): Promise<HumanResponse>;
}
