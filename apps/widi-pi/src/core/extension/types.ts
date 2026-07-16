import type {
	AgentHarnessEventResultMap,
	BeforeAgentStartEvent,
	BeforeProviderRequestEvent,
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
import type { ProviderConfigInput } from "../model-registry.ts";
import type { ToolDefinition, ToolDefinitionPatch } from "../tools/types.ts";
import type {
	AgentToolsSnapshot,
	OrchestratorEvent,
	RuntimeModel,
} from "../types.ts";
import type {
	ExtensionDiagnosticDraft,
	ExtensionMessage,
	ExtensionStatus,
} from "./presentation.ts";

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
 * WIDI intentionally exposes only interceptors with settled semantics.
 *
 * Full AgentHarness hook candidates include:
 * - before_agent_start, context, tool_call, tool_result,
 *   before_provider_request (all exposed below)
 * - before_provider_payload (mutates the raw wire payload; deferred to
 *   backlog until a consumer justifies its failure semantics)
 * - session_before_compact, session_before_tree
 * - observer-like own events with no return value: after_provider_response,
 *   session_compact, session_tree, model_update, thinking_level_update,
 *   resources_update, tools_update, queue_update, save_point, abort, settled
 *   (all reachable through the raw `agent_harness_event` observer)
 *
 * Session hooks are deferred until permission, diagnostics, and
 * stale-context semantics are explicit.
 */
export type ExtensionInterceptorName =
	| "before_agent_start"
	| "before_provider_request"
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
	before_provider_request: BeforeProviderRequestEvent;
	context: ContextEvent;
	input: ExtensionInputEvent;
	tool_call: ToolCallEvent;
	tool_result: ToolResultEvent;
}

export interface ExtensionInterceptorResultMap {
	before_agent_start: AgentHarnessEventResultMap["before_agent_start"];
	before_provider_request: AgentHarnessEventResultMap["before_provider_request"];
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
 * Result of an extension-initiated compaction. The compaction entry is
 * already persisted when this value resolves - it is an observation, not a
 * mutation channel (mutation is the deferred `session_before_compact` hook).
 * WIDI owns this shape; the upstream harness return type is structural and
 * not exported by `pi-agent-core`.
 */
export interface ExtensionCompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: unknown;
}

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
	// Push append-only plain text for direct client display. Unlike
	// prompt/steer, it does not reach the model or the session. Repeated calls
	// create separate output items; sequentially awaiting calls preserves order.
	emitOutput(text: string): Promise<void>;
	// Fire a transient info-only notice. The consumer owns display lifetime;
	// notices have no severity, code, dedupe, clear, or attention semantics.
	notify(text: string): Promise<void>;
	// Keyed runtime current state for client status areas. Reusing a key
	// replaces the previous value; clearing a missing key is a no-op.
	setStatus(key: string, status: ExtensionStatus): Promise<void>;
	clearStatus(key: string): Promise<void>;
	// Durable presentation content: persisted as a core:extension_message
	// session custom entry before the event is published, never model
	// context. The returned entryId matches the persisted entry and the
	// canonical event, so consumers dedupe hydration against live events.
	publishMessage(message: ExtensionMessage): Promise<{ entryId: string }>;
	// Reported facts join the core diagnostic pipeline: domain, source,
	// agentId, and extensionId are injected, the local code is namespaced to
	// extension.<extensionId>.<code>, and every report gets a fresh core id -
	// no cross-report dedupe. Reported diagnostics never feed back into
	// extension observers.
	reportDiagnostic(draft: ExtensionDiagnosticDraft): Promise<void>;
	prompt(text: string, options?: { images?: ImageContent[] }): Promise<void>;
	steer(text: string, options?: { images?: ImageContent[] }): Promise<void>;
	followUp(text: string, options?: { images?: ImageContent[] }): Promise<void>;
	setSessionName(name: string): Promise<void>;
	getSessionName(): Promise<string | undefined>;
	// Requires an idle harness; rejects with the harness busy error otherwise.
	compact(customInstructions?: string): Promise<ExtensionCompactionResult>;
	getCommands(): Command[];
	setModel(reference: string): Promise<RuntimeModel>;
	getModel(): RuntimeModel;
	// Candidate values are model references accepted by setModel.
	listModelCandidates(): Promise<CommandCandidates>;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	// Aborts the agent's current run; queued steer/followUp input is cleared.
	abort(): Promise<void>;
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
	// commandId is present when the call comes from a line-command execution
	// context; the orchestrator writes it into the extension_output event.
	emitOutput(
		agentId: string,
		extensionId: string,
		text: string,
		commandId?: string,
	): Promise<void>;
	notify(
		agentId: string,
		extensionId: string,
		text: string,
		commandId?: string,
	): Promise<void>;
	setStatus(
		agentId: string,
		extensionId: string,
		key: string,
		status: ExtensionStatus,
		commandId?: string,
	): Promise<void>;
	clearStatus(
		agentId: string,
		extensionId: string,
		key: string,
		commandId?: string,
	): Promise<void>;
	publishMessage(
		agentId: string,
		extensionId: string,
		message: ExtensionMessage,
		commandId?: string,
	): Promise<{ entryId: string }>;
	reportDiagnostic(
		agentId: string,
		extensionId: string,
		draft: ExtensionDiagnosticDraft,
		commandId?: string,
	): Promise<void>;
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
	getAgentSessionName(agentId: string): Promise<string | undefined>;
	compactAgent(
		agentId: string,
		customInstructions?: string,
	): Promise<ExtensionCompactionResult>;
	listCommands(agentId: string): Command[];
	setAgentModelByReference(
		agentId: string,
		reference: string,
	): Promise<RuntimeModel>;
	getAgentModel(agentId: string): RuntimeModel;
	listModelCandidates(): Promise<CommandCandidates>;
	getAgentThinkingLevel(agentId: string): ThinkingLevel;
	setAgentThinkingLevel(agentId: string, level: ThinkingLevel): Promise<void>;
	abortAgent(agentId: string): Promise<void>;
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

