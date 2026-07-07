import { TextDecoder } from "node:util";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../types.ts";
import {
	type CodingToolFileOperations,
	createLocalCodingToolFileOperations,
} from "./operations.ts";
import { resolveToCwd } from "./path-utils.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({
		description:
			"Path to the UTF-8 text file to read, relative to cwd or absolute.",
	}),
	offset: Type.Optional(
		Type.Number({
			description: "1-indexed line number to start reading from.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum number of lines to read.",
		}),
	),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	path: string;
	absolutePath: string;
	mediaKind: "text" | "image" | "binary";
	bytes: number;
	totalLines?: number;
	returnedLineRange?: {
		start: number;
		end: number;
	};
	truncation?: TruncationResult;
	unsupported?: {
		reason: string;
	};
}

export interface ReadToolOptions {
	operations?: Pick<CodingToolFileOperations, "access" | "readFile">;
	maxLines?: number;
	maxBytes?: number;
}

interface ImageSignature {
	kind: string;
	matches(buffer: Buffer): boolean;
}

const utf8Decoder = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true,
});

const imageSignatures: readonly ImageSignature[] = [
	{
		kind: "PNG",
		matches: (buffer) =>
			buffer.length >= 8 &&
			buffer[0] === 0x89 &&
			buffer[1] === 0x50 &&
			buffer[2] === 0x4e &&
			buffer[3] === 0x47 &&
			buffer[4] === 0x0d &&
			buffer[5] === 0x0a &&
			buffer[6] === 0x1a &&
			buffer[7] === 0x0a,
	},
	{
		kind: "JPEG",
		matches: (buffer) =>
			buffer.length >= 3 &&
			buffer[0] === 0xff &&
			buffer[1] === 0xd8 &&
			buffer[2] === 0xff,
	},
	{
		kind: "GIF",
		matches: (buffer) =>
			buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
			buffer.subarray(0, 6).toString("ascii") === "GIF89a",
	},
	{
		kind: "WEBP",
		matches: (buffer) =>
			buffer.length >= 12 &&
			buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
			buffer.subarray(8, 12).toString("ascii") === "WEBP",
	},
	{
		kind: "BMP",
		matches: (buffer) =>
			buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d,
	},
];

export function createReadToolDefinition(
	cwd: string,
	options: ReadToolOptions = {},
): ToolDefinition<typeof readSchema, ReadToolDetails> {
	const operations =
		options.operations ?? createLocalCodingToolFileOperations();
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	return {
		name: "read",
		label: "read",
		description: `Read a UTF-8 text file. Output is truncated to ${maxLines} lines or ${formatSize(maxBytes)}, whichever is hit first. Use offset and limit to read large files in chunks. Image and binary files are reported as unsupported in this first core version.`,
		promptSnippet: "Read UTF-8 text file contents",
		promptGuidelines: [
			"Use read to inspect text files before editing them.",
			"Use offset and limit when a file is large or the result says more lines remain.",
		],
		parameters: readSchema,
		execute: async (_toolCallId, input, context) => {
			validateReadInput(input);
			const absolutePath = resolveToCwd(input.path, cwd);
			throwIfAborted(context.signal);
			await operations.access(absolutePath, "read");
			throwIfAborted(context.signal);
			const buffer = await operations.readFile(absolutePath);
			throwIfAborted(context.signal);

			const unsupportedImage = detectImageKind(buffer);
			if (unsupportedImage) {
				return createUnsupportedResult({
					path: input.path,
					absolutePath,
					bytes: buffer.byteLength,
					mediaKind: "image",
					reason: `${unsupportedImage} image files are not supported by the core read tool yet.`,
				});
			}

			if (!isUtf8TextBuffer(buffer)) {
				return createUnsupportedResult({
					path: input.path,
					absolutePath,
					bytes: buffer.byteLength,
					mediaKind: "binary",
					reason:
						"Binary or non-UTF-8 files are not supported by the core read tool.",
				});
			}

			return createTextReadResult({
				path: input.path,
				absolutePath,
				textContent: buffer.toString("utf-8"),
				offset: input.offset,
				limit: input.limit,
				maxLines,
				maxBytes,
			});
		},
	};
}

function validateReadInput(input: ReadToolInput): void {
	if (
		input.offset !== undefined &&
		(!Number.isFinite(input.offset) || input.offset < 1)
	) {
		throw new Error(
			"Read tool input is invalid. offset must be a positive 1-indexed line number.",
		);
	}
	if (
		input.limit !== undefined &&
		(!Number.isFinite(input.limit) || input.limit < 1)
	) {
		throw new Error(
			"Read tool input is invalid. limit must be a positive line count.",
		);
	}
}

