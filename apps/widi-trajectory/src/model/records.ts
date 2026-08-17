/**
 * Entries to records.
 *
 * A record is one readable line of a run. That is deliberately not one entry:
 * an assistant entry that emits three tool calls is four things a reader wants
 * to see separately, and a tool result is not a thing at all on its own - it is
 * the second half of the call that asked for it. So an assistant entry yields
 * its reasoning, its reply and one record per tool call, and a tool result entry
 * yields nothing, having been folded into the call it answers.
 *
 * Timing follows the same source of truth. An assistant message carries the
 * moment its request started, while its entry carries the moment the reply was
 * written, so the two together are the request's real span. A tool call's start
 * is the timestamp of the entry its result hangs from: results chain one after
 * the other, so the parent of a result is exactly what preceded that call.
 * Nothing here invents a duration it cannot derive.
 */

import type {
	RawAssistantMessage,
	RawContent,
	RawEntry,
	RawToolResultMessage,
	RawUsage,
	RawUserMessage,
} from "../load/session-file.ts";
import { type ImageAllowance, stringify, summarize, summarizeBlocks, toBlocks } from "./content.ts";
import {
	customMessageOf,
	isDeliveredMessageType,
	linkFromMessageDetails,
	linkFromToolResult,
	messageBody,
	messageSource,
	type RawLink,
	resolveLink,
} from "./links.ts";
import type { ContentBlock, RecordFact, TrajectoryRecord, UsageSummary } from "./types.ts";

export interface RecordSet {
	/** Every record, ordered by the file order of the entry that produced it. */
	readonly records: readonly TrajectoryRecord[];
	/** Record ids per entry, in the order they should be read. */
	readonly byEntryId: ReadonlyMap<string, readonly string[]>;
}

export interface BuildRecordsOptions {
	readonly entries: readonly RawEntry[];
	readonly images: ImageAllowance;
	/** Session key of the agent an id names, when it left a session on disk. */
	readonly keyOfAgent: (agentId: string) => string | undefined;
}

function timeOf(entry: RawEntry): number {
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

function usageOf(usage: RawUsage | undefined): UsageSummary | undefined {
	if (usage === undefined) return undefined;
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(usage.reasoning === undefined ? undefined : { reasoning: usage.reasoning }),
		total: usage.totalTokens ?? input + output + cacheRead + cacheWrite,
		cost: usage.cost?.total ?? 0,
	};
}

function toolCallsOf(message: RawAssistantMessage): { id: string; name: string; args: unknown }[] {
	return message.content.flatMap((block) => {
		if (block.type !== "toolCall") return [];
		const call = block as { id?: string; name?: string; arguments?: unknown };
		if (typeof call.id !== "string") return [];
		return [{ id: call.id, name: call.name ?? "tool", args: call.arguments }];
	});
}

interface ToolResultRef {
	readonly entry: RawEntry;
	readonly message: RawToolResultMessage;
}

function indexToolResults(entries: readonly RawEntry[]): Map<string, ToolResultRef> {
	const byCallId = new Map<string, ToolResultRef>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = (entry as { message: unknown }).message as { role?: string };
		if (message.role !== "toolResult") continue;
		const result = message as unknown as RawToolResultMessage;
		if (typeof result.toolCallId !== "string") continue;
		if (!byCallId.has(result.toolCallId)) byCallId.set(result.toolCallId, { entry, message: result });
	}
	return byCallId;
}

function labelsOf(entries: readonly RawEntry[]): Map<string, string> {
	const labels = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "label") continue;
		const raw = entry as { targetId?: string; label?: string };
		if (typeof raw.targetId !== "string") continue;
		const label = raw.label?.trim();
		if (label) labels.set(raw.targetId, label);
		else labels.delete(raw.targetId);
	}
	return labels;
}

function metaRecord(entry: RawEntry, title: string, summary: string, facts: RecordFact[]): TrajectoryRecord {
	const at = timeOf(entry);
	return {
		id: entry.id,
		entryId: entry.id,
		kind: "meta",
		title,
		summary,
		startedAt: at,
		endedAt: at,
		...(facts.length === 0 ? undefined : { facts }),
	};
}