/**
 * Session control facade results (extension-api-followup ruling). WIDI does
 * not impersonate pi's in-place session switch: new/fork/resume spawn a new
 * runtime agent and report its id; whether a client switches its active agent
 * is the client adapter's decision, driven by canonical orchestrator events.
 * The shapes are WIDI-owned narrowings - no SessionManager handle, mutable
 * entries, or session paths for writing cross the boundary.
 */
export interface ExtensionSessionCommandResult {
	agentId: string;
	sessionId?: string;
}

export interface ExtensionForkSessionOptions {
	entryId?: string;
}

export interface ExtensionNavigateTreeOptions {
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface ExtensionNavigateTreeResult {
	cancelled: boolean;
}

export interface ExtensionSessionCandidate {
	id: string;
	path: string;
	createdAt: string;
	cwd: string;
	profileId?: string;
}

/**
 * Binding contract for command-context capabilities. Session control enters
 * the extension surface only here - a human-triggered execution context -
 * never the plain observer/interceptor context; the orchestrator additionally
 * gates spawn-class operations (new/fork/resume) on the profile capability
 * `canSpawn` and requires an idle agent for operations that read or move the
 * current session (fork/navigateTree).
 */
export interface ExtensionCommandContextActions {
	waitForIdle(): Promise<void>;
	newSession(extensionId: string): Promise<ExtensionSessionCommandResult>;
	forkSession(
		extensionId: string,
		options?: ExtensionForkSessionOptions,
	): Promise<ExtensionSessionCommandResult>;
	navigateTree(
		extensionId: string,
		targetId: string,
		options?: ExtensionNavigateTreeOptions,
	): Promise<ExtensionNavigateTreeResult>;
	listSessions(extensionId: string): Promise<ExtensionSessionCandidate[]>;
	resumeSession(
		extensionId: string,
		reference: string,
	): Promise<ExtensionSessionCommandResult>;
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
		| "abort"
		| "appendEntry"
		| "clearStatus"
		| "compact"
		| "emitOutput"
		| "exec"
		| "findEntries"
		| "followUp"
		| "forkSession"
		| "getSessionName"
		| "listModelCandidates"
		| "listSessions"
		| "navigateTree"
		| "newSession"
		| "notify"
		| "prompt"
		| "publishMessage"
		| "reportDiagnostic"
		| "requestHuman"
		| "resumeSession"
		| "setActiveTools"
		| "setModel"
		| "setSessionName"
		| "setStatus"
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
	newSession(): Promise<ExtensionSessionCommandResult>;
	forkSession(
		options?: ExtensionForkSessionOptions,
	): Promise<ExtensionSessionCommandResult>;
	navigateTree(
		targetId: string,
		options?: ExtensionNavigateTreeOptions,
	): Promise<ExtensionNavigateTreeResult>;
	listSessions(): Promise<ExtensionSessionCandidate[]>;
	resumeSession(reference: string): Promise<ExtensionSessionCommandResult>;
}

// The handler's return value is surfaced as `command_completed.result`, the
// same channel built-in line commands use; clients render it in their
// transcript. Return `undefined` for a command that only performs side
// effects. For append-only progress during execution use `actions.emitOutput`.
export type ExtensionCommandHandler = (
	args: string,
	context: ExtensionCommandContext,
) => Promise<unknown> | unknown;

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

/**
 * Activation-time provider registration config (ME slice 9). The provider
 * name must be new - built-in, models.json, and other extensions' names are
 * not overridable (first-registration-wins, no proxy/override channel) - and
 * the config must define complete models. Credential ownership does not move:
 * `apiKey` is a config value reference resolved by the core at request time,
 * and OAuth credentials persist in core AuthStorage. Registration is global
 * (the model table is a process-wide fact) but its lifecycle is bound to the
 * declaring runner: reload re-registers, dispose withdraws.
 */
export type ExtensionProviderConfig = ProviderConfigInput;

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
	registerProvider(providerName: string, config: ExtensionProviderConfig): void;
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
 * Versioned extension declaration (ME slice 10). `apiVersion` names the
 * extension API version the extension targets; the loader refuses to activate
 * an extension declaring an unsupported version and reports
 * `extension.version_incompatible` instead. A bare factory omits the
 * declaration and is treated as targeting the current version.
 */
export interface ExtensionDefinition {
	readonly apiVersion: number;
	readonly activate: ExtensionFactory;
}

/**
 * What an extension module default-exports, and what `registerExtension`
 * accepts: a bare factory or a versioned definition. One declaration shape
 * covers all three extension sources (factory, file, package).
 */
export type ExtensionModule = ExtensionFactory | ExtensionDefinition;
