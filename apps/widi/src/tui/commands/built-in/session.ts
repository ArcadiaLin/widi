import type { AgentSessionListResult } from "../../../core/agent-orchestrator.ts";
import type { CommandDefinition } from "../types.ts";
import { sessionCandidateLabel } from "./utils/sessions.ts";

export const sessionCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "runtime",
	name: "session",
	description: "List persisted agent sessions.",
	execute: async ({ orchestrator }) => await orchestrator.listAgentSessions(),
	formatResult: (result) => {
		const { sessions } = result as AgentSessionListResult;
		if (sessions.length === 0) return "No persisted sessions.";
		return sessions.map((session) => `${sessionCandidateLabel(session)} · ${session.id}`).join("\n");
	},
};
