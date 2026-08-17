/**
 * Reading `session.jsonl` from outside the runtime.
 *
 * The entry types are declared here structurally rather than imported from the
 * agent core on purpose. This tool reads bytes another build wrote, possibly a
 * newer one: an entry type it does not know must render as an unknown record,
 * not fail the file. So every field is optional until it has been checked, and
 * anything unrecognised keeps its raw JSON for the inspector.
 *
 * Only two failures are fatal for a file: an unreadable header, and a line that
 * is not JSON in the middle of the file. A torn last line is the expected shape
 * of a killed run and is dropped with a diagnostic, exactly as the runtime's own
 * loader does.
 */

import { readFile } from "node:fs/promises";

export const SESSION_FORMAT_VERSION = 3;

export interface RawSessionHeader {
	readonly type: "session";
	readonly version: number;
	readonly id: string;
	readonly timestamp: string;
	readonly cwd: string;
	readonly parentSession?: string;
	readonly metadata?: Record<string, unknown>;
}

export interface RawEntryBase {
	readonly type: string;
	readonly id: string;
	readonly parentId: string | null;
	readonly timestamp: string;
}

export interface RawUsage {
	readonly input?: number;
	readonly output?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly reasoning?: number;
	readonly totalTokens?: number;
	readonly cost?: { readonly total?: number };
}

export type RawContent =
	| { readonly type: "text"; readonly text?: string }
	| { readonly type: "thinking"; readonly thinking?: string; readonly redacted?: boolean }
	| { readonly type: "image"; readonly data?: string; readonly mimeType?: string }
	| { readonly type: "toolCall"; readonly id?: string; readonly name?: string; readonly arguments?: unknown }
	| { readonly type: string };

export interface RawUserMessage {
	readonly role: "user";
	readonly content: string | readonly RawContent[];
	readonly timestamp?: number;
}

export interface RawAssistantMessage {
	readonly role: "assistant";
	readonly content: readonly RawContent[];
	readonly api?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly usage?: RawUsage;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly timestamp?: number;
}

export interface RawToolResultMessage {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName?: string;
	readonly content?: readonly RawContent[];
	readonly details?: unknown;
	readonly isError?: boolean;
	readonly usage?: RawUsage;
	readonly timestamp?: number;
}

export interface RawCustomMessage {
	readonly role: "custom";
	readonly customType?: string;
	readonly content?: string | readonly RawContent[];
	readonly details?: unknown;
	readonly display?: boolean;
	readonly timestamp?: number;
}

export type RawMessage = RawUserMessage | RawAssistantMessage | RawToolResultMessage | RawCustomMessage;

export interface RawMessageEntry extends RawEntryBase {
	readonly type: "message";
	readonly message: RawMessage;
}

export interface RawCustomMessageEntry extends RawEntryBase {
	readonly type: "custom_message";
	readonly customType: string;
	readonly content?: string | readonly RawContent[];
	readonly details?: unknown;
	readonly display?: boolean;
}

export interface RawCustomEntry extends RawEntryBase {
	readonly type: "custom";
	readonly customType: string;
	readonly data?: unknown;
}

export interface RawCompactionEntry extends RawEntryBase {
	readonly type: "compaction";
	readonly summary?: string;
	readonly firstKeptEntryId?: string;
	readonly tokensBefore?: number;
	readonly usage?: RawUsage;
	readonly fromHook?: boolean;
}

export interface RawBranchSummaryEntry extends RawEntryBase {
	readonly type: "branch_summary";
	readonly fromId?: string;
	readonly summary?: string;
	readonly usage?: RawUsage;
}

export interface RawModelChangeEntry extends RawEntryBase {
	readonly type: "model_change";
	readonly provider?: string;
	readonly modelId?: string;
}

export interface RawActiveToolsChangeEntry extends RawEntryBase {
	readonly type: "active_tools_change";
	readonly activeToolNames?: readonly string[];
}

export interface RawThinkingLevelChangeEntry extends RawEntryBase {
	readonly type: "thinking_level_change";
	readonly thinkingLevel?: string;
}

