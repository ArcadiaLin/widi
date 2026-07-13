import type {
	AgentHarnessEventResultMap,
	BeforeAgentStartEvent,
	ContextEvent,
	ExecutionError,
	Result,
	ShellExecOptions,
	ThinkingLevel,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type {
	Command,
	CommandCandidates,
	CommandPlacement,
} from "../command.ts";
import type { HumanRequestDraft, HumanResponse } from "../human-request.ts";
import type { ToolDefinition, ToolDefinitionPatch } from "../tools/types.ts";
import type {
	AgentToolsSnapshot,
	OrchestratorEvent,
	RuntimeModel,
} from "../types.ts";

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

export type ExtensionObservedEvent = Extract<
	OrchestratorEvent,
	{
		type:
			| "agent_harness_event"
			| "agent_resumed"
			| "agent_session_forked"
			| "agent_session_info_changed"
			| "agent_spawned"
			| "command_accepted"
			| "command_completed"
			| "command_detected"
			| "command_failed"
			| "command_rejected"
			| "diagnostic"
			| "human_request_cancelled"
			| "human_request_pending"
			| "human_request_resolved"
			| "human_request_timeout"
			| "input_blocked"
			| "input_transformed";
	}
>;

export type ExtensionObservedEventFor<
	TName extends ExtensionObservedEventName,
> = Extract<ExtensionObservedEvent, { type: TName }>;

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
	| "input"
	| "tool_call"
	| "tool_result";

/**
 * WIDI-native input interceptor event (ME slice 6). Fired by inputAgent for
 * every human text ingress before any command parsing, including the
 * commands-disabled short circuit; a rewritten text re-enters the full
 * parse/gateway pipeline. Not a Pi harness hook.
 */
export interface ExtensionInputEvent {
	readonly type: "input";
	readonly text: string;
	readonly images?: readonly ImageContent[];
}

/**
 * `undefined` passes the input through unchanged. A transform result rewrites
 * the text (and optionally the images; omitted images keep the current ones)
 * and feeds the next handler. A block result rejects the whole input and
 * short-circuits the pipeline; there is no pi-style "handled" escape hatch -
 * consuming input to run custom logic is a block plus scoped actions, and
 * owning command syntax is registerCommand.
 */
export type ExtensionInputResult =
	| { text: string; images?: readonly ImageContent[] }
	| { block: true; reason?: string }
	| undefined;

// Pi harness hooks share the Pi result contract; input is WIDI-owned.
export interface ExtensionInterceptorEventMap {
	before_agent_start: BeforeAgentStartEvent;
	context: ContextEvent;
	input: ExtensionInputEvent;
	tool_call: ToolCallEvent;
	tool_result: ToolResultEvent;
}

export interface ExtensionInterceptorResultMap {
	before_agent_start: AgentHarnessEventResultMap["before_agent_start"];
	context: AgentHarnessEventResultMap["context"];
	input: ExtensionInputResult;
	tool_call: AgentHarnessEventResultMap["tool_call"];
	tool_result: AgentHarnessEventResultMap["tool_result"];
}

export type ExtensionInterceptorEventFor<
	TName extends ExtensionInterceptorName,
> = ExtensionInterceptorEventMap[TName];

export type ExtensionInterceptorResultFor<
	TName extends ExtensionInterceptorName,
> = ExtensionInterceptorResultMap[TName];

export type ExtensionExecResult = Result<
	{ stdout: string; stderr: string; exitCode: number },
	ExecutionError
>;

/**
 * Agent-scoped action surface handed to extension authors. Every action is
 * bound to the extension's own agent; the agent id is injected by the runner
 * and never appears in a signature. Cross-agent operations are not part of
 * this contract (they belong to the M3 collaboration facade).
 */
export interface ExtensionActions {
	getTools(): AgentToolsSnapshot;
	setTools(toolNames: string[], activeToolNames?: string[]): Promise<void>;
	setActiveTools(toolNames: string[]): Promise<void>;
	// The request source is injected by the runner as
	// { kind: "extension", extensionId } and cannot be forged.
	requestHuman(request: HumanRequestDraft): Promise<HumanResponse>;
	prompt(text: string, options?: { images?: ImageContent[] }): Promise<void>;
	steer(text: string, options?: { images?: ImageContent[] }): Promise<void>;
	followUp(text: string, options?: { images?: ImageContent[] }): Promise<void>;
	setSessionName(name: string): Promise<void>;
	getCommands(): Command[];
	setModel(reference: string): Promise<RuntimeModel>;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	// Denied with a structured diagnostic when the project is not trusted.
	exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<ExtensionExecResult>;
}

/**
 * Binding contract between the orchestrator and the runner. Agent ids stay
 * explicit here; the runner narrows this surface into the scoped
 * ExtensionActions above. Not part of the extension-author API.
 */
export interface ExtensionCoreActions {
	getAgentTools(agentId: string): AgentToolsSnapshot;
	setAgentTools(
		agentId: string,
		toolNames: string[],
		activeToolNames?: string[],
	): Promise<void>;
	setAgentActiveTools(agentId: string, toolNames: string[]): Promise<void>;
	requestHuman(
		agentId: string,
		extensionId: string,
		request: HumanRequestDraft,
	): Promise<HumanResponse>;
	promptAgent(
		agentId: string,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<void>;
	steerAgent(
		agentId: string,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<void>;
	followUpAgent(
		agentId: string,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<void>;
	setAgentSessionName(agentId: string, name: string): Promise<void>;
	listCommands(agentId: string): Command[];
	setAgentModelByReference(
		agentId: string,
		reference: string,
	): Promise<RuntimeModel>;
	getAgentThinkingLevel(agentId: string): ThinkingLevel;
	setAgentThinkingLevel(agentId: string, level: ThinkingLevel): Promise<void>;
	exec(
		agentId: string,
		extensionId: string,
		command: string,
		options?: ShellExecOptions,
	): Promise<ExtensionExecResult>;
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
		| "appendEntry"
		| "exec"
		| "findEntries"
		| "followUp"
		| "prompt"
		| "requestHuman"
		| "setActiveTools"
		| "setModel"
		| "setSessionName"
		| "setThinkingLevel"
		| "setTools"
		| "steer";
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

export interface ExtensionLineCommandDefinition {
	readonly name: string;
	readonly placement?: Extract<CommandPlacement, "line">;
	readonly trigger?: string;
	readonly description?: string;
	readonly argumentHint?: string;
	readonly arguments?: ExtensionCommandArguments;
	readonly handler: ExtensionCommandHandler;
}

/**
 * Inline expansion is side-effect free by shape (ME slice 7): the callback
 * receives the argument string only - no context or actions handle - and
 * returns the replacement text. Data an expansion needs is captured in the
 * factory closure at activation time.
 */
export type ExtensionInlineCommandExpand = (
	argument: string,
) => Promise<string> | string;

// Inline commands share the fixed built-in trigger domain
// (`<name:argument>`); there is no trigger field to declare.
export interface ExtensionInlineCommandDefinition {
	readonly name: string;
	readonly placement: Extract<CommandPlacement, "inline">;
	readonly description?: string;
	readonly argumentHint?: string;
	readonly arguments?: ExtensionCommandArguments;
	readonly expand: ExtensionInlineCommandExpand;
}

export type ExtensionCommandDefinition =
	| ExtensionLineCommandDefinition
	| ExtensionInlineCommandDefinition;

/**
 * Activation-time resource path declaration (ME slice 8). The extension only
 * hands the core additional skill / prompt template paths to read; the
 * ResourceLoader stays the sole filesystem reader and interpreter, and the
 * contribution is scoped to the declaring runner's agent. A name that
 * collides with an already-registered resource loses first-registration-wins
 * and is dropped with a diagnostic.
 */
export interface ExtensionResourcePaths {
	readonly skillPaths?: readonly string[];
	readonly promptTemplatePaths?: readonly string[];
}

export type ExtensionObserver<
	TEvent extends ExtensionObservedEvent = ExtensionObservedEvent,
> = (event: TEvent, context: ExtensionContext) => Promise<void> | void;

export type ExtensionObserverFor<TName extends ExtensionObservedEventName> =
	ExtensionObserver<ExtensionObservedEventFor<TName>>;

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
	contributeResources(paths: ExtensionResourcePaths): void;
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
