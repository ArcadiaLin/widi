import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import {
	type BackgroundJobTable,
	createBackgroundJobStartedResult,
} from "./background-job.ts";
import {
	type CoreDiagnostic,
	createDiagnostic,
	type DiagnosticDisposition,
	type DiagnosticSeverity,
	type DiagnosticSource,
} from "./diagnostics.ts";
import type { ToolHumanHost } from "./human-request.ts";
import type {
	ToolDefinition,
	ToolDefinitionPatch,
	ToolExecute,
	ToolExecutionContext,
	ToolExtensionContext,
	ToolSource,
} from "./tools/types.ts";

type RegistryToolDefinition = ToolDefinition<TSchema, unknown>;
type RegistryToolDefinitionPatch = ToolDefinitionPatch<TSchema, unknown>;

export type ToolRegistryDiagnosticSeverity = DiagnosticSeverity;

export type ToolRegistryDiagnosticCode =
	| "tool.define_conflict"
	| "tool.patch_target_missing"
	| "tool.patch_field_conflict"
	| "tool.patch_contract_risk"
	| "tool.requested_duplicate"
	| "tool.requested_missing"
	| "tool.active_duplicate"
	| "tool.active_missing"
	| "tool.invalid_name";

export type ToolRegistryDiagnostic = CoreDiagnostic;

export interface ToolRegistryResolveOptions {
	/**
	 * Tool names requested by profile/policy. Undefined means every resolved tool is visible.
	 */
	requestedToolNames?: readonly string[];
	/**
	 * Active tool names recovered from a session or selected by runtime policy.
	 * Undefined means every visible tool is active.
	 */
	activeToolNames?: readonly string[];
}

export interface ResolvedToolPatch {
	source: ToolSource;
}

export interface ResolvedTool {
	definition: RegistryToolDefinition;
	source: ToolSource;
	patches: readonly ResolvedToolPatch[];
}

export interface ToolRegistryResolveResult {
	allTools: readonly ResolvedTool[];
	tools: readonly ResolvedTool[];
	toolNames: readonly string[];
	activeToolNames: readonly string[];
	diagnostics: readonly ToolRegistryDiagnostic[];
	getTool(name: string): ResolvedTool | undefined;
	getToolDefinition(name: string): RegistryToolDefinition | undefined;
}

export interface ToolAgentAdapterContext {
	human?: ToolHumanHost;
	extension?: ToolExtensionContext;
	createExtensionContext?: (
		source: ToolSource,
		toolName: string,
	) => ToolExtensionContext | undefined;
	/**
	 * Table that owns pseudo-async background jobs. When provided, a
	 * `backgroundable` tool races a deadline and may settle its call with a job
	 * handle (t0) while the real work continues in the background. When omitted,
	 * every tool runs fully synchronously regardless of `backgroundable`.
	 */
	backgroundJobTable?: BackgroundJobTable;
}

type StoredToolRegistration =
	| {
			kind: "define";
			definition: RegistryToolDefinition;
			source: ToolSource;
			order: number;
	  }
	| {
			kind: "patch";
			targetToolName: string;
			patch: RegistryToolDefinitionPatch;
			source: ToolSource;
			order: number;
	  };

interface DefinitionEntry {
	definition: RegistryToolDefinition;
	source: ToolSource;
}

interface PatchEntry {
	targetToolName: string;
	patch: RegistryToolDefinitionPatch;
	source: ToolSource;
	order: number;
}

const bindToolExecutionContextSymbol = Symbol("bindToolExecutionContext");

type BindableToolExecutionContext<TDetails> = ToolExecutionContext<TDetails> & {
	[bindToolExecutionContextSymbol]?: (
		source: ToolSource,
	) => ToolExecutionContext<TDetails>;
};

const patchReplaceFields = [
	"description",
	"parameters",
	"strict",
	"execute",
] as const satisfies readonly (keyof RegistryToolDefinitionPatch)[];

export class ToolRegistry {
	private readonly _registrations: StoredToolRegistration[] = [];
	private _nextOrder = 0;

	defineTool<TParamsSchema extends TSchema, TDetails>(
		tool: ToolDefinition<TParamsSchema, TDetails>,
		source: ToolSource,
	): void {
		this._registrations.push({
			kind: "define",
			definition: tool as unknown as RegistryToolDefinition,
			source,
			order: this._nextOrder,
		});
		this._nextOrder += 1;
	}

