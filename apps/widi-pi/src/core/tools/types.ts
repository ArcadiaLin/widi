import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type { ToolHumanHost } from "../human-request.ts";

/**
 * UI-neutral facts emitted for tool-call lifecycle changes.
 *
 * The orchestrator derives these from Pi harness events and forwards them as a
 * stable protocol for UI and extension hosts. These are facts, not preview or
 * state updates: consumers decide how to render, aggregate, or persist them.
 */
export type ToolLifecycleEvent =
	| {
			/** A new streamed tool call appeared before arguments are complete. */
			type: "tool_call_created";
			contentIndex: number;
			toolCallId?: string;
			toolName?: string;
	  }
	| {
			/** One argument-stream delta arrived. */
			type: "arguments_delta";
			contentIndex: number;
			delta: string;
			toolCallId?: string;
			toolName?: string;
	  }
	| {
			/** Arguments are complete according to the provider stream. */
			type: "arguments_ready";
			contentIndex: number;
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| {
			/** Tool execution is about to run. */
			type: "execution_started";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| {
			/** Tool produced an intermediate update through onUpdate. */
			type: "execution_update";
			toolCallId: string;
			toolName: string;
			partialResult: unknown;
	  }
	| {
			/** Tool finished and produced its final structured result. */
			type: "execution_result";
			toolCallId: string;
			toolName: string;
			result: unknown;
			/** True when the harness treats the final result as an error. */
			isError: boolean;
	  };

/**
 * Runtime context passed to a WIDI tool execution function.
 *
 * This is the adapter boundary between resolved WIDI tool definitions and Pi
 * `AgentTool` closures. Tool-specific backends are captured by the tool
 * definition factory, while this context carries per-call facts such as abort,
 * update, extension, and human request handling.
 */
export interface ToolExecutionContext<TDetails> {
	/** Abort signal for the current tool call. */
	signal: AbortSignal | undefined;
	/** Pi-compatible callback for streaming tool updates. */
	onUpdate: AgentToolUpdateCallback<TDetails> | undefined;
	/** Extension context bound to the tool source currently executing. */
	extension: ToolExtensionContext | undefined;
	/** Host for controlled user interaction from tools. */
	human: ToolHumanHost | undefined;
}

/**
 * Context visible to extension-contributed tool code.
 *
 * The shape is deliberately small until the extension runner is designed. It
 * identifies the extension and leaves `host` as the future controlled capability
 * surface, rather than exposing core internals directly.
 */
export interface ToolExtensionContext {
	/** Stable id of the extension whose contribution is executing. */
	extensionId: string;
	/** Future extension host/capability object. */
	host?: unknown;
}

/** Execute function implemented by a WIDI tool definition. */
export type ToolExecute<
	TParamsSchema extends TSchema = TSchema,
	TDetails = unknown,
> = (
	toolCallId: string,
	params: Static<TParamsSchema>,
	context: ToolExecutionContext<TDetails>,
) => Promise<AgentToolResult<TDetails>>;

/**
 * Middleware used by tool patches to wrap an existing execute function.
 *
 * This is the preferred extension mechanism for auditing, confirmation,
 * sandboxing, argument rewriting, and backend delegation when the original tool
 * behavior should remain mostly intact.
 */
export type ToolExecuteMiddleware<
	TParamsSchema extends TSchema = TSchema,
	TDetails = unknown,
> = (
	next: ToolExecute<TParamsSchema, TDetails>,
	toolCallId: string,
	params: Static<TParamsSchema>,
	context: ToolExecutionContext<TDetails>,
) => Promise<AgentToolResult<TDetails>>;

/**
 * Partial tool definition applied to an existing tool by the registry.
 *
 * Patches are applied in registration order. They can replace the model-facing
 * description, parameters, strict metadata, or execute function.
 * `aroundExecute` wraps the current execute function instead of replacing it.
 */
export interface ToolDefinitionPatch<
	TParamsSchema extends TSchema = TSchema,
	TDetails = unknown,
> {
	/** Model-visible description passed to Pi AgentTool. */
	description?: string;
	/** TypeBox schema for model arguments. */
	parameters?: TParamsSchema;
	/** Future provider strict-mode flag. Currently retained by WIDI metadata. */
	strict?: boolean;
	/** Replace the tool execute implementation. */
	execute?: ToolExecute<TParamsSchema, TDetails>;
	/** Wrap the current execute implementation. */
	aroundExecute?: ToolExecuteMiddleware<TParamsSchema, TDetails>;
}

/**
 * Stable provenance for a tool registration.
 *
 * Diagnostics and conflict resolution use this to explain where a tool
 * definition or patch came from.
 */
export interface ToolSource {
	/** Registration owner class. */
	kind: "core" | "extension" | "adapter";
	/** Stable owner id within the kind, such as `builtin` or an extension id. */
	id: string;
}

/**
 * WIDI-owned tool definition.
 *
 * This is not Pi's runtime closure directly. It is the declarative/runtime
 * boundary owned by WIDI: the registry can diagnose, patch, filter, and finally
 * wrap it into a Pi `AgentTool`. It owns execution metadata and the execute
 * closure only. UI preview/state is derived outside the tool from orchestrator
 * lifecycle events and tool results.
 */
export interface ToolDefinition<
	TParamsSchema extends TSchema = TSchema,
	TDetails = unknown,
> {
	/** Stable model-visible and session-visible tool name. */
	name: string;
	/** Short label for debug/UI surfaces. */
	label: string;
	/** Model-visible description passed to Pi AgentTool. */
	description: string;

	/** Optional system-prompt snippet used when composing tool guidance. */
	promptSnippet?: string;
	/** Optional additional prompt guidance. */
	promptGuidelines?: string[];

	/** TypeBox schema for model arguments. */
	parameters: TParamsSchema;
	/** Future provider strict-mode flag. Currently retained by WIDI metadata. */
	strict?: boolean;
	/** Normalize raw model arguments before execution. */
	prepareArguments?: (args: unknown) => Static<TParamsSchema>;

	/** Pi tool execution scheduling mode. */
	executionMode?: ToolExecutionMode;

	/** Execute the tool after arguments have been prepared and validated. */
	execute: ToolExecute<TParamsSchema, TDetails>;
}
