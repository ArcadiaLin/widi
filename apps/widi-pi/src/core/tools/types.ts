import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type {
	BackgroundJobOutput,
	BackgroundJobTable,
} from "../background-job.ts";
import type { ToolHumanHost } from "../human-request.ts";

/**
 * Runtime context passed to a WIDI tool execution function.
 *
 * This is the adapter boundary between resolved WIDI tool definitions and Pi
 * `AgentHarnessTool` projections. Tool-specific backends are captured by the
 * tool definition factory, while the registry adapter combines turn-scoped
 * harness context with per-call facts such as abort, update, extension, and
 * human request handling.
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
	/**
	 * Per-agent registry of pseudo-async background jobs, when the runtime wired
	 * one. Job-control tools such as `wait_for_jobs` read live jobs and observe
	 * their settlements through it; most tools ignore it.
	 */
	backgroundJobTable?: BackgroundJobTable;
	/**
	 * Set when this call executes as a pseudo-async job (a `backgroundable`
	 * call registered in the job table); undefined for plain synchronous calls.
	 * The tool streams its raw output into `output` so job-control surfaces can
	 * peek at live progress; the tool's own result production is unaffected.
	 */
	job?: { readonly id: string; readonly output: BackgroundJobOutput };
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
 * project it into a Pi `AgentHarnessTool`. It owns execution metadata and the
 * execute closure only. UI preview/state is derived outside the tool from raw
 * harness events and tool results.
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

	/**
	 * Opt in to pseudo-async execution. When true, the runtime may turn a
	 * still-running call into a background job at a timeout deadline: it
	 * settles the tool call immediately with a job handle (t0) and delivers
	 * the eventual result later as a separate background job result message
	 * (t1). Default (false/omitted) keeps the tool fully synchronous.
	 *
	 * Only mark tools whose handle-first return is safe and whose result is
	 * still meaningful when delivered out of band (long-running bash, spawned
	 * agents). Never mark tools whose result must be consumed inline in the
	 * same turn (read before edit, and similar).
	 */
	backgroundable?: boolean;
	/**
	 * Wall-clock deadline in milliseconds after which a `backgroundable` call
	 * that is still running is moved to the background. This is an opt-in safety
	 * net, not the primary trigger: when omitted, the call is never
	 * auto-backgrounded on a timer and only moves to the background when the tool
	 * arguments explicitly request it (a `background: true` argument). Ignored
	 * unless `backgroundable` is true.
	 */
	backgroundTimeoutMs?: number;

	/** Execute the tool after arguments have been prepared and validated. */
	execute: ToolExecute<TParamsSchema, TDetails>;
}