	patchTool<TParamsSchema extends TSchema, TDetails>(
		targetToolName: string,
		patch: ToolDefinitionPatch<TParamsSchema, TDetails>,
		source: ToolSource,
	): void {
		this._registrations.push({
			kind: "patch",
			targetToolName,
			patch: patch as unknown as RegistryToolDefinitionPatch,
			source,
			order: this._nextOrder,
		});
		this._nextOrder += 1;
	}

	clear(): void {
		this._registrations.length = 0;
		this._nextOrder = 0;
	}

	clone(): ToolRegistry {
		const registry = new ToolRegistry();
		registry._registrations.push(...this._registrations);
		registry._nextOrder = this._nextOrder;
		return registry;
	}

	resolve(options: ToolRegistryResolveOptions = {}): ToolRegistryResolveResult {
		const diagnostics: ToolRegistryDiagnostic[] = [];
		const definitions = new Map<string, DefinitionEntry>();
		const patchesByTarget = new Map<string, PatchEntry[]>();

		for (const stored of this._registrations) {
			if (stored.kind === "define") {
				this._addDefinition(definitions, diagnostics, stored);
			} else {
				this._addPatch(patchesByTarget, diagnostics, stored);
			}
		}

		const resolvedByName = new Map<string, ResolvedTool>();
		for (const [name, entry] of definitions) {
			const resolved = this._resolveDefinition(
				entry,
				patchesByTarget.get(name) ?? [],
				diagnostics,
			);
			resolvedByName.set(name, resolved);
		}

		for (const [targetToolName, patches] of patchesByTarget) {
			if (definitions.has(targetToolName)) continue;
			for (const patch of patches) {
				diagnostics.push(
					createToolDiagnostic({
						severity: "warning",
						code: "tool.patch_target_missing",
						disposition: "degraded",
						message: `Tool patch from ${formatSource(patch.source)} targets missing tool '${targetToolName}'.`,
						toolName: targetToolName,
						source: patch.source,
					}),
				);
			}
		}

		const allTools = Array.from(resolvedByName.values());
		const visibleToolNames = this._resolveVisibleToolNames(
			options.requestedToolNames,
			resolvedByName,
			diagnostics,
		);
		const tools = visibleToolNames
			.map((name) => resolvedByName.get(name))
			.filter(isResolvedTool);
		const visibleByName = new Map(
			tools.map((tool) => [tool.definition.name, tool]),
		);
		const activeToolNames = this._resolveActiveToolNames(
			options.activeToolNames,
			visibleByName,
			diagnostics,
		);

		return {
			allTools,
			tools,
			toolNames: tools.map((tool) => tool.definition.name),
			activeToolNames,
			diagnostics,
			getTool: (name) => resolvedByName.get(name),
			getToolDefinition: (name) => resolvedByName.get(name)?.definition,
		};
	}

	private _addDefinition(
		definitions: Map<string, DefinitionEntry>,
		diagnostics: ToolRegistryDiagnostic[],
		stored: Extract<StoredToolRegistration, { kind: "define" }>,
	): void {
		const toolName = stored.definition.name.trim();
		if (!toolName) {
			diagnostics.push(
				createToolDiagnostic({
					severity: "error",
					code: "tool.invalid_name",
					disposition: "degraded",
					message: `Tool definition from ${formatSource(stored.source)} has an empty name.`,
					source: stored.source,
				}),
			);
			return;
		}

		const nextEntry: DefinitionEntry = {
			definition: stored.definition,
			source: stored.source,
		};
		const previousEntry = definitions.get(toolName);
		if (!previousEntry) {
			definitions.set(toolName, nextEntry);
			return;
		}

		diagnostics.push(
			createToolDiagnostic({
				severity: "warning",
				code: "tool.define_conflict",
				message: `Tool '${toolName}' is defined by both ${formatSource(previousEntry.source)} and ${formatSource(nextEntry.source)}; keeping ${formatSource(previousEntry.source)}.`,
				toolName,
				source: nextEntry.source,
				targetSource: previousEntry.source,
			}),
		);
	}

