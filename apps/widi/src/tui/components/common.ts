import type { OrchestratorDiagnostic } from "../../core/diagnostics.ts";
import type {
	ExtensionStatusRegion,
	ExtensionStatusSnapshot,
	ExtensionTone,
} from "../../core/extension/presentation.ts";
import type { AgentMaintenanceKind } from "../../core/types.ts";
import { singleLine } from "../format.ts";
import type { AgentViewState, TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";

export function activeAgent(state: TuiApplicationState): AgentViewState | undefined {
	return state.activeAgentId ? state.agents.get(state.activeAgentId) : undefined;
}

/** Display word for maintenance work, e.g. "Compacting" in "Compacting…". */
export function maintenanceLabel(kind: AgentMaintenanceKind): string {
	return kind === "compaction" ? "Compacting" : "Navigating";
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
	}
}

/**
 * Map an extension tone onto the theme's status hues. Tones are semantic
 * emphasis, not colors (`ExtensionTone` in core), so this is the one place
 * that pairing is decided; "neutral" (and an unset tone) means no paint.
 */
export function tonePaint(tone: ExtensionTone | undefined): (text: string) => string {
	switch (tone) {
		case "info":
			return theme.info;
		case "success":
			return theme.ok;
		case "warning":
			return theme.warn;
		case "danger":
			return theme.error;
		default:
			return (text) => text;
	}
}

/** Statuses an extension aimed at one region; an unset region means "panel". */
export function extensionStatusesInRegion(
	agent: AgentViewState,
	region: ExtensionStatusRegion,
): ExtensionStatusSnapshot[] {
	return [...agent.extensionStatuses.values()].filter((entry) => (entry.status.region ?? "panel") === region);
}

/** The freshest status aimed at a region, for clients that show only one. */
export function latestExtensionStatus(
	agent: AgentViewState | undefined,
	region: ExtensionStatusRegion,
): ExtensionStatusSnapshot | undefined {
	if (!agent) return undefined;
	let latest: ExtensionStatusSnapshot | undefined;
	for (const entry of agent.extensionStatuses.values()) {
		if ((entry.status.region ?? "panel") !== region) continue;
		// ISO 8601 timestamps order lexicographically.
		if (!latest || entry.updatedAt > latest.updatedAt) latest = entry;
	}
	return latest;
}
