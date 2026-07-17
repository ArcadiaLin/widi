import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatUnknown, sanitizeTerminalText, singleLine } from "./format.ts";
import type { ToolExecutionItem } from "./state.ts";
import { colors } from "./theme.ts";

const SUCCESS_PREVIEW_LINES = 4;
const ERROR_PREVIEW_LINES = 8;
const PREVIEW_MAX_CHARACTERS = 1_600;

/** Built-in tools whose successful results collapse to a count suffix. */
const COUNT_SUFFIX_TOOLS: Record<string, string> = {
	ls: "entries",
	read: "lines",
	find: "matches",
};

/**
 * Render a tool execution as a semantic headline plus a bounded result
 * preview. Known coding tools get purpose-built summaries; unknown tools fall
 * back to compact key-value arguments instead of raw JSON.
 */
export function presentToolExecution(
	item: ToolExecutionItem,
	width: number,
): string[] {
	const glyph =
		item.status === "running"
			? colors.cyan("●")
			: item.isError
				? colors.red("✕")
				: colors.green("✓");
	const { verb, target } = describeToolCall(item.toolName, item.args);

	const resultText =
		item.status === "running"
			? toolResultText(item.partialResult)
			: toolResultText(item.result);
	const resultLines = resultText
		? sanitizeTerminalText(resultText)
				.slice(0, PREVIEW_MAX_CHARACTERS)
				.split("\n")
				.filter(
					(line, index, all) => line.trim() !== "" || index < all.length - 1,
				)
		: [];

	const countUnit = COUNT_SUFFIX_TOOLS[item.toolName];
	const completedOk = item.status === "completed" && !item.isError;
	const suffix =
		completedOk && countUnit && resultLines.length > 0
			? ` · ${countLines(resultLines)} ${countUnit}`
			: "";

	const headline = `${glyph} ${colors.bold(singleLine(verb, 80))}${
		target ? ` ${singleLine(target, 400)}` : ""
	}${suffix ? colors.dim(suffix) : ""}`;
	const lines = [truncateToWidth(headline, Math.max(8, width), "…")];

	const previewLimit = item.isError
		? ERROR_PREVIEW_LINES
		: completedOk && countUnit
			? 0
			: SUCCESS_PREVIEW_LINES;
	if (previewLimit > 0 && resultLines.length > 0) {
		const shown = resultLines.slice(0, previewLimit);
		for (const line of shown) {
			const bounded = truncateToWidth(line, Math.max(8, width), "…");
			lines.push(item.isError ? bounded : colors.dim(bounded));
		}
		const hidden = resultLines.length - shown.length;
		if (hidden > 0) lines.push(colors.dim(`… +${hidden} lines`));
	}
	return lines;
}

function describeToolCall(
	toolName: string,
	args: unknown,
): { verb: string; target: string } {
	const record = isRecord(args) ? args : {};
	const path = stringField(record, "path");
	switch (toolName) {
		case "ls":
			return { verb: "List", target: path ?? "." };
		case "read":
			return {
				verb: "Read",
				target: joinParts(path, readRange(record)),
			};
		case "bash":
			return { verb: "Bash", target: stringField(record, "command") ?? "" };
		case "grep": {
			const pattern = stringField(record, "pattern") ?? "";
			const glob = stringField(record, "glob");
			return {
				verb: "Grep",
				target: joinParts(pattern, path && `in ${path}`, glob && `[${glob}]`),
			};
		}
		case "find": {
			const pattern = stringField(record, "pattern") ?? "";
			return { verb: "Find", target: joinParts(pattern, path && `in ${path}`) };
		}
		case "edit": {
			const edits = Array.isArray(record.edits)
				? record.edits.length
				: undefined;
			return {
				verb: "Edit",
				target: joinParts(
					path,
					edits !== undefined && `(${edits} ${edits === 1 ? "edit" : "edits"})`,
				),
			};
		}
		case "write":
			return { verb: "Write", target: path ?? "" };
		default:
			return { verb: toolName, target: compactArguments(args) };
	}
}

function readRange(record: Record<string, unknown>): string | undefined {
	const offset = numberField(record, "offset");
	const limit = numberField(record, "limit");
	const start = offset ?? 1;
	if (limit !== undefined) return `${start}–${start + limit - 1}`;
	if (offset !== undefined) return `${start}–`;
	return undefined;
}

function compactArguments(args: unknown): string {
	if (args === undefined) return "";
	if (!isRecord(args)) return singleLine(formatUnknown(args), 120);
	const parts = Object.entries(args)
		.slice(0, 4)
		.map(([key, value]) => `${key}: ${compactValue(value)}`);
	return parts.join(", ");
}

function compactValue(value: unknown): string {
	if (typeof value === "string") return singleLine(value, 60);
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (value === null) return "null";
	if (Array.isArray(value)) return `[${value.length}]`;
	return "…";
}

function countLines(lines: readonly string[]): number {
	return lines.filter((line) => line.trim() !== "").length;
}

function joinParts(...parts: (string | false | undefined)[]): string {
	return parts.filter((part): part is string => Boolean(part)).join(" ");
}

function stringField(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract the text content of a tool result message or fall back to JSON. */
export function toolResultText(result: unknown): string {
	if (result === undefined) return "";
	if (typeof result !== "object" || result === null || !("content" in result)) {
		return formatUnknown(result);
	}
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return formatUnknown(result);
	const text = content
		.filter(
			(item): item is { type: "text"; text: string } =>
				typeof item === "object" &&
				item !== null &&
				"type" in item &&
				item.type === "text" &&
				"text" in item &&
				typeof item.text === "string",
		)
		.map((item) => item.text)
		.join("\n");
	return text || formatUnknown(result);
}
