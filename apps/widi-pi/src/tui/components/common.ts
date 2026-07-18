import type { OrchestratorDiagnostic } from "../../core/diagnostics.ts";
import { singleLine } from "../format.ts";
import type { AgentViewState, TuiApplicationState } from "../state.ts";

export function activeAgent(
	state: TuiApplicationState,
): AgentViewState | undefined {
	return state.activeAgentId
		? state.agents.get(state.activeAgentId)
		: undefined;
}

export function agentLabel(agent: AgentViewState): string {
	return singleLine(
		agent.display.sessionName ??
			agent.snapshot?.profile.reference.label ??
			agent.snapshot?.profile.reference.id ??
			agent.agentId,
		80,
	);
}

export function diagnosticGlyph(diagnostic: OrchestratorDiagnostic): string {
	switch (diagnostic.severity) {
		case "error":
			return "✕";
		case "warning":
			return "▲";
		default:
			return "●";
	}
}
