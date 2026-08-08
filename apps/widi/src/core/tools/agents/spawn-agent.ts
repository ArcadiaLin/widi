import { type Static, Type } from "typebox";
import { formatError } from "../../../utils/errors.ts";
import type { ToolDefinition } from "../types.ts";
import { assignAgentTask, describeAssignedTask, requireAgentHost } from "./shared.ts";

const spawnAgentSchema = Type.Object({
	profile: Type.String({ description: "Id of the profile the new agent should run as, from list_agent_profiles." }),
	task: Type.Optional(
		Type.String({
			description:
				"Optional first task to delegate to the new agent. Include everything it needs to know: it starts with no knowledge of your conversation. You get back a task id you can wait on.",
		}),
	),
});

/**
 * Exported because the tool result is a durable record: the orchestrator reads
 * a resumed branch for the agents it says were spawned, and matching that by a
 * literal in two files is how the two drift apart.
 */
export const SPAWN_AGENT_TOOL_NAME = "spawn_agent";

export type SpawnAgentInput = Static<typeof spawnAgentSchema>;

export interface SpawnAgentDetails {
	readonly agentId: string;
	readonly profileId: string;
	/** Present only when a first task was delegated. */
	readonly taskId?: string;
}

/**
 * Create one agent.
 *
 * No count, background, or timeout arguments: agents are concurrent by nature,
 * spawning only waits for the harness to be ready, and several tool calls in
 * one batch already run in parallel. No fresh/fork context choice either -
 * whatever the child needs to know belongs in `task`, which costs one message
 * instead of the parent's whole transcript on every one of the child's turns.
 */
export function createSpawnAgentToolDefinition(): ToolDefinition<typeof spawnAgentSchema, SpawnAgentDetails> {
	return {
		name: SPAWN_AGENT_TOOL_NAME,
		label: SPAWN_AGENT_TOOL_NAME,
		description:
			"Create a new agent from a profile and get its agent id back. The new agent is idle and runs independently; it does not see your conversation. Pass task to hand it a first task at the same time, which returns a task id that settles when that agent reports the task complete. Use list_agent_profiles first to pick a profile.",
		promptSnippet: "Create a new agent, optionally with a first task",
		parameters: spawnAgentSchema,
		execute: async (toolCallId, { profile, task }, context) => {
			const host = requireAgentHost(context);
			const profileId = profile.trim();
			if (!profileId) {
				throw new Error("spawn_agent requires a non-empty profile id.");
			}
			const trimmedTask = task?.trim();
			if (task !== undefined && !trimmedTask) {
				throw new Error("spawn_agent was given an empty task. Omit task to spawn an idle agent.");
			}

			const agentId = await host.spawn({ origin: { kind: "new", profileId } });
			if (!trimmedTask) {
				return {
					content: [
						{
							type: "text",
							text: `Agent ${agentId} was created from profile ${profileId} and is idle. Use send_message to give it work.`,
						},
					],
					details: { agentId, profileId },
				};
			}

			let assigned: Awaited<ReturnType<typeof assignAgentTask>>;
			try {
				assigned = await assignAgentTask({
					host,
					jobs: host.jobs,
					toolCallId,
					toolName: "spawn_agent",
					targetAgentId: agentId,
					message: trimmedTask,
				});
			} catch (error) {
				// The agent exists and is fine; only the assignment failed. Destroying
				// a working agent to tidy up a failed call is worse than leaving it,
				// so report both facts and let the caller decide.
				throw new Error(
					`Agent ${agentId} was created from profile ${profileId} and is idle, but the task was not assigned: ${formatError(error)}`,
				);
			}
			return {
				content: [
					{
						type: "text",
						text: `Agent ${agentId} was created from profile ${profileId}. ${describeAssignedTask(assigned.taskId, agentId)}`,
					},
				],
				details: { agentId, profileId, taskId: assigned.taskId },
			};
		},
	};
}
