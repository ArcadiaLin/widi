import type {
	AgentHarnessEvent,
	AgentHarnessEventResultMap,
	BeforeAgentStartEvent,
	ContextEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { CommandCandidates, CommandPlacement } from "../command.ts";
import type { HumanRequest, HumanResponse } from "../human-request.ts";
import type { ToolDefinition, ToolDefinitionPatch } from "../tools/types.ts";
import type { AgentToolsSnapshot } from "../types.ts";

// The tool contract lives in the core tools layer (ME slice 0 dependency
// inversion); the extension layer consumes and re-exports it for its own
// consumers.
export type {
	ToolDefinition,
	ToolDefinitionPatch,
	ToolExecute,
	ToolExecuteMiddleware,
	ToolExecutionContext,
	ToolExtensionContext,
	ToolSource,
} from "../tools/types.ts";

export type ExtensionObservedEventName = ExtensionObservedEvent["type"];

export type ExtensionObservedEvent = {
	type: "agent_harness_event";
	agentId: string;
	event: AgentHarnessEvent;
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
	observe(
		eventName: ExtensionObservedEventName,
		handler: ExtensionObserver,
	): void;
	intercept<TName extends ExtensionInterceptorName>(
		eventName: TName,
		handler: ExtensionInterceptorFor<TName>,
	): void;
}

export type ExtensionFactory = (
	api: ExtensionActivationApi,
) => Promise<void> | void;
