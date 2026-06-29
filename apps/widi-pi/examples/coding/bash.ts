import type {
	AgentToolResult,
	ExecutionEnv,
	ExecutionError,
	FileError,
	Result,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type {
	ToolDefinition,
	ToolExecutionContext,
} from "../../src/core/extension/types.ts";

export const BASH_DEFAULT_MAX_LINES = 2000;
export const BASH_DEFAULT_MAX_BYTES = 50 * 1024;

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout in seconds (optional, no default timeout)",
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: BashTruncationResult;
	fullOutputPath?: string;
}

export interface BashTruncationResult {
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

export interface BashExecOptions {
	cwd: string;
	timeout?: number;
	abortSignal?: AbortSignal;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

export interface BashOperations {
	exec?: (
		command: string,
		options: BashExecOptions,
	) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
	createFullOutputFile?: (
		content: string,
		abortSignal?: AbortSignal,
	) => Promise<string>;
}

export interface BashToolOptions {
	env?: ExecutionEnv;
	operations?: BashOperations;
	commandPrefix?: string;
	cwd?: string;
}

interface BashOutputSnapshot {
	content: string;
	truncation: BashTruncationResult;
	fullOutputPath?: string;
}

export function createBashToolDefinition(
	options: BashToolOptions = {},
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${BASH_DEFAULT_MAX_LINES} lines or ${BASH_DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		parameters: bashSchema,
		execute: async (_toolCallId, params, context) =>
			await executeBashTool(params, context, options),
	};
}

async function executeBashTool(
	{ command, timeout }: BashToolInput,
	context: ToolExecutionContext<BashToolDetails | undefined>,
	options: BashToolOptions,
): Promise<AgentToolResult<BashToolDetails | undefined>> {
	const output = new BashOutputAccumulator();
	let receivedStreamOutput = false;
	const resolvedCommand = options.commandPrefix
		? `${options.commandPrefix}\n${command}`
		: command;
	const cwd = options.cwd ?? options.env?.cwd;
	if (!cwd) throw missingBashEnvError("shell");

	const handleOutput = (chunk: string): void => {
		receivedStreamOutput = true;
		output.append(chunk);
		emitOutputUpdate(output, context);
	};

	let result: { stdout: string; stderr: string; exitCode: number };
	try {
		result = await execBashCommand(options.env, resolvedCommand, {
			cwd,
			timeout,
			abortSignal: context.signal,
			onStdout: handleOutput,
			onStderr: handleOutput,
			operations: options.operations,
		});
	} catch (error) {
		const snapshot = await finishOutput(
			output,
			options.env,
			context,
			options.operations,
		);
		const { text } = formatOutput(snapshot, output.getLastLineBytes(), "");
		if (isExecutionError(error, "aborted")) {
			throw new Error(appendStatus(text, "Command aborted"));
		}
		if (isExecutionError(error, "timeout")) {
			const timeoutText =
				timeout === undefined
					? "Command timed out"
					: `Command timed out after ${timeout} seconds`;
			throw new Error(appendStatus(text, timeoutText));
		}
		throw error;
	}

	if (!receivedStreamOutput) {
		output.append(result.stdout);
		output.append(result.stderr);
	}

	const snapshot = await finishOutput(
		output,
		options.env,
		context,
		options.operations,
	);
	const { text, details } = formatOutput(snapshot, output.getLastLineBytes());
	if (result.exitCode !== 0) {
		throw new Error(
			appendStatus(text, `Command exited with code ${result.exitCode}`),
		);
	}
	return { content: [{ type: "text", text }], details };
}

interface ExecCommandOptions extends BashExecOptions {
	operations?: BashOperations;
}

async function execBashCommand(
	env: ExecutionEnv | undefined,
	command: string,
	options: ExecCommandOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (options.operations?.exec) {
		return await options.operations.exec(command, options);
	}
	if (!env) throw missingBashEnvError("shell");
	const result = await env.exec(command, {
		cwd: options.cwd,
		timeout: options.timeout,
		abortSignal: options.abortSignal,
		onStdout: options.onStdout,
		onStderr: options.onStderr,
	});
	return executionValueOrThrow(result);
}

async function finishOutput(
	output: BashOutputAccumulator,
	env: ExecutionEnv | undefined,
	context: ToolExecutionContext<BashToolDetails | undefined>,
	operations: BashOperations | undefined,
): Promise<BashOutputSnapshot> {
	const snapshot = output.snapshot();
	if (!snapshot.truncation.truncated) {
		return snapshot;
	}
	const fullOutputPath = await createFullOutputFile(
		env,
		output.content,
		context.signal,
		operations,
	);
	return { ...snapshot, fullOutputPath };
}

function emitOutputUpdate(
	output: BashOutputAccumulator,
	context: ToolExecutionContext<BashToolDetails | undefined>,
): void {
	const onUpdate = context.onUpdate;
	if (!onUpdate) return;
	const snapshot = output.snapshot();
	onUpdate({
		content: [{ type: "text", text: snapshot.content }],
		details: snapshot.truncation.truncated
			? { truncation: snapshot.truncation }
			: undefined,
	});
}

async function createFullOutputFile(
	env: ExecutionEnv | undefined,
	content: string,
	abortSignal: AbortSignal | undefined,
	operations: BashOperations | undefined,
): Promise<string> {
	if (operations?.createFullOutputFile) {
		return await operations.createFullOutputFile(content, abortSignal);
	}
	if (!env) throw missingBashEnvError("filesystem");
	const path = fileSystemValueOrThrow(
		await env.createTempFile({
			prefix: "widi-bash-",
			suffix: ".log",
			abortSignal,
		}),
	);
	fileSystemValueOrThrow(await env.writeFile(path, content, abortSignal));
	return path;
}

function formatOutput(
	snapshot: BashOutputSnapshot,
	lastLineBytes: number,
	emptyText = "(no output)",
): { text: string; details: BashToolDetails | undefined } {
	const truncation = snapshot.truncation;
	let text = snapshot.content || emptyText;
	let details: BashToolDetails | undefined;
	if (truncation.truncated) {
		details = { truncation, fullOutputPath: snapshot.fullOutputPath };
		const startLine = truncation.totalLines - truncation.outputLines + 1;
		const endLine = truncation.totalLines;
		if (truncation.lastLinePartial) {
			text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(lastLineBytes)}). Full output: ${snapshot.fullOutputPath}]`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
		} else {
			text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(BASH_DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
		}
	}
	return { text, details };
}

function appendStatus(text: string, status: string): string {
	return text ? `${text}\n\n${status}` : status;
}

class BashOutputAccumulator {
	private chunks: string[] = [];

	get content(): string {
		return this.chunks.join("");
	}

	append(chunk: string): void {
		if (chunk.length === 0) return;
		this.chunks.push(chunk);
	}

	getLastLineBytes(): number {
		const content = this.content;
		const lastNewline = content.lastIndexOf("\n");
		const lastLine =
			lastNewline === -1 ? content : content.slice(lastNewline + 1);
		return Buffer.byteLength(lastLine, "utf-8");
	}

	snapshot(): BashOutputSnapshot {
		const truncation = truncateTail(this.content);
		return {
			content: truncation.content,
			truncation,
		};
	}
}

function truncateTail(content: string): BashTruncationResult {
	const maxLines = BASH_DEFAULT_MAX_LINES;
	const maxBytes = BASH_DEFAULT_MAX_BYTES;
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

	const outputLines: string[] = [];
	let outputBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let index = lines.length - 1; index >= 0; index--) {
		if (outputLines.length >= maxLines) break;
		const line = lines[index];
		const lineBytes =
			Buffer.byteLength(line, "utf-8") + (outputLines.length > 0 ? 1 : 0);
		if (outputBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			if (outputLines.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLines.unshift(truncatedLine);
				outputBytes = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}
		outputLines.unshift(line);
		outputBytes += lineBytes;
	}

	if (outputLines.length >= maxLines && outputBytes <= maxBytes) {
		truncatedBy = "lines";
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
		lastLinePartial,
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

function truncateStringToBytesFromEnd(value: string, maxBytes: number): string {
	const buffer = Buffer.from(value, "utf-8");
	if (buffer.length <= maxBytes) return value;

	let start = buffer.length - maxBytes;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
		start++;
	}
	return buffer.subarray(start).toString("utf-8");
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function executionValueOrThrow<TValue>(
	result: Result<TValue, ExecutionError>,
): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

function fileSystemValueOrThrow<TValue>(
	result: Result<TValue, FileError>,
): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

function isExecutionError(
	error: unknown,
	code: ExecutionError["code"],
): boolean {
	return (
		error instanceof Error &&
		"name" in error &&
		error.name === "ExecutionError" &&
		"code" in error &&
		error.code === code
	);
}

function missingBashEnvError(capability: "filesystem" | "shell"): Error {
	return new Error(
		`bash tool requires an execution environment with ${capability} support.`,
	);
}
