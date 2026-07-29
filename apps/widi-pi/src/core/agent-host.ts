/**
 * The collaboration surface an agent's tools are allowed to see.
 *
 * Tools never receive the orchestrator. They receive one of these per agent,
 * with the calling agent's identity captured in the closure, so a model
 * argument can never forge the sender of a message or the settler of a task.
 *
 * The interface lives in its own module so the dependency edge stays one way:
 * `agent-orchestrator.ts` implements it, `tools/types.ts` only references the
 * type, and neither the tool layer nor the message layer has to import the
 * orchestrator back.
 */

import type { BackgroundJobSettleResult } from "./background/index.ts";
import type { MessageSendOutcome } from "./message.ts";
import type { AgentId, AgentLifecycleStatus } from "./types.ts";

/**
 * Model-visible summary of a spawnable profile. Deliberately no source, path,
 * entry id, system prompt, or extension configuration: this is a menu, not a
 * description of how the runtime resolved it.
 */
export interface AgentProfileBrief {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** When to pick this role over its neighbours. The menu's selection advice. */
	readonly whenToUse?: string;
	/** Whether agents created from this profile get a persistent session. */
	readonly persist: boolean;
}

/** Model-visible summary of one live agent. */
export interface AgentBrief {
	readonly agentId: AgentId;
	readonly profileId: string;
	readonly label?: string;
	readonly status: AgentLifecycleStatus;
	/**
	 * Whether the agent can still be given work. False while it is being
	 * disposed - which its `status` cannot express, because `disposed` is only
	 * committed at the end of a long teardown - and false once it is gone.
	 */
	readonly addressable: boolean;
}

/** Terminal outcome an external settler writes onto a delegated task. */
export interface AgentTaskOutcome {
	readonly status: "completed" | "failed";
	/** Report text; it reaches the owner as the task's result message. */
	readonly text: string;
}

/** How much of one spawn tree a lifecycle operation targets. */
export type AgentDisposeScope = "agent" | "subtree";

/** Policy result returned by the caller-bound lifecycle capability. */
export type ToolAgentDisposeOutcome =
	| {
			readonly kind: "disposed";
			/** Agents actually transitioned, in leaf-to-root disposal order. */
			readonly agentIds: readonly AgentId[];
	  }
	| {
			readonly kind: "already_disposed" | "outside_tree" | "self" | "unknown";
	  };

export interface ToolAgentHost {
	/** The calling agent. Captured by the runtime, never taken from arguments. */
	readonly agentId: AgentId;
	/** Enabled profiles that `spawn` will accept. */
	listProfiles(): Promise<AgentProfileBrief[]>;
	/** Non-disposed agents in the caller's spawn tree, including the caller. */
	listAgents(): AgentBrief[];
	/**
	 * Resolve one exact runtime-local address. This is deliberately not scoped
	 * to the caller's tree: knowing an id is the soft bridge for cross-tree
	 * messaging. It does not provide an enumeration path.
	 *
	 * Returns undefined for an unknown id rather than throwing: a tool has to
	 * turn "no such agent" into a readable tool failure, not let a runtime error
	 * escape onto the turn.
	 */
	describe(agentId: AgentId): AgentBrief | undefined;
	/** Create a child in the caller's tree from an enabled profile. */
	spawn(profileId: string): Promise<AgentId>;
	/** Send one message as the calling agent. Never steers the target. */
	send(targetAgentId: AgentId, body: string): Promise<MessageSendOutcome>;
	/**
	 * Dispose one same-tree agent or its whole subtree. A subtree containing the
	 * caller is refused because a synchronous tool call cannot tear down the
	 * harness that still has to receive its result.
	 */
	dispose(
		agentId: AgentId,
		options: {
			readonly scope: AgentDisposeScope;
			readonly reason: string;
		},
	): Promise<ToolAgentDisposeOutcome>;
	/**
	 * Settle a task held in another agent's job table. Authorization lives in
	 * the table: the settler recorded on the job must be the calling agent, so
	 * `denied` is the answer for anyone else.
	 */
	settleTask(
		ownerAgentId: AgentId,
		taskId: string,
		outcome: AgentTaskOutcome,
	): BackgroundJobSettleResult;
}

/**
 * Names of the core collaboration tools. The system prompt appends the agent's
 * own id only when at least one of these is active - an agent that cannot talk
 * to other agents has no use for its own address.
 */
export const CORE_AGENT_TOOL_NAMES: readonly string[] = [
	"list_agent_profiles",
	"list_agents",
	"spawn_agent",
	"send_message",
	"dispose_agent",
];
