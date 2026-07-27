import type {
	AgentHarnessEventResultMap,
	BeforeAgentStartEvent,
	BeforeProviderRequestEvent,
	CompactResult,
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
import type { BackgroundJobSnapshot } from "../background/index.ts";
import type { HumanRequestDraft, HumanResponse } from "../human-request.ts";
import type { MessageSource } from "../message.ts";
import type { ProviderConfigInput } from "../model-registry.ts";
import type { ToolDefinition, ToolDefinitionPatch } from "../tools/types.ts";
import type {
	AgentId,
	AgentToolsSnapshot,
	CandidateItem,
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
	BackgroundJobExecutionContext,
	BackgroundJobReportAdapter,
	ToolDefinition,
	ToolDefinitionPatch,
	ToolExecute,
	ToolExecuteMiddleware,
	ToolExecutionContext,
	ToolExtensionContext,
	ToolSource,
} from "../tools/types.ts";

/**
 * A named, addressable partition inside one extension. An extension that
 * declares divisions is what the docs call an integration: one installable
 * unit whose parts can be switched on and off individually, instead of a
 * scattering of single-purpose extensions.
 *
 * Ids are dot-separated paths (`servers.github`); a division is only reachable
 * when every ancestor is enabled too.
 */
export interface ExtensionDivisionDeclaration {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** Default: true. */
	readonly enabledByDefault?: boolean;
}

/**
 * User-side division rules for a single extension. Each id applies to that
 * division and its whole subtree; the most specific matching rule wins, and
 * `disable` wins over `enable` within the same layer.
 */
export interface ExtensionDivisionSelection {
	readonly enable?: readonly string[];
	readonly disable?: readonly string[];
}

/**
 * Layered division rules, keyed by extension id. Layers stay separate rather
 * than pre-merged so the resolved state can name the layer it came from.
 */
export interface ExtensionDivisionSelections {
	readonly settings?: Readonly<Record<string, ExtensionDivisionSelection>>;
	readonly profile?: Readonly<Record<string, ExtensionDivisionSelection>>;
}

export type ExtensionDivisionSource =
	| "default"
	| "settings"
	| "profile"
	| "ancestor";

/** Resolved per-agent division state, for inspect facts. */
export interface ExtensionDivisionSnapshot {
	readonly extensionId: string;
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly enabled: boolean;
	/** False for a division id used at activation but never declared. */
	readonly declared: boolean;
	readonly source: ExtensionDivisionSource;
}

export type ExtensionObservedEventName = ExtensionObservedEvent["type"];

export type ExtensionObservedEvent = Extract<
	OrchestratorEvent,
	{
		type:
			| "agent_background_job_changed"
			| "agent_background_job_progress"
			| "agent_background_job_report_updated"
			| "agent_harness_event"
			| "agent_resumed"
			| "agent_session_forked"
			| "agent_session_info_changed"
			| "agent_spawned"
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
 * WIDI-native input interceptor event (ME slice 6). Fired by `sendMessage` for
 * every message ingress, not only human text: an agent-to-agent message, a
 * background job result, and a system notice all run the same pipeline, so no
 * input path bypasses an input policy. Not a Pi harness hook.
 *
 * `source` tells the cases apart. A handler that only means to rewrite human
 * input must check it, or it will also rewrite tool results the model is
 * waiting for. `targetAgentId` is the agent that will read the message, which
 * is not the handler's own agent for cross-agent delivery.
 */
export interface ExtensionInputEvent {
	readonly type: "input";
	readonly source: MessageSource;
	readonly targetAgentId: AgentId;
	readonly text: string;
	readonly images?: readonly ImageContent[];
}

/**
 * `undefined` passes the input through unchanged. A transform result rewrites
 * the text (and optionally the images; omitted images keep the current ones)
 * and feeds the next handler. A block result rejects the whole input and
 * short-circuits the pipeline; there is no pi-style "handled" escape hatch.
 *
 * A block is only enforced for sources whose caller can be told: background job
 * results are delivered anyway, because the model already holds the job handle
 * and would otherwise wait forever for a result that was silently dropped.
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
 * The shape follows pi-agent-core so retained-tail checkpoints and summary
 * usage remain observable to extensions.
 */
export type ExtensionCompactionResult = CompactResult;

/**
 * Agent-scoped action surface handed to extension authors. Every action is
 * bound to the extension's own agent; the agent id is injected by the runner
 * and never appears in a signature. Cross-agent operations are not part of
 * this contract (they belong to the M3 collaboration facade).
 */
export interface ExtensionActions {
	getTools(): AgentToolsSnapshot;
	// The agent's live backgrounded jobs: the ones whose t0 handles the model is
	// currently holding. Pairs with the three job observers, which report
	// transitions but never carry output.
	listJobs(): BackgroundJobSnapshot[];
	// Current rolling output tail of a live job, or undefined once it settles.
	// Pull-only, and the tail is bounded: an extension that needs the complete
	// stream must accumulate `agent_background_job_progress` increments instead,
	// which this cannot reconstruct after the head has been dropped.
	readJobOutput(jobId: string): string | undefined;
	// Request that a live job terminate, recording `reason` on its snapshot and
	// its result message. False when no such job is live - a listed job may have
	// settled since. This is a request: a job ends only when its tool honors the
	// signal.
	killJob(jobId: string, reason?: string): Promise<boolean>;
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
	// Reported facts join the core diagnostic pipeline: the draft is
	// { severity: "warning" | "error", code, message }; core injects agentId
	// and extensionId and namespaces the local code to
	// extension.<extensionId>.<code>. Reported diagnostics never feed back
	// into extension observers.
	reportDiagnostic(draft: ExtensionDiagnosticDraft): Promise<void>;
	prompt(text: string, options?: { images?: ImageContent[] }): Promise<void>;
	steer(text: string, options?: { images?: ImageContent[] }): Promise<void>;
	followUp(text: string, options?: { images?: ImageContent[] }): Promise<void>;
	setSessionName(name: string): Promise<void>;
	getSessionName(): Promise<string | undefined>;
	// Requires an idle harness; rejects with the harness busy error otherwise.
	compact(customInstructions?: string): Promise<ExtensionCompactionResult>;
	setModel(reference: string): Promise<RuntimeModel>;
	getModel(): RuntimeModel;
	// Candidate values are model references accepted by setModel.
	listModelCandidates(): Promise<readonly CandidateItem[]>;
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
	listAgentBackgroundJobs(agentId: string): BackgroundJobSnapshot[];
	readAgentBackgroundJobOutput(
		agentId: string,
		jobId: string,
	): string | undefined;
	abortAgentBackgroundJob(
		agentId: string,
		jobId: string,
		reason?: string,
	): boolean;
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
	emitOutput(agentId: string, extensionId: string, text: string): Promise<void>;
	notify(agentId: string, extensionId: string, text: string): Promise<void>;
	setStatus(
		agentId: string,
		extensionId: string,
		key: string,
		status: ExtensionStatus,
	): Promise<void>;
	clearStatus(agentId: string, extensionId: string, key: string): Promise<void>;
	publishMessage(
		agentId: string,
		extensionId: string,
		message: ExtensionMessage,
	): Promise<{ entryId: string }>;
	reportDiagnostic(
		agentId: string,
		extensionId: string,
		draft: ExtensionDiagnosticDraft,
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
	setAgentModelByReference(
		agentId: string,
		reference: string,
	): Promise<RuntimeModel>;
	getAgentModel(agentId: string): RuntimeModel;
	listModelCandidates(): Promise<readonly CandidateItem[]>;
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
		| "getSessionName"
		| "killJob"
		| "listModelCandidates"
		| "notify"
		| "prompt"
		| "publishMessage"
		| "reportDiagnostic"
		| "requestHuman"
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

/**
 * Teardown callback registered at activation time. Runs when the owning
 * extension runtime is disposed (agent disposed or extension reload replaces
 * the runner); use it to release resources the activation acquired, such as
 * open server connections.
 */
export type ExtensionDisposeHandler = () => Promise<void> | void;

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
	/**
	 * Register contributions that belong to one division. `register` is not
	 * called at all when the division is disabled, so a disabled part performs
	 * no side effects either - it never opens its connections or watchers.
	 *
	 * Ids nest: inside a `division("servers")` scope, `division("github")`
	 * declares `servers.github`. Await the call; the loader also awaits any
	 * pending registration before it settles the scope, so a forgotten `await`
	 * still lands its contributions.
	 */
	division(
		id: string,
		register: (api: ExtensionActivationApi) => void | Promise<void>,
	): Promise<void>;
	/** Relative to the current division scope, like `division`. */
	isDivisionEnabled(id: string): boolean;
	registerTool<TParamsSchema extends TSchema, TDetails>(
		tool: ToolDefinition<TParamsSchema, TDetails>,
	): void;
	patchTool<TParamsSchema extends TSchema, TDetails>(
		targetToolName: string,
		patch: ToolDefinitionPatch<TParamsSchema, TDetails>,
	): void;
	registerProvider(providerName: string, config: ExtensionProviderConfig): void;
	observe<TName extends ExtensionObservedEventName>(
		eventName: TName,
		handler: ExtensionObserverFor<TName>,
	): void;
	intercept<TName extends ExtensionInterceptorName>(
		eventName: TName,
		handler: ExtensionInterceptorFor<TName>,
	): void;
	onDispose(handler: ExtensionDisposeHandler): void;
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
 *
 * `divisions` names the switchable parts of an integration. It lives on the
 * default export rather than in a package manifest because the loader imports
 * the module before it activates anything, so the declared list is listable
 * (and togglable) without running any extension code - and because a
 * single-file extension has no manifest to put it in.
 */
export interface ExtensionDefinition {
	readonly apiVersion: number;
	readonly divisions?: readonly ExtensionDivisionDeclaration[];
	readonly activate: ExtensionFactory;
}

/**
 * What an extension module default-exports, and what `registerExtension`
 * accepts: a bare factory or a versioned definition. One declaration shape
 * covers all three extension sources (factory, file, package).
 */
export type ExtensionModule = ExtensionFactory | ExtensionDefinition;