	private _addPatch(
		patchesByTarget: Map<string, PatchEntry[]>,
		diagnostics: ToolRegistryDiagnostic[],
		stored: Extract<StoredToolRegistration, { kind: "patch" }>,
	): void {
		const targetToolName = stored.targetToolName.trim();
		if (!targetToolName) {
			diagnostics.push(
				createToolDiagnostic({
					severity: "error",
					code: "tool.invalid_name",
					disposition: "degraded",
					message: `Tool patch from ${formatSource(stored.source)} has an empty target tool name.`,
					source: stored.source,
				}),
			);
			return;
		}

		const patch: PatchEntry = {
			targetToolName,
			patch: stored.patch,
			source: stored.source,
			order: stored.order,
		};
		const patches = patchesByTarget.get(targetToolName) ?? [];
		patches.push(patch);
		patchesByTarget.set(targetToolName, patches);
	}

	private _resolveDefinition(
		entry: DefinitionEntry,
		patches: readonly PatchEntry[],
		diagnostics: ToolRegistryDiagnostic[],
	): ResolvedTool {
		let definition = entry.definition;
		const appliedPatches = [...patches].sort(comparePatchApplyOrder);
		const fieldOwners = new Map<
			keyof RegistryToolDefinitionPatch,
			PatchEntry
		>();

		for (const patchEntry of appliedPatches) {
			if (
				patchEntry.patch.parameters !== undefined &&
				patchEntry.patch.execute === undefined &&
				patchEntry.patch.aroundExecute === undefined
			) {
				diagnostics.push(
					createToolDiagnostic({
						severity: "warning",
						code: "tool.patch_contract_risk",
						message: `Tool '${entry.definition.name}' parameters are patched by ${formatSource(patchEntry.source)} without an execute or aroundExecute patch; the existing execute implementation may not match the new schema.`,
						toolName: entry.definition.name,
						source: patchEntry.source,
						details: { field: "parameters" },
					}),
				);
			}
			for (const field of patchReplaceFields) {
				if (patchEntry.patch[field] === undefined) continue;
				const previousOwner = fieldOwners.get(field);
				if (previousOwner) {
					diagnostics.push(
						createToolDiagnostic({
							severity: "warning",
							code: "tool.patch_field_conflict",
							message: `Tool '${entry.definition.name}' field '${field}' is patched by both ${formatSource(previousOwner.source)} and ${formatSource(patchEntry.source)}; registration order decides the final value.`,
							toolName: entry.definition.name,
							source: patchEntry.source,
							targetSource: previousOwner.source,
							details: { field },
						}),
					);
				}
				fieldOwners.set(field, patchEntry);
			}
			definition = applyPatch(definition, patchEntry);
		}

		return {
			definition,
			source: entry.source,
			patches: appliedPatches.map((patch) => ({
				source: patch.source,
			})),
		};
	}

	private _resolveVisibleToolNames(
		requestedToolNames: readonly string[] | undefined,
		resolvedByName: ReadonlyMap<string, ResolvedTool>,
		diagnostics: ToolRegistryDiagnostic[],
	): string[] {
		if (!requestedToolNames) {
			return Array.from(resolvedByName.keys());
		}
		const names = normalizeToolNames(
			requestedToolNames,
			"tool.requested_duplicate",
			diagnostics,
		);
		const visibleToolNames: string[] = [];
		for (const name of names) {
			if (resolvedByName.has(name)) {
				visibleToolNames.push(name);
				continue;
			}
			diagnostics.push(
				createToolDiagnostic({
					severity: "warning",
					code: "tool.requested_missing",
					disposition: "degraded",
					message: `Requested tool '${name}' is not registered.`,
					toolName: name,
				}),
			);
		}
		return visibleToolNames;
	}

	private _resolveActiveToolNames(
		activeToolNames: readonly string[] | undefined,
		visibleByName: ReadonlyMap<string, ResolvedTool>,
		diagnostics: ToolRegistryDiagnostic[],
	): string[] {
		if (!activeToolNames) {
			return Array.from(visibleByName.keys());
		}
		const names = normalizeToolNames(
			activeToolNames,
			"tool.active_duplicate",
			diagnostics,
		);
		const resolvedActiveToolNames: string[] = [];
		for (const name of names) {
			if (visibleByName.has(name)) {
				resolvedActiveToolNames.push(name);
				continue;
			}
			diagnostics.push(
				createToolDiagnostic({
					severity: "warning",
					code: "tool.active_missing",
					disposition: "degraded",
					message: `Active tool '${name}' is not visible in the resolved tool set.`,
					toolName: name,
				}),
			);
		}
		return resolvedActiveToolNames;
	}
}

