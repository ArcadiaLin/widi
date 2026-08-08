import type { TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { MessageEntry, SessionTreeEntry } from "@widi/agent-core";
import type { AgentSessionTreeSnapshot } from "../core/session-manager.ts";

/**
 * One navigable row of a session tree: a user message, placed by its nearest
 * user-message ancestor. The navigation targets are the user's own messages -
 * the same source as the /fork and /tree candidates - because those are the
 * "points in the conversation" a user thinks in.
 */
export interface SessionEntryTreeRow {
	readonly entryId: string;
	readonly headline: string;
	readonly timestamp: string;
	/** 0 for root messages, +1 per user-message generation below. */
	readonly depth: number;
	/** Whether the row is the last among its siblings (└── vs ├──). */
	readonly last: boolean;
	/** The row the current leaf hangs under; navigation starts from here. */
	readonly current: boolean;
}

/**
 * Flatten a session tree snapshot into preorder rows over its user messages.
 * Non-message entries still shape the tree: a message's row parent is its
 * nearest ancestor that is itself a user message, so branch structure created
 * by tree navigation shows through the assistant/tool entries in between.
 * Sibling order follows append order, which is stable across reads.
 */
export function buildSessionEntryRows(tree: AgentSessionTreeSnapshot): SessionEntryTreeRow[] {
	const byId = new Map(tree.entries.map((entry) => [entry.id, entry]));
	const currentId = nearestUserMessageId(byId, tree.leafId);
	const roots: UserMessageEntry[] = [];
	const childrenOf = new Map<string, UserMessageEntry[]>();
	for (const entry of tree.entries) {
		if (!isUserMessageEntry(entry)) continue;
		const parentId = nearestUserMessageId(byId, entry.parentId);
		if (parentId === null) {
			roots.push(entry);
			continue;
		}
		const siblings = childrenOf.get(parentId) ?? [];
		siblings.push(entry);
		childrenOf.set(parentId, siblings);
	}
	const rows: SessionEntryTreeRow[] = [];
	const visit = (entries: readonly UserMessageEntry[], depth: number): void => {
		for (const [index, entry] of entries.entries()) {
			rows.push({
				entryId: entry.id,
				headline: userMessageHeadline(entry.message),
				timestamp: entry.timestamp,
				depth,
				last: index === entries.length - 1,
				current: entry.id === currentId,
			});
			visit(childrenOf.get(entry.id) ?? [], depth + 1);
		}
	};
	visit(roots, 0);
	return rows;
}

/**
 * Preselect for a typed query that did not resolve to an entry: an exact or
 * unique-prefix id hit wins, then the first headline containing the query.
 */
export function findSessionEntryRow(rows: readonly SessionEntryTreeRow[], query: string): string | undefined {
	const trimmed = query.trim();
	if (trimmed === "") return undefined;
	const exact = rows.find((row) => row.entryId === trimmed);
	if (exact) return exact.entryId;
	const prefixed = rows.filter((row) => row.entryId.startsWith(trimmed));
	if (prefixed.length === 1 && prefixed[0]) return prefixed[0].entryId;
	const lower = trimmed.toLowerCase();
	return rows.find((row) => row.headline.toLowerCase().includes(lower))?.entryId;
}

/** First non-empty line of the user's text, capped at one display line. */
export function userMessageHeadline(message: UserMessage): string {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part): part is TextContent => part.type === "text")
					.map((part) => part.text)
					.join(" ");
	const line =
		text
			.split("\n")
			.find((candidate) => candidate.trim() !== "")
			?.trim() ?? "";
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

type UserMessageEntry = MessageEntry & { message: UserMessage };

function isUserMessageEntry(entry: SessionTreeEntry): entry is UserMessageEntry {
	return entry.type === "message" && entry.message.role === "user";
}

/** Nearest user message at or above an entry, walking the parent chain. */
function nearestUserMessageId(byId: ReadonlyMap<string, SessionTreeEntry>, startId: string | null): string | null {
	let cursor = startId;
	while (cursor !== null) {
		const entry = byId.get(cursor);
		if (!entry) return null;
		if (isUserMessageEntry(entry)) return entry.id;
		cursor = entry.parentId;
	}
	return null;
}