export interface RawLabelEntry extends RawEntryBase {
	readonly type: "label";
	readonly targetId: string;
	readonly label?: string;
}

export interface RawSessionInfoEntry extends RawEntryBase {
	readonly type: "session_info";
	readonly name?: string;
}

export interface RawLeafEntry extends RawEntryBase {
	readonly type: "leaf";
	readonly targetId: string | null;
}

export interface RawUnknownEntry extends RawEntryBase {
	readonly type: string;
	readonly [key: string]: unknown;
}

export type RawEntry =
	| RawMessageEntry
	| RawCustomMessageEntry
	| RawCustomEntry
	| RawCompactionEntry
	| RawBranchSummaryEntry
	| RawModelChangeEntry
	| RawActiveToolsChangeEntry
	| RawThinkingLevelChangeEntry
	| RawLabelEntry
	| RawSessionInfoEntry
	| RawLeafEntry
	| RawUnknownEntry;

export interface SessionFile {
	readonly header: RawSessionHeader;
	readonly entries: readonly RawEntry[];
	/** Entry the session was left on, resolved the way the runtime resolves it. */
	readonly leafId: string | null;
	readonly warnings: readonly string[];
}

export class SessionFileError extends Error {
	readonly path: string;

	constructor(path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "SessionFileError";
		this.path = path;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHeader(line: string, path: string): RawSessionHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new SessionFileError(path, "first line is not JSON");
	}
	if (!isRecord(parsed) || parsed.type !== "session") {
		throw new SessionFileError(path, "first line is not a session header");
	}
	if (typeof parsed.id !== "string" || typeof parsed.timestamp !== "string") {
		throw new SessionFileError(path, "session header is missing id or timestamp");
	}
	return {
		type: "session",
		version: typeof parsed.version === "number" ? parsed.version : SESSION_FORMAT_VERSION,
		id: parsed.id,
		timestamp: parsed.timestamp,
		cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
		...(typeof parsed.parentSession === "string" ? { parentSession: parsed.parentSession } : undefined),
		...(isRecord(parsed.metadata) ? { metadata: parsed.metadata } : undefined),
	};
}

/**
 * The leaf after an entry: a `leaf` entry moves it to its target, anything else
 * becomes the leaf itself. Mirrors the runtime, and is the only reason the file
 * order matters at all - everything else is reconstructed from parent links.
 */
function leafAfter(entry: RawEntry): string | null {
	return entry.type === "leaf" ? ((entry as RawLeafEntry).targetId ?? null) : entry.id;
}

export async function readSessionFile(path: string): Promise<SessionFile> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new SessionFileError(path, `cannot be read (${(error as Error).message})`);
	}
	const lines = text.split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	if (lines.length === 0) throw new SessionFileError(path, "file is empty");

	const header = parseHeader(lines[0], path);
	const warnings: string[] = [];
	if (header.version !== SESSION_FORMAT_VERSION) {
		warnings.push(`session format version ${header.version} is not ${SESSION_FORMAT_VERSION}; reading it anyway`);
	}

	const entries: RawEntry[] = [];
	const seen = new Set<string>();
	let leafId: string | null = null;
	for (let index = 1; index < lines.length; index++) {
		const line = lines[index];
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			if (index === lines.length - 1) {
				warnings.push(`dropped a torn last line (line ${index + 1})`);
				break;
			}
			throw new SessionFileError(path, `line ${index + 1} is not JSON`);
		}
		if (!isRecord(parsed) || typeof parsed.type !== "string" || typeof parsed.id !== "string") {
			warnings.push(`skipped line ${index + 1}: not a session entry`);
			continue;
		}
		if (seen.has(parsed.id)) {
			warnings.push(`skipped line ${index + 1}: duplicate entry id ${parsed.id}`);
			continue;
		}
		const entry = parsed as unknown as RawEntry;
		seen.add(entry.id);
		entries.push(entry);
		leafId = leafAfter(entry);
	}

	if (leafId !== null && !seen.has(leafId)) {
		warnings.push(`leaf ${leafId} is not in the file; falling back to the last entry`);
		leafId = entries.length === 0 ? null : entries[entries.length - 1].id;
	}
	return { header, entries, leafId, warnings };
}
