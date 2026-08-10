import type { AgentSessionCandidate } from "../../../core/session-manager.ts";
import type { CommandDefinition } from "../types.ts";
import { agentSnapshotResultText } from "./utils/agents.ts";
import { sessionCandidateLabel } from "./utils/sessions.ts";

export const resumeCommand: CommandDefinition = {
	kind: "action",
	agentPolicy: "runtime",
	name: "resume",
	description: "Resume an existing agent session.",
	argumentHint: "[session]",
	checkActivity: (activity) =>
		activity.activity === "running" ? "Command /resume is not available while the agent is running." : undefined,
	complete: async ({ orchestrator }) =>
		(await orchestrator.listAgentSessions()).sessions.map((session) => ({
			// Resolve by address, not id: the session id equals the creating
			// agent's id and repeats across runs, making bare ids ambiguous.
			value: session.ref,
			label: sessionCandidateLabel(session),
			description: sessionCandidateDescription(session),
		})),
	argumentCompletes: true,
	execute: async ({ orchestrator }, argument) => {
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "resume", reference: argument.trim() } });
		return orchestrator.inspectAgent(agentId);
	},
	formatResult: (result) => agentSnapshotResultText("resumed", result),
};

function sessionCandidateDescription(session: AgentSessionCandidate): string {
	// The first message is the label when the session has no name, so repeating
	// it here would say the same thing twice.
	const preview = session.name !== undefined ? session.firstUserMessage : undefined;
	return [preview, session.cwd, session.createdAt].filter(Boolean).join(" · ");
}