/**
 * Pi AgentTool produced by the WIDI adapter. Carries the WIDI definition's
 * prompt guidance so system prompt composition can consume it from the
 * harness's active tool list without reaching back into the registry.
 */
export interface WidiAgentTool extends AgentTool<TSchema, unknown> {
	/** Optional system-prompt snippet copied from the WIDI tool definition. */
	promptSnippet?: string;
	/** Optional prompt guidance bullets copied from the WIDI tool definition. */
	promptGuidelines?: readonly string[];
	/** Pseudo-async opt-in copied from the WIDI tool definition. */
	backgroundable?: boolean;
	/** Background timeout deadline copied from the WIDI tool definition. */
	backgroundTimeoutMs?: number;
}

export function createAgentToolFromResolvedTool(
	resolvedTool: ResolvedTool,
	context: ToolAgentAdapterContext,
): WidiAgentTool {
	const definition = resolvedTool.definition;
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
		backgroundable: definition.backgroundable,
		backgroundTimeoutMs: definition.backgroundTimeoutMs,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate) => {
			if (definition.backgroundable && context.backgroundJobTable) {
				const deadlineMs = resolveBackgroundDeadlineMs(definition, params);
				if (deadlineMs !== undefined) {
					return runBackgroundableToolCall({
						resolvedTool,
						context,
						table: context.backgroundJobTable,
						toolCallId,
						params,
						signal,
						onUpdate,
						deadlineMs,
					});
				}
			}
			return definition.execute(
				toolCallId,
				params,
				createToolExecutionContext(resolvedTool, context, signal, onUpdate),
			);
		},
	};
}

/**
 * Decide when, if ever, a `backgroundable` call should move to the background.
 *
 * An explicit `background: true` argument is the primary trigger and backgrounds
 * as soon as the call has not settled essentially immediately (deadline 0). A
 * configured `backgroundTimeoutMs` is an opt-in wall-clock safety net. With
 * neither, the call stays fully synchronous (undefined), so marking a tool
 * `backgroundable` never changes its behavior until a caller or the tool asks
 * for it.
 */
function resolveBackgroundDeadlineMs(
	definition: RegistryToolDefinition,
	params: unknown,
): number | undefined {
	if (isBackgroundRequested(params)) return 0;
	const configured = definition.backgroundTimeoutMs;
	if (
		typeof configured === "number" &&
		Number.isFinite(configured) &&
		configured >= 0
	) {
		return configured;
	}
	return undefined;
}

/** True when tool arguments explicitly opt this call into background execution. */
function isBackgroundRequested(params: unknown): boolean {
	return (
		typeof params === "object" &&
		params !== null &&
		(params as { background?: unknown }).background === true
	);
}

interface RunBackgroundableToolCallOptions {
	resolvedTool: ResolvedTool;
	context: ToolAgentAdapterContext;
	table: BackgroundJobTable;
	toolCallId: string;
	params: unknown;
	signal: AbortSignal | undefined;
	onUpdate: Parameters<AgentTool<TSchema, unknown>["execute"]>[3];
	/** Resolved deadline for this call; 0 backgrounds essentially immediately. */
	deadlineMs: number;
}

/**
 * Run a `backgroundable` tool call against a deadline.
 *
 * The tool executes with the job's own abort signal so its lifetime is
 * decoupled from the originating tool_use once backgrounded. If it settles
 * before the deadline, the real result is returned inline (the common case). If
 * the deadline wins, the call is moved to the background and settled with a job
 * handle (t0); the still-running promise records its terminal outcome on the
 * job, which drives the later t1 message via the table's result listeners.
 */
