import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "../../src/core/extension/index.ts";

export const AUDIT_EVENT_ENTRY_TYPE = "event";
export const AUDIT_VERDICT_ENTRY_TYPE = "verdict";

export interface AuditDenyRule {
	readonly tool: string;
	readonly reason: string;
}

export interface AuditAskRule {
	readonly tool: string;
	readonly prompt: string;
}

export interface AuditPolicy {
	readonly deny?: readonly AuditDenyRule[];
	readonly ask?: readonly AuditAskRule[];
	readonly recordEvents?: readonly AgentHarnessEvent["type"][];
}

export interface AuditEventEntry {
	readonly eventType: AgentHarnessEvent["type"];
}

export interface AuditVerdictEntry {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly outcome: "allowed" | "blocked";
	readonly decidedBy: "default" | "deny_rule" | "human" | "human_unavailable";
	readonly reason?: string;
}

export function createAuditExtension(policy: AuditPolicy): ExtensionFactory {
	const denyRules = new Map(
		(policy.deny ?? []).map((rule) => [rule.tool, rule] as const),
	);
	const askRules = new Map(
		(policy.ask ?? []).map((rule) => [rule.tool, rule] as const),
	);
	const recordedEvents = new Set(policy.recordEvents ?? []);

	return (api) => {
		api.observe("agent_harness_event", async (event, context) => {
			if (!recordedEvents.has(event.event.type)) return;
			await context.session.appendEntry<AuditEventEntry>(
				AUDIT_EVENT_ENTRY_TYPE,
				{ eventType: event.event.type },
			);
		});

		api.intercept("tool_call", async (event, context) => {
			const denied = denyRules.get(event.toolName);
			if (denied) {
				await context.session.appendEntry<AuditVerdictEntry>(
					AUDIT_VERDICT_ENTRY_TYPE,
					{
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						outcome: "blocked",
						decidedBy: "deny_rule",
						reason: denied.reason,
					},
				);
				return { block: true, reason: denied.reason };
			}

			const asked = askRules.get(event.toolName);
			if (asked) {
				try {
					const response = await context.actions.requestHuman({
						kind: "select",
						title: `Approve tool ${event.toolName}`,
						message: asked.prompt,
						options: ["allow", "deny"],
					});
					const allowed =
						response.kind === "select" && response.value === "allow";
					const reason = allowed ? undefined : "Human approval was denied.";
					await context.session.appendEntry<AuditVerdictEntry>(
						AUDIT_VERDICT_ENTRY_TYPE,
						{
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							outcome: allowed ? "allowed" : "blocked",
							decidedBy: "human",
							reason,
						},
					);
					return allowed ? undefined : { block: true, reason };
				} catch (error) {
					const reason = `Human approval unavailable: ${formatError(error)}`;
					await context.session.appendEntry<AuditVerdictEntry>(
						AUDIT_VERDICT_ENTRY_TYPE,
						{
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							outcome: "blocked",
							decidedBy: "human_unavailable",
							reason,
						},
					);
					return { block: true, reason };
				}
			}

			await context.session.appendEntry<AuditVerdictEntry>(
				AUDIT_VERDICT_ENTRY_TYPE,
				{
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					outcome: "allowed",
					decidedBy: "default",
				},
			);
			return undefined;
		});
	};
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