function describeMeta(entry: RawEntry): TrajectoryRecord | undefined {
	if (entry.type === "model_change") {
		const raw = entry as { provider?: string; modelId?: string };
		const summary = `${raw.provider ?? "?"} / ${raw.modelId ?? "?"}`;
		return metaRecord(entry, "model", summary, [
			{ name: "provider", value: raw.provider ?? "" },
			{ name: "model", value: raw.modelId ?? "" },
		]);
	}
	if (entry.type === "active_tools_change") {
		const names = (entry as { activeToolNames?: readonly string[] }).activeToolNames ?? [];
		return metaRecord(entry, "tools", `${names.length} active: ${names.join(", ")}`, [
			{ name: "count", value: String(names.length) },
		]);
	}
	if (entry.type === "thinking_level_change") {
		const level = (entry as { thinkingLevel?: string }).thinkingLevel ?? "";
		return metaRecord(entry, "thinking", level, [{ name: "level", value: level }]);
	}
	if (entry.type === "custom") {
		const raw = entry as { customType?: string; data?: unknown };
		const record = metaRecord(entry, raw.customType ?? "custom", summarize(stringify(raw.data)), []);
		return { ...record, blocks: [{ type: "json", text: stringify(raw.data) }] };
	}
	if (entry.type === "session_info") {
		const name = (entry as { name?: string }).name ?? "";
		return metaRecord(entry, "session name", name, [{ name: "name", value: name }]);
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		const raw = entry as { summary?: string; tokensBefore?: number; fromId?: string; usage?: RawUsage };
		const at = timeOf(entry);
		const blocks: ContentBlock[] = raw.summary ? [{ type: "text", text: raw.summary }] : [];
		return {
			id: entry.id,
			entryId: entry.id,
			kind: "compaction",
			title: entry.type === "compaction" ? "compaction" : "branch summary",
			summary: summarize(raw.summary ?? ""),
			startedAt: at,
			endedAt: at,
			blocks,
			...(usageOf(raw.usage) === undefined ? undefined : { usage: usageOf(raw.usage) }),
			facts: [
				...(raw.tokensBefore === undefined ? [] : [{ name: "tokens before", value: String(raw.tokensBefore) }]),
				...(raw.fromId === undefined ? [] : [{ name: "from entry", value: raw.fromId }]),
			],
		};
	}
	if (entry.type === "leaf" || entry.type === "label") return undefined;
	// An entry type this build does not know still belongs on the ledger; the
	// inspector shows what it actually contained.
	const record = metaRecord(entry, entry.type, "", []);
	return { ...record, blocks: [{ type: "json", text: stringify(entry) }] };
}

