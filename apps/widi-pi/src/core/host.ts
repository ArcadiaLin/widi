/**
 * Caller-bound collaboration capabilities exposed to agent tools.
 *
 * The caller identity is captured by the orchestrator. No model-controlled
 * argument can select the sender, task settler, or background-job owner.
 */

import type { BackgroundJobHost, BackgroundJobSettler } from "./background/index.ts";
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
}

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

export interface AgentTaskOutcome {
	readonly status: "completed" | "failed";
	readonly text: string;
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
 * Every method is missing the same parameter - who is asking - and that absence
 * is the point. The holder cannot name a different agent as itself, so `spawn`
 * always parents under the asker, `listAgents` always scopes to its level,
 * `dispose` always checks their shared tree, and `sendMessage` always attributes
 * to it. A tool's arguments come from a model verbatim, so the identity has to
 * be somewhere the arguments cannot reach.
 *
 * Held by any agent-scoped module outside the orchestrator, not tools alone.
 * Modules that are not agent-scoped hold something else: the background runtime
 * serves every agent and speaks as a job rather than as an agent, so it takes a
 * message sink and none of this.
 */
export interface AgentToOrchestratorHost {
	readonly agentId: AgentId;
	listProfiles(): Promise<readonly AgentProfileBrief[]>;
	listAgents(): Promise<AgentTreeListing>;
	describe(agentId: AgentId): AgentBrief | undefined;
	spawn(profileId: string): Promise<AgentId>;
	sendMessage(targetAgentId: AgentId, body: string): Promise<MessageSendOutcome>;
	dispose(agentId: AgentId, options: AgentRequestedDisposeOptions): Promise<AgentRequestedDisposeOutcome>;
	readonly jobs: BackgroundJobHost;
	readonly settler: BackgroundJobSettler;
	requestHuman(request: HumanRequestDraft): Promise<HumanResponse>;
}

export const CORE_AGENT_TOOL_NAMES: readonly string[] = [
	"list_agent_profiles",
	"list_agents",
	"spawn_agent",
	"send_message",
	"dispose_agent",
];
