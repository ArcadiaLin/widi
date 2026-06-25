import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExecutionEnv,
	ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type { ToolHumanHost } from "../orchestrator/human-request.ts";

export type ToolExecutionEnvCapability = "filesystem" | "shell";

export interface ToolExecutionEnvRequirement {
	/**
	 * Host-provided execution environment required by this tool.
	 *
	 * This is intentionally declarative: the registry/runtime decides how to
	 * resolve the actual ExecutionEnv before calling execute().
	 */
	kind: "harness";
	capabilities?: readonly ToolExecutionEnvCapability[];
}

export type ToolCallPhase =
	| "created"
	| "arguments_streaming"
	| "arguments_ready"
	| "executing"
	| "done"
	| "error";

export interface ToolCallStateBase<TParams> {
	toolCallId: string;
	toolName: string;
	phase: ToolCallPhase;
	rawArguments: string;
	partialArguments?: Partial<TParams>;
	params?: TParams;
}

export type ToolStateEvent<TParams, TDetails> =
	| {
			type: "tool_call_created";
			toolCallId: string;
			toolName: string;
	  }
	| {
			type: "arguments_delta";
			toolCallId: string;
			delta: string;
			rawArguments: string;
			partialArguments?: Partial<TParams>;
	  }
	| {
			type: "arguments_ready";
			toolCallId: string;
			params: TParams;
	  }
	| {
			type: "execution_started";
			toolCallId: string;
			params: TParams;
	  }
	| {
			type: "execution_update";
			toolCallId: string;
			update: AgentToolResult<TDetails>;
	  }
	| {
			type: "execution_result";
			toolCallId: string;
			result: AgentToolResult<TDetails>;
	  }
	| {
			type: "execution_error";
			toolCallId: string;
			error: unknown;
	  };

export interface ToolExecutionContext<TDetails, TState> {
	env: ExecutionEnv | undefined;
	signal: AbortSignal | undefined;
	onUpdate: AgentToolUpdateCallback<TDetails> | undefined;
	extension: ToolExtensionContext | undefined;
	human: ToolHumanHost | undefined;
	getState?: () => TState;
	setState?: (state: TState) => void;
}

export interface ToolExtensionContext {
	extensionId: string;
	host?: unknown;
}

export type ToolExecute<
	TParamsSchema extends TSchema = TSchema,
	TDetails = unknown,
	TState = unknown,
> = (
	toolCallId: string,
	params: Static<TParamsSchema>,
	context: ToolExecutionContext<TDetails, TState>,
) => Promise<AgentToolResult<TDetails>>;

export type ToolExecuteMiddleware<
	TParamsSchema extends TSchema = TSchema,
	TDetails = unknown,
	TState = unknown,
> = (
	next: ToolExecute<TParamsSchema, TDetails, TState>,
	toolCallId: string,
	params: Static<TParamsSchema>,
	context: ToolExecutionContext<TDetails, TState>,
) => Promise<AgentToolResult<TDetails>>;

export interface ToolDefinitionPatch<
	TParamsSchema extends TSchema = TSchema,
	TDetails = unknown,
	TState = ToolCallStateBase<Static<TParamsSchema>>,
> {
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	prepareArguments?: (args: unknown) => Static<TParamsSchema>;
	executionMode?: ToolExecutionMode;
	executionEnv?: ToolExecutionEnvRequirement;
	createState?: (
		event: Extract<
			ToolStateEvent<Static<TParamsSchema>, TDetails>,
			{ type: "tool_call_created" }
		>,
	) => TState;
	reduceState?: (
		state: TState,
		event: ToolStateEvent<Static<TParamsSchema>, TDetails>,
	) => TState;
	execute?: ToolExecute<TParamsSchema, TDetails, TState>;
	aroundExecute?: ToolExecuteMiddleware<TParamsSchema, TDetails, TState>;
}

export interface ToolContributionSource {
	kind: "core" | "extension" | "adapter";
	id: string;
}

export interface ToolDefinitionContribution<
	TParamsSchema extends TSchema = TSchema,
	TDetails = unknown,
	TState = ToolCallStateBase<Static<TParamsSchema>>,
> {
	type: "define";
	source: ToolContributionSource;
	priority?: number;
	tool: ToolDefinition<TParamsSchema, TDetails, TState>;
}

export interface ToolPatchContribution<
	TParamsSchema extends TSchema = TSchema,
	TDetails = unknown,
	TState = ToolCallStateBase<Static<TParamsSchema>>,
> {
	type: "patch";
	source: ToolContributionSource;
	targetToolName: string;
	priority?: number;
	patch: ToolDefinitionPatch<TParamsSchema, TDetails, TState>;
}

export type ToolContribution<
	TParamsSchema extends TSchema = TSchema,
	TDetails = unknown,
	TState = ToolCallStateBase<Static<TParamsSchema>>,
> =
	| ToolDefinitionContribution<TParamsSchema, TDetails, TState>
	| ToolPatchContribution<TParamsSchema, TDetails, TState>;

/**
 * WIDI-owned tool definition.
 *
 * The tool owns execution metadata and a pure state reducer. UI layers consume
 * the resulting state instead of being referenced by the tool registry.
 */
export interface ToolDefinition<
	TParamsSchema extends TSchema = TSchema,
	TDetails = unknown,
	TState = ToolCallStateBase<Static<TParamsSchema>>,
> {
	name: string;
	label: string;
	description: string;

	promptSnippet?: string;
	promptGuidelines?: string[];

	parameters: TParamsSchema;
	prepareArguments?: (args: unknown) => Static<TParamsSchema>;

	executionMode?: ToolExecutionMode;
	executionEnv?: ToolExecutionEnvRequirement;

	createState?: (
		event: Extract<
			ToolStateEvent<Static<TParamsSchema>, TDetails>,
			{ type: "tool_call_created" }
		>,
	) => TState;
	reduceState?: (
		state: TState,
		event: ToolStateEvent<Static<TParamsSchema>, TDetails>,
	) => TState;

	execute: ToolExecute<TParamsSchema, TDetails, TState>;
}