function runBackgroundableToolCall(
	options: RunBackgroundableToolCallOptions,
): Promise<AgentToolResult<unknown>> {
	const definition = options.resolvedTool.definition;
	const timeoutMs = options.deadlineMs;
	const job = options.table.create({
		toolCallId: options.toolCallId,
		toolName: definition.name,
	});

	// Forward the run signal to the job only during the synchronous window
	// (before t0): while pi still treats this as an in-flight tool call, a user
	// interrupt must cancel it. The forward is detached the moment the race
	// resolves (see below), so once the call is backgrounded the run signal no
	// longer owns the work.
	const signal = options.signal;
	const forwardAbort = () => options.table.abort(job.id);
	const detachForwardAbort = () =>
		signal?.removeEventListener("abort", forwardAbort);
	if (signal) {
		if (signal.aborted) forwardAbort();
		else signal.addEventListener("abort", forwardAbort, { once: true });
	}

	const toolContext = createToolExecutionContext(
		options.resolvedTool,
		options.context,
		job.signal,
		options.onUpdate,
	);
	// An untyped execute may throw synchronously or return a plain result instead
	// of a promise. Either would otherwise skip settlement, the race, or
	// abort-listener cleanup and orphan the job in the table. Normalize every
	// return shape at this adapter boundary so the rest of the pipeline always
	// operates on a real promise.
	let executePromise: Promise<AgentToolResult<unknown>>;
	try {
		executePromise = Promise.resolve(
			definition.execute(options.toolCallId, options.params, toolContext),
		);
	} catch (error) {
		executePromise = Promise.reject(error);
	}

	// Record the terminal outcome for the job. When it has already been
	// backgrounded this fires the table's result listeners (t1); otherwise the
	// inline return below delivers the result.
	executePromise.then(
		(result) => options.table.settle(job.id, { status: "completed", result }),
		(error) =>
			options.table.settle(job.id, {
				status: job.signal.aborted ? "cancelled" : "failed",
				error,
			}),
	);

	return raceSettlement(executePromise, timeoutMs).then((winner) => {
		// The race is resolved: the tool_use is now settled (t0 for the
		// backgrounded branch, or the real result for the inline branch). Detach
		// the run-signal forward so a later abortAgent() cannot cancel a
		// backgrounded job; its lifetime is the job table's from here (dispose
		// cascade or explicit abort).
		detachForwardAbort();
		if (winner === "timeout" && options.table.background(job.id)) {
			return createBackgroundJobStartedResult({
				jobId: job.id,
				toolCallId: options.toolCallId,
				toolName: definition.name,
			});
		}
		// Settled before the deadline (or the deadline lost the microtask race):
		// return or throw the real result inline.
		return executePromise;
	});
}

/**
 * Resolve `"settled"` when `promise` settles or `"timeout"` when `timeoutMs`
 * elapses first, whichever comes first. Never rejects: both branches only report
 * the winner, so the caller decides how to consume the settled promise.
 */
function raceSettlement(
	promise: Promise<unknown>,
	timeoutMs: number,
): Promise<"settled" | "timeout"> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve("timeout"), timeoutMs);
		const onSettled = () => {
			clearTimeout(timer);
			resolve("settled");
		};
		promise.then(onSettled, onSettled);
	});
}

export function createAgentToolsFromResolvedTools(
	resolvedTools: readonly ResolvedTool[],
	context: ToolAgentAdapterContext,
): WidiAgentTool[] {
	return resolvedTools.map((resolvedTool) =>
		createAgentToolFromResolvedTool(resolvedTool, context),
	);
}

function applyPatch(
	definition: RegistryToolDefinition,
	patchEntry: PatchEntry,
): RegistryToolDefinition {
	const patch = patchEntry.patch;
	const next: RegistryToolDefinition = { ...definition };
	if (patch.description !== undefined) next.description = patch.description;
	if (patch.parameters !== undefined) next.parameters = patch.parameters;
	if (patch.strict !== undefined) next.strict = patch.strict;

	const previousExecute = next.execute;
	const patchExecute = patch.execute;
	const execute: ToolExecute<TSchema, unknown> = patchExecute
		? (toolCallId, params, context) =>
				patchExecute(
					toolCallId,
					params,
					bindToolExecutionContext(context, patchEntry.source),
				)
		: previousExecute;
	if (patch.aroundExecute) {
		const aroundExecute = patch.aroundExecute;
		next.execute = (toolCallId, params, context) =>
			aroundExecute(
				(nextToolCallId, nextParams, nextContext) =>
					execute(
						nextToolCallId,
						nextParams,
						restoreInnerToolExecutionContext(nextContext, context),
					),
				toolCallId,
				params,
				bindToolExecutionContext(context, patchEntry.source),
			);
	} else if (patch.execute) {
		next.execute = execute;
	}
	return next;
}

