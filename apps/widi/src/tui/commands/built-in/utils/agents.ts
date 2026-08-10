import type { AgentSnapshot } from "../../../../core/agent-types.ts";
import type { AgentMaintenanceKind } from "../../../../core/types.ts";
import { maintenanceDescription } from "../../../../core/types.ts";
import type { CommandContext } from "../../types.ts";

export function requireAgentId(context: CommandContext): string {
	if (!context.agentId) throw new Error("Command requires an active agent.");
	return context.agentId;
}

export function unavailableDuringMaintenance(
	commandName: string,
	maintenance: AgentMaintenanceKind | undefined,
): string | undefined {
	if (!maintenance) return undefined;
	return `Command /${commandName} is not available during ${maintenanceDescription(maintenance)}.`;
}

export function profileLabel(snapshot: AgentSnapshot): string {
	return snapshot.profile.reference.label ?? snapshot.profile.reference.id;
}

/** Maintenance is what a bare "running" would hide, so it is named instead. */
export function activityLabel(snapshot: AgentSnapshot): string {
	return snapshot.activity.maintenance ?? snapshot.activity.activity;
}

// Resume and fork both answer "which agent did I land on".
export function agentSnapshotResultText(verb: string, result: unknown): string {
	const snapshot = result as AgentSnapshot;
	return `${verb} ${snapshot.agentId} · ${profileLabel(snapshot)} · ${snapshot.model.id}`;
}