function createUnsupportedResult(options: {
	path: string;
	absolutePath: string;
	bytes: number;
	mediaKind: "image" | "binary";
	reason: string;
}) {
	return {
		content: [
			{
				type: "text" as const,
				text: `Cannot read ${options.path}: ${options.reason}`,
			},
		],
		details: {
			path: options.path,
			absolutePath: options.absolutePath,
			mediaKind: options.mediaKind,
			bytes: options.bytes,
			unsupported: { reason: options.reason },
		},
	};
}

function createTextReadResult(options: {
	path: string;
	absolutePath: string;
	textContent: string;
	offset: number | undefined;
	limit: number | undefined;
	maxLines: number;
	maxBytes: number;
}) {
	const allLines = options.textContent.split("\n");
	const totalFileLines = allLines.length;
	const startLineIndex = options.offset === undefined ? 0 : options.offset - 1;
	const startLineDisplay = startLineIndex + 1;
	if (startLineIndex >= totalFileLines) {
		throw new Error(
			`Offset ${options.offset} is beyond end of file (${totalFileLines} lines total).`,
		);
	}

	let selectedContent: string;
	let userLimitedLines: number | undefined;
	if (options.limit !== undefined) {
		const endLineIndex = Math.min(
			startLineIndex + options.limit,
			totalFileLines,
		);
		selectedContent = allLines.slice(startLineIndex, endLineIndex).join("\n");
		userLimitedLines = endLineIndex - startLineIndex;
	} else {
		selectedContent = allLines.slice(startLineIndex).join("\n");
	}

	const truncation = truncateHead(selectedContent, {
		maxLines: options.maxLines,
		maxBytes: options.maxBytes,
	});
	const content = formatReadContent({
		path: options.path,
		allLines,
		startLineIndex,
		startLineDisplay,
		userLimitedLines,
		truncation,
	});
	const endLine =
		truncation.outputLines > 0
			? startLineDisplay + truncation.outputLines - 1
			: startLineDisplay;

	return {
		content: [{ type: "text" as const, text: content }],
		details: {
			path: options.path,
			absolutePath: options.absolutePath,
			mediaKind: "text" as const,
			bytes: Buffer.byteLength(options.textContent, "utf-8"),
			totalLines: totalFileLines,
			returnedLineRange: {
				start: startLineDisplay,
				end: endLine,
			},
			truncation: truncation.truncated ? truncation : undefined,
		},
	};
}

function formatReadContent(options: {
	path: string;
	allLines: string[];
	startLineIndex: number;
	startLineDisplay: number;
	userLimitedLines: number | undefined;
	truncation: TruncationResult;
}): string {
	if (options.truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(
			Buffer.byteLength(options.allLines[options.startLineIndex], "utf-8"),
		);
		return `[Line ${options.startLineDisplay} in ${options.path} is ${firstLineSize}, exceeding the ${formatSize(options.truncation.maxBytes)} read limit. The core read tool does not return partial lines.]`;
	}

	let outputText = options.truncation.content;
	if (options.truncation.truncated) {
		const endLineDisplay =
			options.startLineDisplay + options.truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		if (options.truncation.truncatedBy === "lines") {
			return `${outputText}\n\n[Showing lines ${options.startLineDisplay}-${endLineDisplay} of ${options.allLines.length}. Use offset=${nextOffset} to continue.]`;
		}
		return `${outputText}\n\n[Showing lines ${options.startLineDisplay}-${endLineDisplay} of ${options.allLines.length} (${formatSize(options.truncation.maxBytes)} limit). Use offset=${nextOffset} to continue.]`;
	}

	if (
		options.userLimitedLines !== undefined &&
		options.startLineIndex + options.userLimitedLines < options.allLines.length
	) {
		const remaining =
			options.allLines.length -
			(options.startLineIndex + options.userLimitedLines);
		const nextOffset = options.startLineIndex + options.userLimitedLines + 1;
		outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	}

	return outputText;
}

function detectImageKind(buffer: Buffer): string | undefined {
	return imageSignatures.find((signature) => signature.matches(buffer))?.kind;
}

function isUtf8TextBuffer(buffer: Buffer): boolean {
	if (buffer.includes(0)) {
		return false;
	}
	try {
		utf8Decoder.decode(buffer);
		return true;
	} catch {
		return false;
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}
