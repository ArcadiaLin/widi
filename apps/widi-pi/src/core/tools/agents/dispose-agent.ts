import { type Static, Type } from "typebox";
import { formatError } from "../../../utils/errors.ts";
import type { ToolAgentHost } from "../../agent-host.ts";
import type { ToolDefinition } from "../types.ts";
import { requireAgentHost } from "./shared.ts";

const disposeAgentSchema = Type.Object({
	agentIds: Type.Array(Type.String(), {
		description:
			"Ids of the agents to destroy. Only these agents are affected; agents they spawned keep running.",
	}),
	reason: Type.Optional(
		Type.String({
			description:
				"Short note recorded on the cancellations this dispose causes.",
		}),
	),
});

export type DisposeAgentInput = Static<typeof disposeAgentSchema>;

/**
 * Per-agent result:
 * - `disposed`: the agent was live and has been destroyed;
 * - `already_disposed`: nothing to do;
 * - `unknown`: no agent with that id;
 * - `self`: refused, an agent cannot destroy itself here;
 * - `failed`: the teardown reported an error.
 */
export type DisposeAgentState =
	| "disposed"
	| "already_disposed"
	| "unknown"
	| "self"
	| "failed";

export interface DisposeAgentAgentStatus {
	readonly agentId: string;
	readonly state: DisposeAgentState;
	readonly message?: string;
}

export interface DisposeAgentDetails {
	readonly agents: readonly DisposeAgentAgentStatus[];
}

/**
 * Destroy named agents.
 *
 * Each id is handled on its own so one bad entry cannot hide the others, and
 * nothing is destroyed that was not named: dispose never follows the spawn
 * tree. An agent left behind costs nothing while idle, whereas a cascade would
 * silently kill work a sibling still depends on.
 *
 * Self-dispose is refused. Returning a tool result to an agent whose harness is
 * being torn down needs deferred disposal, which the runtime does not have.
 */
export function createDisposeAgentToolDefinition(): ToolDefinition<
	typeof disposeAgentSchema,
	DisposeAgentDetails
> {
	return {
		name: "dispose_agent",
		label: "dispose_agent",
		description:
			"Destroy one or more agents you no longer need. Each agent is stopped, its background work is cancelled, and any task it still owed is reported back to whoever assigned it as cancelled. Only the agents you name are destroyed - agents they spawned keep running. Disposing an agent is not how you finish its task: complete the task first.",
		promptSnippet: "Destroy agents that are no longer needed",
		parameters: disposeAgentSchema,
		execute: async (_toolCallId, { agentIds, reason }, context) => {
			const host = requireAgentHost(context);
			const requestedIds = Array.from(
				new Set(agentIds.map((agentId) => agentId.trim()).filter(Boolean)),
			);
			const note = reason?.trim();
			const disposeReason = note
				? `Agent ${host.agentId} disposed this agent: ${note}`
				: `Agent ${host.agentId} disposed this agent.`;

			const agents: DisposeAgentAgentStatus[] = [];
			for (const agentId of requestedIds) {
				agents.push(await disposeOne(host, agentId, disposeReason));
			}
			return {
				content: [{ type: "text", text: formatDisposeSummary(agents) }],
				details: { agents },
			};
		},
	};
}

async function disposeOne(
	host: ToolAgentHost,
	agentId: string,
	reason: string,
): Promise<DisposeAgentAgentStatus> {
	if (agentId === host.agentId) {
		return { agentId, state: "self" };
	}
	const brief = host.describe(agentId);
	if (!brief) {
		return { agentId, state: "unknown" };
	}
	if (brief.status === "disposed") {
		return { agentId, state: "already_disposed" };
	}
	try {
		await host.dispose(agentId, reason);
		return { agentId, state: "disposed" };
	} catch (error) {
		return { agentId, state: "failed", message: formatError(error) };
	}
}

function formatDisposeSummary(
	agents: readonly DisposeAgentAgentStatus[],
): string {
	if (agents.length === 0) {
		return "No agent id was given, so nothing was disposed.";
	}
	const lines = agents.map((agent) => {
		switch (agent.state) {
			case "disposed":
				return `- ${agent.agentId}: disposed`;
			case "already_disposed":
				return `- ${agent.agentId}: already disposed`;
			case "unknown":
				return `- ${agent.agentId}: unknown agent`;
			case "self":
				return `- ${agent.agentId}: refused, an agent cannot dispose itself`;
			default:
				return `- ${agent.agentId}: dispose failed: ${agent.message ?? "unknown error"}`;
		}
	});
	return `Dispose requested for agents:\n${lines.join("\n")}`;
}
