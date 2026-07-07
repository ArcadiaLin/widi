import type {
	AgentHarnessEvent,
	AgentHarnessEventResultMap,
	AgentToolResult,
	AgentToolUpdateCallback,
	BeforeAgentStartEvent,
	ContextEvent,
	ToolCallEvent,
	ToolExecutionMode,
	ToolResultEvent,
} from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type { CommandCandidates, CommandPlacement } from "../command.ts";
import type {
	HumanRequest,
	HumanResponse,
	ToolHumanHost,
} from "../human-request.ts";
import type { AgentToolsSnapshot } from "../runtime-types.ts";

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

export type ExtensionObservedEventName =
	| "agent_harness_event"
	| "tool_lifecycle_event";

export type ExtensionObservedEvent =
	| {
			type: "agent_harness_event";
			agentId: string;
			event: AgentHarnessEvent;
	  }
	| {
			type: "tool_lifecycle_event";
			agentId: string;
			event: ToolLifecycleEvent;
	  };

/**
 * WIDI intentionally exposes only the stable MVP interceptors today.
 *
 * Full AgentHarness hook candidates include:
 * - before_agent_start, context, tool_call, tool_result
 * - before_provider_request, before_provider_payload
 * - session_before_compact, session_before_tree
 * - observer-like own events with no return value: after_provider_response,
 *   session_compact, session_tree, model_update, thinking_level_update,
 *   resources_update, tools_update, queue_update, save_point, abort, settled
 *
 * Provider and session hooks are deferred until permission, diagnostics, and
 * stale-context semantics are explicit.
 */
export type ExtensionInterceptorName =
	| "before_agent_start"
	| "context"
	| "tool_call"
	| "tool_result";

export interface ExtensionInterceptorEventMap {
	before_agent_start: BeforeAgentStartEvent;
	context: ContextEvent;
	tool_call: ToolCallEvent;
	tool_result: ToolResultEvent;
}

export type ExtensionInterceptorEventFor<
	TName extends ExtensionInterceptorName,
> = ExtensionInterceptorEventMap[TName];

export type ExtensionInterceptorResultFor<
	TName extends ExtensionInterceptorName,
> = AgentHarnessEventResultMap[TName];

export interface ExtensionActions {
	getAgentTools(agentId: string): AgentToolsSnapshot;
	setAgentTools(
		agentId: string,
		toolNames: string[],
		activeToolNames?: string[],
	): Promise<void>;
	setAgentActiveTools(agentId: string, toolNames: string[]): Promise<void>;
	requestHuman(request: HumanRequest): Promise<HumanResponse>;
}

export interface ExtensionContextActions {
	getSignal?(): AbortSignal | undefined;
	isIdle?(): boolean;
	session?: ExtensionSessionActions;
	reportActionFailure?(failure: ExtensionActionFailure): Promise<void>;
}

export interface ExtensionCommandContextActions {
	waitForIdle(): Promise<void>;
}

export interface ExtensionCustomEntry<T = unknown> {
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
	data?: T;
}

export interface ExtensionSessionContext {
	appendEntry<T = unknown>(type: string, data?: T): Promise<string>;
	findEntries<T = unknown>(type?: string): Promise<ExtensionCustomEntry<T>[]>;
}

export interface ExtensionSessionActions {
	appendEntry<T = unknown>(
		extensionId: string,
		type: string,
		data?: T,
	): Promise<string>;
	findEntries<T = unknown>(
		extensionId: string,
		type?: string,
	): Promise<ExtensionCustomEntry<T>[]>;
}

export interface ExtensionActionFailure {
	extensionId: string;
	action:
		| "findEntries"
		| "requestHuman"
		| "setAgentActiveTools"
		| "setAgentTools"
		| "appendEntry";
	code: string;
	error: unknown;
}

export interface ExtensionContext {
	extensionId: string;
	agentId: string;
	profileId: string;
	actions: ExtensionActions;
	session: ExtensionSessionContext;
	readonly signal: AbortSignal | undefined;
	isIdle(): boolean;
}

export interface ExtensionCommandContext extends ExtensionContext {
	waitForIdle(): Promise<void>;
}

export type ExtensionCommandHandler = (
	args: string,
	context: ExtensionCommandContext,
) => Promise<void> | void;

// Argument facts on the author-side contract. getArgumentsCompletion
// returns candidate facts only - whether and how a human request is
// issued is the orchestrator's ruling, and the callback never receives
// an orchestrator handle (the runner narrows the completion context).
export interface ExtensionCommandArguments {
	readonly required?: boolean;
	getArgumentsCompletion?(
		argumentPrefix: string,
	): Promise<CommandCandidates> | CommandCandidates;
}

export interface ExtensionCommandDefinition {
	readonly name: string;
	readonly placement?: Extract<CommandPlacement, "line">;
	readonly trigger?: string;
	readonly description?: string;
	readonly argumentHint?: string;
	readonly arguments?: ExtensionCommandArguments;
	readonly handler: ExtensionCommandHandler;
}

export type ExtensionObserver<
	TEvent extends ExtensionObservedEvent = ExtensionObservedEvent,
> = (event: TEvent, context: ExtensionContext) => Promise<void> | void;

export type ExtensionObserverFor<TName extends ExtensionObservedEventName> =
	TName extends "agent_harness_event"
		? ExtensionObserver<
				Extract<ExtensionObservedEvent, { type: "agent_harness_event" }>
			>
		: TName extends "tool_lifecycle_event"
			? ExtensionObserver<
					Extract<ExtensionObservedEvent, { type: "tool_lifecycle_event" }>
				>
			: never;

export type ExtensionInterceptorFor<TName extends ExtensionInterceptorName> = (
	event: ExtensionInterceptorEventFor<TName>,
	context: ExtensionContext,
) =>
	| Promise<ExtensionInterceptorResultFor<TName>>
	| ExtensionInterceptorResultFor<TName>;

export interface ExtensionActivationApi {
	readonly extensionId: string;
	readonly agentId: string;
	readonly profileId: string;
	registerTool<TParamsSchema extends TSchema, TDetails>(
		tool: ToolDefinition<TParamsSchema, TDetails>,
	): void;
	patchTool<TParamsSchema extends TSchema, TDetails>(
		targetToolName: string,
		patch: ToolDefinitionPatch<TParamsSchema, TDetails>,
	): void;
	registerCommand(command: ExtensionCommandDefinition): void;
	observe<TName extends ExtensionObservedEventName>(
		eventName: TName,
		handler: ExtensionObserverFor<TName>,
	): void;
	intercept<TName extends ExtensionInterceptorName>(
		eventName: TName,
		handler: ExtensionInterceptorFor<TName>,
	): void;
}

export type ExtensionFactory = (
	api: ExtensionActivationApi,
) => Promise<void> | void;

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
