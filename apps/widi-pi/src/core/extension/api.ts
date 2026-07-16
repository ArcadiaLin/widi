/**
 * Extension-author API surface (ME slice 10).
 *
 * Everything a third-party extension may depend on is exported from this
 * module, plus the upstream types enumerated by reference in the public
 * contract (docs/zh-CN/core/extensions.md): the Pi typed hook events/results, the
 * raw `AgentHarnessEvent`, `ImageContent`, `ThinkingLevel`,
 * `ShellExecOptions`, `Result`/`ExecutionError`, and typebox `TSchema`.
 *
 * Versioning policy (presentation-protocol ruling): the extension API has no
 * public release yet, so version 1 is still reshaped in place - presentation
 * actions and contract adjustments land on v1 without a bump. The surface
 * freezes at the first public release; from then on breaking changes to it -
 * including breaking changes to those upstream types - bump
 * EXTENSION_API_VERSION.
 */

export const EXTENSION_API_VERSION: number = 1;

export const MIN_SUPPORTED_EXTENSION_API_VERSION: number = 1;

export function isSupportedExtensionApiVersion(version: number): boolean {
	return (
		Number.isInteger(version) &&
		version >= MIN_SUPPORTED_EXTENSION_API_VERSION &&
		version <= EXTENSION_API_VERSION
	);
}

// WIDI core types named in author-facing signatures are re-exported here so
// a third-party extension never imports core internals directly.
export type {
	Command,
	CommandCandidates,
	CommandPlacement,
} from "../command.ts";
export type { CoreDiagnostic } from "../diagnostics.ts";
export type { HumanRequestDraft, HumanResponse } from "../human-request.ts";
export type { AgentToolsSnapshot, RuntimeModel } from "../types.ts";
export type {
	ExtensionActions,
	ExtensionActivationApi,
	ExtensionCommandArguments,
	ExtensionCommandContext,
	ExtensionCommandDefinition,
	ExtensionCommandHandler,
	ExtensionContext,
	ExtensionCustomEntry,
	ExtensionDefinition,
	ExtensionExecResult,
	ExtensionFactory,
	ExtensionInlineCommandDefinition,
	ExtensionInlineCommandExpand,
	ExtensionInputEvent,
	ExtensionInputResult,
	ExtensionInterceptorEventFor,
	ExtensionInterceptorFor,
	ExtensionInterceptorName,
	ExtensionInterceptorResultFor,
	ExtensionLineCommandDefinition,
	ExtensionModule,
	ExtensionObservedEvent,
	ExtensionObservedEventFor,
	ExtensionObservedEventName,
	ExtensionObserver,
	ExtensionObserverFor,
	ExtensionProviderConfig,
	ExtensionResourcePaths,
	ExtensionSessionContext,
	ToolDefinition,
	ToolDefinitionPatch,
	ToolExecute,
	ToolExecuteMiddleware,
	ToolExecutionContext,
	ToolExtensionContext,
	ToolSource,
} from "./types.ts";