function createToolExecutionContext(
	resolvedTool: ResolvedTool,
	context: ToolAgentAdapterContext,
	signal: AbortSignal | undefined,
	onUpdate: Parameters<AgentTool<TSchema, unknown>["execute"]>[3],
): ToolExecutionContext<unknown> {
	const bindContext = (source: ToolSource) => ({
		signal,
		onUpdate,
		extension:
			context.createExtensionContext?.(source, resolvedTool.definition.name) ??
			context.extension,
		human: context.human,
		backgroundJobTable: context.backgroundJobTable,
		[bindToolExecutionContextSymbol]: bindContext,
	});
	return bindContext(resolvedTool.source);
}

function bindToolExecutionContext<TDetails>(
	context: ToolExecutionContext<TDetails>,
	source: ToolSource,
): ToolExecutionContext<TDetails> {
	const bindContext = (context as BindableToolExecutionContext<TDetails>)[
		bindToolExecutionContextSymbol
	];
	return bindContext?.(source) ?? context;
}

function restoreInnerToolExecutionContext<TDetails>(
	context: ToolExecutionContext<TDetails>,
	innerContext: ToolExecutionContext<TDetails>,
): ToolExecutionContext<TDetails> {
	const bindContext = (innerContext as BindableToolExecutionContext<TDetails>)[
		bindToolExecutionContextSymbol
	];
	return {
		signal: context.signal,
		onUpdate: context.onUpdate,
		extension: innerContext.extension,
		human: context.human,
		backgroundJobTable: context.backgroundJobTable,
		...(bindContext
			? { [bindToolExecutionContextSymbol]: bindContext }
			: undefined),
	};
}

function normalizeToolNames(
	names: readonly string[],
	duplicateCode: "tool.requested_duplicate" | "tool.active_duplicate",
	diagnostics: ToolRegistryDiagnostic[],
): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const rawName of names) {
		const name = rawName.trim();
		if (!name) {
			diagnostics.push(
				createToolDiagnostic({
					severity: "error",
					code: "tool.invalid_name",
					disposition: "degraded",
					message: "Tool name list contains an empty name.",
				}),
			);
			continue;
		}
		if (seen.has(name)) {
			diagnostics.push(
				createToolDiagnostic({
					severity: "warning",
					code: duplicateCode,
					message: `Tool name '${name}' is listed more than once; keeping the first occurrence.`,
					toolName: name,
				}),
			);
			continue;
		}
		seen.add(name);
		normalized.push(name);
	}
	return normalized;
}

function createToolDiagnostic(options: {
	readonly severity: ToolRegistryDiagnosticSeverity;
	readonly code: ToolRegistryDiagnosticCode;
	readonly message: string;
	readonly disposition?: DiagnosticDisposition;
	readonly toolName?: string;
	readonly source?: ToolSource;
	readonly targetSource?: ToolSource;
	readonly details?: Record<string, unknown>;
}): ToolRegistryDiagnostic {
	return createDiagnostic({
		domain: "tool",
		code: options.code,
		severity: options.severity,
		disposition:
			options.disposition ??
			(options.severity === "error" ? "degraded" : "reported"),
		recoverable: true,
		message: options.message,
		source: options.source
			? diagnosticSourceFromToolSource(options.source, options.toolName)
			: options.toolName
				? { kind: "tool", name: options.toolName }
				: undefined,
		targetSource: options.targetSource
			? diagnosticSourceFromToolSource(options.targetSource, options.toolName)
			: undefined,
		toolName: options.toolName,
		phase: "resolve",
		details: {
			toolSource: options.source,
			targetToolSource: options.targetSource,
			...options.details,
		},
	});
}

function diagnosticSourceFromToolSource(
	source: ToolSource,
	toolName: string | undefined,
): DiagnosticSource {
	if (source.kind === "extension") {
		return {
			kind: "extension",
			id: source.id,
		};
	}
	return {
		kind: "registry",
		name: toolName ? `tool:${toolName}` : "tool",
		key: `${source.kind}:${source.id}`,
	};
}

function comparePatchApplyOrder(left: PatchEntry, right: PatchEntry): number {
	return left.order - right.order;
}

function isResolvedTool(
	value: ResolvedTool | undefined,
): value is ResolvedTool {
	return value !== undefined;
}

function formatSource(source: ToolSource): string {
	return `${source.kind}:${source.id}`;
}
