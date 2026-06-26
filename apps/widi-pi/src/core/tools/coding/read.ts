import type {
	AgentToolResult,
	ExecutionEnv,
	FileError,
	Result,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition, ToolExecutionContext } from "../types.ts";

export const READ_DEFAULT_MAX_LINES = 2000;
export const READ_DEFAULT_MAX_BYTES = 50 * 1024;

const readSchema = Type.Object({
	path: Type.String({
		description: "Path to the file to read (relative or absolute)",
	}),
	offset: Type.Optional(
		Type.Number({
			description: "Line number to start reading from (1-indexed)",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum number of lines to read" }),
	),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	path: string;
	absolutePath: string;
	bytes: number;
	truncation?: ReadTruncationResult;
	mimeType?: string;
}

export interface ReadTruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	lastLinePartial: boolean;
	firstLineExceedsLimit: boolean;
	maxLines: number;
	maxBytes: number;
}

export interface ReadOperations {
	absolutePath?: (
		env: ExecutionEnv,
		path: string,
		abortSignal?: AbortSignal,
	) => Promise<string>;
	readTextFile?: (
		env: ExecutionEnv,
		path: string,
		abortSignal?: AbortSignal,
	) => Promise<string>;
	readBinaryFile?: (
		env: ExecutionEnv,
		path: string,
		abortSignal?: AbortSignal,
	) => Promise<Uint8Array>;
	detectImageMimeType?: (
		path: string,
		absolutePath: string,
		abortSignal?: AbortSignal,
	) => Promise<string | undefined> | string | undefined;
}

export interface ReadToolOptions {
	operations?: ReadOperations;
}

export function createReadToolDefinition(
	options: ReadToolOptions = {},
): ToolDefinition<typeof readSchema, ReadToolDetails> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${READ_DEFAULT_MAX_LINES} lines or ${READ_DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		parameters: readSchema,
		executionEnv: { kind: "harness", capabilities: ["filesystem"] },
		execute: async (_toolCallId, params, context) =>
			await executeReadTool(params, context, options.operations),
	};
}

async function executeReadTool(
	params: ReadToolInput,
	context: ToolExecutionContext<ReadToolDetails>,
	operations: ReadOperations | undefined,
): Promise<AgentToolResult<ReadToolDetails>> {
	const env = context.env;
	if (!env) {
		throw new Error(
			"read tool requires an execution environment with filesystem support.",
		);
	}

	throwIfAborted(context.signal);
	const absolutePath = await resolveReadPath(
		env,
		params.path,
		context.signal,
		operations,
	);
	const mimeType = await detectImageMimeType(
		params.path,
		absolutePath,
		context.signal,
		operations,
	);
	throwIfAborted(context.signal);

	if (mimeType) {
		const bytes = await readBinaryFile(
			env,
			params.path,
			context.signal,
			operations,
		);
		throwIfAborted(context.signal);
		return {
			content: [
				{ type: "text", text: `Read image file [${mimeType}]` },
				{
					type: "image",
					data: Buffer.from(bytes).toString("base64"),
					mimeType,
				},
			],
			details: {
				path: params.path,
				absolutePath,
				bytes: bytes.byteLength,
				mimeType,
			},
		};
	}

	const textContent = await readTextFile(
		env,
		params.path,
		context.signal,
		operations,
	);
	throwIfAborted(context.signal);
	const { outputText, details } = formatReadTextResult(
		params,
		absolutePath,
		textContent,
	);
	return {
		content: [{ type: "text", text: outputText }],
		details,
	};
}

function formatReadTextResult(
	{ path, offset, limit }: ReadToolInput,
	absolutePath: string,
	textContent: string,
): { outputText: string; details: ReadToolDetails } {
	const allLines = textContent.split("\n");
	const totalFileLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	if (startLine >= allLines.length) {
		throw new Error(
			`Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
		);
	}

	let selectedContent: string;
	let userLimitedLines: number | undefined;
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, allLines.length);
		selectedContent = allLines.slice(startLine, endLine).join("\n");
		userLimitedLines = endLine - startLine;
	} else {
		selectedContent = allLines.slice(startLine).join("\n");
	}

	const truncation = truncateHead(selectedContent);
	const details: ReadToolDetails = {
		path,
		absolutePath,
		bytes: Buffer.byteLength(textContent, "utf-8"),
	};
	let outputText: string;
	if (truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(
			Buffer.byteLength(allLines[startLine], "utf-8"),
		);
		outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(READ_DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${READ_DEFAULT_MAX_BYTES}]`;
		details.truncation = truncation;
	} else if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		outputText = truncation.content;
		if (truncation.truncatedBy === "lines") {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
		} else {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(READ_DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		}
		details.truncation = truncation;
	} else if (
		userLimitedLines !== undefined &&
		startLine + userLimitedLines < allLines.length
	) {
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	} else {
		outputText = truncation.content;
	}

	return { outputText, details };
}

async function resolveReadPath(
	env: ExecutionEnv,
	path: string,
	abortSignal: AbortSignal | undefined,
	operations: ReadOperations | undefined,
): Promise<string> {
	if (operations?.absolutePath) {
		return await operations.absolutePath(env, path, abortSignal);
	}
	return fileSystemValueOrThrow(await env.absolutePath(path, abortSignal));
}

async function readTextFile(
	env: ExecutionEnv,
	path: string,
	abortSignal: AbortSignal | undefined,
	operations: ReadOperations | undefined,
): Promise<string> {
	if (operations?.readTextFile) {
		return await operations.readTextFile(env, path, abortSignal);
	}
	return fileSystemValueOrThrow(await env.readTextFile(path, abortSignal));
}

async function readBinaryFile(
	env: ExecutionEnv,
	path: string,
	abortSignal: AbortSignal | undefined,
	operations: ReadOperations | undefined,
): Promise<Uint8Array> {
	if (operations?.readBinaryFile) {
		return await operations.readBinaryFile(env, path, abortSignal);
	}
	return fileSystemValueOrThrow(await env.readBinaryFile(path, abortSignal));
}

async function detectImageMimeType(
	path: string,
	absolutePath: string,
	abortSignal: AbortSignal | undefined,
	operations: ReadOperations | undefined,
): Promise<string | undefined> {
	if (operations?.detectImageMimeType) {
		return await operations.detectImageMimeType(
			path,
			absolutePath,
			abortSignal,
		);
	}
	const lowerPath = path.toLowerCase();
	if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) {
		return "image/jpeg";
	}
	if (lowerPath.endsWith(".png")) return "image/png";
	if (lowerPath.endsWith(".gif")) return "image/gif";
	if (lowerPath.endsWith(".webp")) return "image/webp";
	return undefined;
}

function truncateHead(content: string): ReadTruncationResult {
	const maxLines = READ_DEFAULT_MAX_LINES;
	const maxBytes = READ_DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	const outputLines: string[] = [];
	let outputBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (let index = 0; index < lines.length && index < maxLines; index++) {
		const line = lines[index];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (index > 0 ? 1 : 0);
		if (outputBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		outputLines.push(line);
		outputBytes += lineBytes;
	}

	const outputContent = outputLines.join("\n");
	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLines.length,
		outputBytes: Buffer.byteLength(outputContent, "utf-8"),
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function fileSystemValueOrThrow<TValue>(
	result: Result<TValue, FileError>,
): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}
