/**
 * Cross-agent links read out of a single session's own entries.
 *
 * A spawn tree is persisted as a directory tree, and that is where the *shape*
 * comes from. What the directory tree cannot say is where inside a conversation
 * one agent reached for another: which tool call created it, which turn was
 * woken by its report, when it was released. Those facts only exist in the
 * structured `details` the agent tools and the message hub already write, so
 * this module reads them and nothing else.
 *
 * Every field is probed rather than trusted. These details are written by a
 * runtime that keeps evolving, and a link that fails to parse must cost its
 * chip, not the record.
 */

import type { RawEntry } from "../load/session-file.ts";
import type { LinkDirection, LinkKind, RecordLink } from "./types.ts";

export const ORCHESTRATOR_MESSAGE_TYPE = "core:orchestrator_message";
export const EXTENSION_MESSAGE_TYPE = "core:extension_message";

/** A link before its agent ids have been resolved against the session tree. */
export interface RawLink {
	readonly kind: LinkKind;
	readonly direction: LinkDirection;
	readonly targets: readonly { readonly agentId: string; readonly note?: string }[];
	readonly status?: string;
	readonly reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

/** The link a tool result carries, if that tool is one that reaches an agent. */
export function linkFromToolResult(toolName: string, details: unknown): RawLink | undefined {
	if (!isRecord(details)) return undefined;
	if (toolName === "spawn_agent") {
		const targets = asArray(details.agents).flatMap((agent) => {
			if (!isRecord(agent)) return [];
			const agentId = asString(agent.agentId);
			if (agentId === undefined) return [];
			const note = [asString(agent.profileId), agent.watching === true ? "watched" : undefined, asString(agent.error)]
				.filter((part): part is string => part !== undefined)
				.join(" · ");
			return [{ agentId, ...(note === "" ? undefined : { note }) }];
		});
		return targets.length === 0 ? undefined : { kind: "spawn", direction: "out", targets };
	}
	if (toolName === "dispose_agent") {
		const targets = asArray(details.agents).flatMap((agent) => {
			if (!isRecord(agent)) return [];
			const agentId = asString(agent.agentId);
			if (agentId === undefined) return [];
			const note = asString(agent.state);
			return [{ agentId, ...(note === undefined ? undefined : { note }) }];
		});
		return targets.length === 0 ? undefined : { kind: "dispose", direction: "out", targets };
	}
	if (toolName === "send_message") {
		const agentId = asString(details.targetAgentId);
		if (agentId === undefined) return undefined;
		const note = details.watching === true ? "watched" : undefined;
		return {
			kind: "message",
			direction: "out",
			targets: [{ agentId, ...(note === undefined ? undefined : { note }) }],
		};
	}
	if (toolName === "watch_agent") {
		const agentId = asString(details.agentId);
		if (agentId === undefined) return undefined;
		const note = asString(details.outcome);
		return { kind: "watch", direction: "out", targets: [{ agentId, ...(note === undefined ? undefined : { note }) }] };
	}
	return undefined;
}

/**
 * The link a delivered message carries.
 *
 * `MessageSource` is the identity axis of the message hub: whoever handed the
 * text over said who wrote it. For an agent that is the sender's id, and for the
 * runtime speaking *about* an agent it is that plus a notice - the status that
 * makes a woken turn traceable back to the child that ended.
 */
export function linkFromMessageDetails(details: unknown): RawLink | undefined {
	if (!isRecord(details)) return undefined;
	const source = isRecord(details.source) ? details.source : undefined;
	if (source === undefined || source.kind !== "agent") return undefined;
	const sourceDetails = isRecord(source.details) ? source.details : undefined;
	const agentId = asString(sourceDetails?.senderAgentId) ?? asString(source.label);
	if (agentId === undefined) return undefined;
	const notice = isRecord(sourceDetails?.notice) ? sourceDetails.notice : undefined;
	if (notice === undefined) {
		return { kind: "message", direction: "in", targets: [{ agentId, note: "sent to this agent" }] };
	}
	return {
		kind: "notice",
		direction: "in",
		targets: [{ agentId }],
		...(asString(notice.status) === undefined ? undefined : { status: asString(notice.status) }),
		...(asString(notice.reason) === undefined ? undefined : { reason: asString(notice.reason) }),
	};
}

/** The `MessageSource` of a delivered message, for display. */
export function messageSource(details: unknown): { kind: string; label?: string } | undefined {
	if (!isRecord(details)) return undefined;
	const source = isRecord(details.source) ? details.source : undefined;
	const kind = asString(source?.kind);
	if (kind === undefined) return undefined;
	const label = asString(source?.label);
	return { kind, ...(label === undefined ? undefined : { label }) };
}

/** The body a delivered message carried before the runtime wrapped it. */
export function messageBody(details: unknown): string | undefined {
	return isRecord(details) ? asString(details.body) : undefined;
}

/** Resolve a raw link's agent ids into session keys. */
export function resolveLink(link: RawLink, keyOfAgent: (agentId: string) => string | undefined): RecordLink {
	return {
		kind: link.kind,
		direction: link.direction,
		targets: link.targets.map((target) => ({
			agentId: target.agentId,
			agentKey: keyOfAgent(target.agentId) ?? null,
			...(target.note === undefined ? undefined : { note: target.note }),
		})),
		...(link.status === undefined ? undefined : { status: link.status }),
		...(link.reason === undefined ? undefined : { reason: link.reason }),
	};
}

/** Custom entry types whose payload is a delivered message rather than state. */
export function isDeliveredMessageType(customType: string | undefined): boolean {
	return customType === ORCHESTRATOR_MESSAGE_TYPE || customType === EXTENSION_MESSAGE_TYPE;
}

/** The custom message entry shape, for both places the runtime writes it. */
export function customMessageOf(
	entry: RawEntry,
): { customType: string; content: unknown; details: unknown } | undefined {
	if (entry.type === "custom_message") {
		const raw = entry as { customType?: string; content?: unknown; details?: unknown };
		return { customType: raw.customType ?? "", content: raw.content, details: raw.details };
	}
	if (entry.type === "message") {
		const message = (entry as { message?: unknown }).message;
		if (isRecord(message) && message.role === "custom") {
			return { customType: asString(message.customType) ?? "", content: message.content, details: message.details };
		}
	}
	return undefined;
}
