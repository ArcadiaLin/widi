import type { AgentSnapshot } from "../../../core/agent-types.ts";
import type { CommandDefinition } from "../types.ts";
import { activityLabel, profileLabel, requireAgentId } from "./utils/agents.ts";

export const inspectCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "active",
	name: "inspect",
	description: "Inspect the current agent runtime facts.",
	execute: async (context) => context.orchestrator.inspectAgent(requireAgentId(context)),
	formatResult: (result) => {
		const snapshot = result as AgentSnapshot;
		return [
			`${snapshot.agentId} · ${activityLabel(snapshot)} · ${profileLabel(snapshot)} · ${snapshot.model.provider}/${snapshot.model.id}`,
			`${snapshot.tools.toolNames.length} tools · ${snapshot.extensions.extensionIds.length} extensions`,
		].join("\n");
	},
};
