import type {
	AgentToolResult,
	ExecutionEnv,
	FileError,
	Result,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type {
	ToolDefinition,
	ToolExecutionContext,
} from "../../src/core/extension/types.ts";

const writeSchema = Type.Object({
	path: Type.String({
		description: "Path to the file to write (relative or absolute)",
	}),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
	path: string;
	absolutePath: string;
	bytes: number;
}

export interface WriteOperations {
	/**
	 * Resolve the queue key and result details path for the target file.
	 */
	absolutePath?: (path: string, abortSignal?: AbortSignal) => Promise<string>;
	/**
	 * Create or overwrite the target file. Implementations should create parent
	 * directories when their backend supports that behavior.
	 */
	writeFile?: (
		path: string,
		content: string,
		abortSignal?: AbortSignal,
	) => Promise<void>;
}

export interface WriteToolOptions {
	env?: ExecutionEnv;
	operations?: WriteOperations;
}

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

export function createWriteToolDefinition(
	options: WriteToolOptions = {},
): ToolDefinition<typeof writeSchema, WriteToolDetails> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: "Create or overwrite files",
		promptGuidelines: ["Use write only for new files or complete rewrites."],
		parameters: writeSchema,
		execute: async (_toolCallId, params, context) =>
			await executeWriteTool(params, context, options),
	};
}

async function executeWriteTool(
	{ path, content }: WriteToolInput,
	context: ToolExecutionContext<WriteToolDetails>,
	options: WriteToolOptions,
): Promise<AgentToolResult<WriteToolDetails>> {
	const absolutePath = await resolveWritePath(
		path,
		context.signal,
		options.env,
		options.operations,
	);
	return await withFileMutationQueue(absolutePath, async () => {
		throwIfAborted(context.signal);
		await writeFile(
			path,
			content,
			context.signal,
			options.env,
			options.operations,
		);
		throwIfAborted(context.signal);

		const details = {
			path,
			absolutePath,
			bytes: content.length,
		};
		return {
			content: [
				{
					type: "text",
					text: `Successfully wrote ${content.length} bytes to ${path}`,
				},
			],
			details,
		};
	});
}

async function resolveWritePath(
	path: string,
	abortSignal: AbortSignal | undefined,
	env: ExecutionEnv | undefined,
	operations: WriteOperations | undefined,
): Promise<string> {
	if (operations?.absolutePath) {
		return await operations.absolutePath(path, abortSignal);
	}
	if (!env) throw missingWriteEnvError();
	return fileSystemValueOrThrow(await env.absolutePath(path, abortSignal));
}

async function writeFile(
	path: string,
	content: string,
	abortSignal: AbortSignal | undefined,
	env: ExecutionEnv | undefined,
	operations: WriteOperations | undefined,
): Promise<void> {
	if (operations?.writeFile) {
		await operations.writeFile(path, content, abortSignal);
		return;
	}
	if (!env) throw missingWriteEnvError();
	fileSystemValueOrThrow(await env.writeFile(path, content, abortSignal));
}

async function withFileMutationQueue<T>(
	filePath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const registration = registrationQueue.then(() => {
		const currentQueue = fileMutationQueues.get(filePath) ?? Promise.resolve();

		let releaseNext = (): void => {};
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(filePath, chainedQueue);

		return { currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(filePath) === chainedQueue) {
			fileMutationQueues.delete(filePath);
		}
	}
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

function missingWriteEnvError(): Error {
	return new Error(
		"write tool requires an execution environment with filesystem support.",
	);
}
