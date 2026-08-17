/**
 * Session trees written to a temp directory.
 *
 * The tests read real files rather than injected objects: the loader's job is
 * to recover a spawn tree from a directory layout, and a fake filesystem would
 * be testing the fake.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FixtureEntry {
	readonly type: string;
	readonly id: string;
	readonly parentId: string | null;
	readonly timestamp: string;
	readonly [key: string]: unknown;
}

export interface FixtureSession {
	readonly dirName: string;
	readonly id: string;
	readonly timestamp: string;
	readonly cwd?: string;
	readonly metadata?: Record<string, unknown>;
	readonly entries: readonly FixtureEntry[];
	readonly children?: readonly FixtureSession[];
	/** Appended verbatim after the entries, for torn-tail and junk-line cases. */
	readonly trailer?: string;
}

export async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "widi-trajectory-"));
}

export async function writeSessionTree(root: string, session: FixtureSession): Promise<string> {
	const dirPath = join(root, session.dirName);
	await mkdir(dirPath, { recursive: true });
	const header = {
		type: "session",
		version: 3,
		id: session.id,
		timestamp: session.timestamp,
		cwd: session.cwd ?? "/work",
		...(session.metadata === undefined ? undefined : { metadata: session.metadata }),
	};
	const lines = [JSON.stringify(header), ...session.entries.map((entry) => JSON.stringify(entry))];
	await writeFile(join(dirPath, "session.jsonl"), `${lines.join("\n")}\n${session.trailer ?? ""}`, "utf8");
	if (session.children !== undefined && session.children.length > 0) {
		const agentsDir = join(dirPath, "agents");
		await mkdir(agentsDir, { recursive: true });
		for (const child of session.children) await writeSessionTree(agentsDir, child);
	}
	return dirPath;
}

export function userEntry(id: string, parentId: string | null, timestamp: string, text: string): FixtureEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(timestamp) },
	};
}

export function assistantEntry(
	id: string,
	parentId: string | null,
	timestamp: string,
	options: {
		readonly text?: string;
		readonly thinking?: string;
		readonly startedAt?: string;
		readonly toolCalls?: readonly { id: string; name: string; arguments?: unknown }[];
		readonly usage?: Record<string, unknown>;
	} = {},
): FixtureEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [
				...(options.thinking === undefined ? [] : [{ type: "thinking", thinking: options.thinking }]),
				...(options.text === undefined ? [] : [{ type: "text", text: options.text }]),
				...(options.toolCalls ?? []).map((call) => ({
					type: "toolCall",
					id: call.id,
					name: call.name,
					arguments: call.arguments ?? {},
				})),
			],
			api: "openai-completions",
			provider: "test",
			model: "test-model",
			usage: options.usage ?? {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			},
			stopReason: (options.toolCalls ?? []).length > 0 ? "toolUse" : "stop",
			timestamp: Date.parse(options.startedAt ?? timestamp),
		},
	};
}

export function toolResultEntry(
	id: string,
	parentId: string,
	timestamp: string,
	options: {
		readonly toolCallId: string;
		readonly toolName: string;
		readonly text?: string;
		readonly details?: unknown;
		readonly isError?: boolean;
	},
): FixtureEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId: options.toolCallId,
			toolName: options.toolName,
			content: [{ type: "text", text: options.text ?? "ok" }],
			...(options.details === undefined ? undefined : { details: options.details }),
			isError: options.isError ?? false,
			timestamp: Date.parse(timestamp),
		},
	};
}

export function noticeEntry(
	id: string,
	parentId: string | null,
	timestamp: string,
	options: {
		readonly senderAgentId: string;
		readonly body: string;
		readonly notice?: { status: string; reason?: string };
	},
): FixtureEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "custom",
			customType: "core:orchestrator_message",
			content: `<agent-notification from="${options.senderAgentId}">\n${options.body}\n</agent-notification>`,
			display: true,
			details: {
				source: {
					kind: "agent",
					label: options.senderAgentId,
					details: {
						senderAgentId: options.senderAgentId,
						...(options.notice === undefined ? undefined : { notice: options.notice }),
					},
				},
				body: options.body,
			},
			timestamp: Date.parse(timestamp),
		},
	};
}

export function leafEntry(
	id: string,
	parentId: string | null,
	timestamp: string,
	targetId: string | null,
): FixtureEntry {
	return { type: "leaf", id, parentId, timestamp, targetId };
}