export function buildRecords(options: BuildRecordsOptions): RecordSet {
	const { entries, images, keyOfAgent } = options;
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const toolResults = indexToolResults(entries);
	const labels = labelsOf(entries);
	const records: TrajectoryRecord[] = [];
	const byEntryId = new Map<string, string[]>();

	const emit = (entry: RawEntry, record: TrajectoryRecord): void => {
		const label = labels.get(entry.id);
		records.push(label === undefined ? record : { ...record, label });
		const ids = byEntryId.get(entry.id) ?? [];
		ids.push(record.id);
		byEntryId.set(entry.id, ids);
	};

	const link = (raw: RawLink | undefined) => (raw === undefined ? undefined : resolveLink(raw, keyOfAgent));

	for (const entry of entries) {
		const at = timeOf(entry);
		const custom = customMessageOf(entry);
		if (custom !== undefined) {
			const delivered = isDeliveredMessageType(custom.customType);
			const body = messageBody(custom.details);
			const blocks = toBlocks(
				(body === undefined ? custom.content : body) as string | readonly RawContent[] | undefined,
				images,
			);
			const raw = toBlocks(custom.content as string | readonly RawContent[] | undefined, images);
			emit(entry, {
				id: entry.id,
				entryId: entry.id,
				kind: delivered ? "notice" : "meta",
				title: custom.customType || "custom",
				summary: summarizeBlocks(blocks.length === 0 ? raw : blocks),
				startedAt: at,
				endedAt: at,
				blocks: blocks.length === 0 ? raw : blocks,
				...(body === undefined || raw.length === 0 ? undefined : { output: raw }),
				...(messageSource(custom.details) === undefined ? undefined : { source: messageSource(custom.details) }),
				...(link(linkFromMessageDetails(custom.details)) === undefined
					? undefined
					: { link: link(linkFromMessageDetails(custom.details)) }),
			});
			continue;
		}

		if (entry.type !== "message") {
			const meta = describeMeta(entry);
			if (meta !== undefined) emit(entry, meta);
			continue;
		}

		const message = (entry as { message: unknown }).message as { role?: string };
		if (message.role === "user") {
			const user = message as unknown as RawUserMessage;
			const blocks = toBlocks(user.content, images);
			emit(entry, {
				id: entry.id,
				entryId: entry.id,
				kind: "user",
				title: "user",
				summary: summarizeBlocks(blocks),
				startedAt: at,
				endedAt: at,
				blocks,
			});
			continue;
		}

		if (message.role === "toolResult") continue;

		if (message.role !== "assistant") {
			const meta = describeMeta(entry);
			if (meta !== undefined) emit(entry, meta);
			continue;
		}

		const assistant = message as unknown as RawAssistantMessage;
		const startedAt = typeof assistant.timestamp === "number" ? assistant.timestamp : at;
		const allBlocks = toBlocks(assistant.content, images);
		const thinking = allBlocks.filter((block) => block.type === "thinking");
		const blocks = allBlocks.filter((block) => block.type !== "thinking");
		const calls = toolCallsOf(assistant);
		if (thinking.length > 0) {
			const reasoning = usageOf(assistant.usage)?.reasoning;
			emit(entry, {
				id: `${entry.id}#thinking`,
				entryId: entry.id,
				kind: "thinking",
				title: "thinking",
				summary: summarizeBlocks(thinking),
				// The request's span is known; where inside it the model was reasoning
				// is not, so this marks the moment rather than claiming a duration.
				startedAt: Math.min(startedAt, at),
				endedAt: Math.min(startedAt, at),
				blocks: thinking,
				...(reasoning === undefined ? undefined : { facts: [{ name: "reasoning tokens", value: String(reasoning) }] }),
			});
		}
		emit(entry, {
			id: entry.id,
			entryId: entry.id,
			kind: "assistant",
			title: "assistant",
			summary:
				summarizeBlocks(blocks) || (calls.length === 0 ? "" : `calls ${calls.map((call) => call.name).join(", ")}`),
			startedAt: Math.min(startedAt, at),
			endedAt: at,
			...(assistant.stopReason === undefined ? undefined : { stopReason: assistant.stopReason }),
			...(assistant.errorMessage === undefined ? undefined : { errorMessage: assistant.errorMessage, isError: true }),
			...(usageOf(assistant.usage) === undefined ? undefined : { usage: usageOf(assistant.usage) }),
			...(assistant.model === undefined
				? undefined
				: {
						model: {
							provider: assistant.provider ?? "",
							model: assistant.model,
							...(assistant.api === undefined ? undefined : { api: assistant.api }),
						},
					}),
			blocks,
		});

		for (const call of calls) {
			const result = toolResults.get(call.id);
			const parent = result === undefined ? undefined : byId.get(result.entry.parentId ?? "");
			const callStartedAt = parent === undefined ? at : timeOf(parent);
			const callEndedAt = result === undefined ? callStartedAt : timeOf(result.entry);
			const output = result === undefined ? [] : toBlocks(result.message.content, images);
			const detailsLink = result === undefined ? undefined : linkFromToolResult(call.name, result.message.details);
			emit(entry, {
				id: `${entry.id}#${call.id}`,
				entryId: entry.id,
				kind: "tool",
				title: call.name,
				summary:
					result === undefined
						? summarize(stringify(call.args), 160)
						: summarizeBlocks(output) || summarize(stringify(call.args), 160),
				startedAt: Math.min(callStartedAt, callEndedAt),
				endedAt: Math.max(callStartedAt, callEndedAt),
				...(result?.message.isError === true ? { isError: true } : undefined),
				toolCall: {
					id: call.id,
					name: call.name,
					argumentsJson: stringify(call.args ?? {}),
					settled: result !== undefined,
				},
				blocks: [{ type: "json", text: stringify(call.args ?? {}) }],
				output,
				...(result?.message.details === undefined ? undefined : { details: stringify(result.message.details) }),
				...(link(detailsLink) === undefined ? undefined : { link: link(detailsLink) }),
			});
		}
	}

	return { records, byEntryId };
}
