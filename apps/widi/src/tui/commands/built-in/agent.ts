import type { AgentListResult } from "../../../core/agent-orchestrator.ts";
import type { CommandDefinition } from "../types.ts";
import { activityLabel, profileLabel } from "./utils/agents.ts";

export const agentCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "runtime",
	name: "agent",
	description: "List runtime agents.",
	execute: async ({ orchestrator }) => orchestrator.listAgents(),
	formatResult: (result) => {
		const { agents } = result as AgentListResult;
		if (agents.length === 0) return "No runtime agents.";
		return agents.map((agent) => `${agent.agentId} · ${activityLabel(agent)} · ${profileLabel(agent)}`).join("\n");
	},
};
