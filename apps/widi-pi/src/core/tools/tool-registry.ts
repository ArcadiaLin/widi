import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import {
	type CoreDiagnostic,
	createDiagnostic,
	type DiagnosticDisposition,
	type DiagnosticSeverity,
	type DiagnosticSource,
} from "../diagnostics.ts";
import type { ToolHumanHost } from "../orchestrator/human-request.ts";
import type {
	ToolContribution,
	ToolContributionSource,
	ToolDefinition,
	ToolDefinitionPatch,
	ToolExecutionContext,
	ToolExtensionContext,
} from "./types.ts";

type RegistryToolDefinition = ToolDefinition<TSchema, unknown>;
type RegistryToolDefinitionPatch = ToolDefinitionPatch<TSchema, unknown>;
export type AnyToolContribution = ToolContribution<TSchema, unknown>;

export type ToolRegistryDiagnosticSeverity = DiagnosticSeverity;

export type ToolRegistryDiagnosticCode =
	| "tool.define_conflict"
	| "tool.patch_target_missing"
	| "tool.patch_field_conflict"
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
	source: ToolContributionSource;
	priority: number;
}

export interface ResolvedTool {
	definition: RegistryToolDefinition;
	source: ToolContributionSource;
	priority: number;
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
	env?: ExecutionEnv;
	human?: ToolHumanHost;
	extension?: ToolExtensionContext;
	createExtensionContext?: (
		source: ToolContributionSource,
		toolName: string,
	) => ToolExtensionContext | undefined;
}

interface StoredContribution {
	contribution: AnyToolContribution;
	order: number;
}

interface DefinitionEntry {
	definition: RegistryToolDefinition;
	source: ToolContributionSource;
	priority: number;
	order: number;
}

interface PatchEntry {
	targetToolName: string;
	patch: RegistryToolDefinitionPatch;
	source: ToolContributionSource;
	priority: number;
	order: number;
}

const patchReplaceFields = [
	"description",
	"parameters",
	"strict",
	"execute",
] as const satisfies readonly (keyof RegistryToolDefinitionPatch)[];

export class ToolRegistry {
	private readonly _contributions: StoredContribution[] = [];
	private _nextOrder = 0;

	static from(contributions: readonly AnyToolContribution[]): ToolRegistry {
		const registry = new ToolRegistry();
		registry.addContributions(contributions);
		return registry;
	}

	addContribution<TParamsSchema extends TSchema, TDetails>(
		contribution: ToolContribution<TParamsSchema, TDetails>,
	): void {
		this._contributions.push({
			contribution: contribution as unknown as AnyToolContribution,
			order: this._nextOrder,
		});
		this._nextOrder += 1;
	}

	addContributions(contributions: readonly AnyToolContribution[]): void {
		for (const contribution of contributions) {
			this.addContribution(contribution);
		}
	}

	clear(): void {
		this._contributions.length = 0;
		this._nextOrder = 0;
	}

	getContributions(): readonly AnyToolContribution[] {
		return this._contributions.map(({ contribution }) => contribution);
	}

	resolve(options: ToolRegistryResolveOptions = {}): ToolRegistryResolveResult {
		const diagnostics: ToolRegistryDiagnostic[] = [];
		const definitions = new Map<string, DefinitionEntry>();
		const patchesByTarget = new Map<string, PatchEntry[]>();

		for (const stored of this._contributions) {
			if (stored.contribution.type === "define") {
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
		stored: StoredContribution,
	): void {
		if (stored.contribution.type !== "define") return;

		const toolName = stored.contribution.tool.name.trim();
		if (!toolName) {
			diagnostics.push(
				createToolDiagnostic({
					severity: "error",
					code: "tool.invalid_name",
					disposition: "degraded",
					message: `Tool definition from ${formatSource(stored.contribution.source)} has an empty name.`,
					source: stored.contribution.source,
				}),
			);
			return;
		}

		const nextEntry: DefinitionEntry = {
			definition: stored.contribution.tool as unknown as RegistryToolDefinition,
			source: stored.contribution.source,
			priority: stored.contribution.priority ?? 0,
			order: stored.order,
		};
		const previousEntry = definitions.get(toolName);
		if (!previousEntry) {
			definitions.set(toolName, nextEntry);
			return;
		}

		const winner =
			compareDefinitionPriority(previousEntry, nextEntry) <= 0
				? previousEntry
				: nextEntry;
		const ignored = winner === previousEntry ? nextEntry : previousEntry;
		definitions.set(toolName, winner);
		diagnostics.push(
			createToolDiagnostic({
				severity: "warning",
				code: "tool.define_conflict",
				message: `Tool '${toolName}' is defined by both ${formatSource(previousEntry.source)} and ${formatSource(nextEntry.source)}; keeping ${formatSource(winner.source)}.`,
				toolName,
				source: ignored.source,
				targetSource: winner.source,
			}),
		);
	}

	private _addPatch(
		patchesByTarget: Map<string, PatchEntry[]>,
		diagnostics: ToolRegistryDiagnostic[],
		stored: StoredContribution,
	): void {
		if (stored.contribution.type !== "patch") return;

		const targetToolName = stored.contribution.targetToolName.trim();
		if (!targetToolName) {
			diagnostics.push(
				createToolDiagnostic({
					severity: "error",
					code: "tool.invalid_name",
					disposition: "degraded",
					message: `Tool patch from ${formatSource(stored.contribution.source)} has an empty target tool name.`,
					source: stored.contribution.source,
				}),
			);
			return;
		}

		const patch: PatchEntry = {
			targetToolName,
			patch: stored.contribution
				.patch as unknown as RegistryToolDefinitionPatch,
			source: stored.contribution.source,
			priority: stored.contribution.priority ?? 0,
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
			for (const field of patchReplaceFields) {
				if (patchEntry.patch[field] === undefined) continue;
				const previousOwner = fieldOwners.get(field);
				if (previousOwner) {
					diagnostics.push(
						createToolDiagnostic({
							severity: "warning",
							code: "tool.patch_field_conflict",
							message: `Tool '${entry.definition.name}' field '${field}' is patched by both ${formatSource(previousOwner.source)} and ${formatSource(patchEntry.source)}; priority order decides the final value.`,
							toolName: entry.definition.name,
							source: patchEntry.source,
							targetSource: previousOwner.source,
							details: { field },
						}),
					);
				}
				fieldOwners.set(field, patchEntry);
			}
			definition = applyPatch(definition, patchEntry.patch);
		}

		return {
			definition,
			source: entry.source,
			priority: entry.priority,
			patches: appliedPatches.map((patch) => ({
				source: patch.source,
				priority: patch.priority,
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

export function createAgentToolFromResolvedTool(
	resolvedTool: ResolvedTool,
	context: ToolAgentAdapterContext,
): AgentTool<TSchema, unknown> {
	const definition = resolvedTool.definition;
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(
				toolCallId,
				params,
				createToolExecutionContext(resolvedTool, context, signal, onUpdate),
			),
	};
}

export function createAgentToolsFromResolvedTools(
	resolvedTools: readonly ResolvedTool[],
	context: ToolAgentAdapterContext,
): Array<AgentTool<TSchema, unknown>> {
	return resolvedTools.map((resolvedTool) =>
		createAgentToolFromResolvedTool(resolvedTool, context),
	);
}

function applyPatch(
	definition: RegistryToolDefinition,
	patch: RegistryToolDefinitionPatch,
): RegistryToolDefinition {
	const next: RegistryToolDefinition = { ...definition };
	if (patch.description !== undefined) next.description = patch.description;
	if (patch.parameters !== undefined) next.parameters = patch.parameters;
	if (patch.strict !== undefined) next.strict = patch.strict;

	const execute = patch.execute ?? next.execute;
	if (patch.aroundExecute) {
		const aroundExecute = patch.aroundExecute;
		next.execute = (toolCallId, params, context) =>
			aroundExecute(execute, toolCallId, params, context);
	} else if (patch.execute) {
		next.execute = patch.execute;
	}
	return next;
}

function createToolExecutionContext(
	resolvedTool: ResolvedTool,
	context: ToolAgentAdapterContext,
	signal: AbortSignal | undefined,
	onUpdate: Parameters<AgentTool<TSchema, unknown>["execute"]>[3],
): ToolExecutionContext<unknown> {
	const extension =
		context.createExtensionContext?.(
			resolvedTool.source,
			resolvedTool.definition.name,
		) ?? context.extension;
	return {
		env: context.env,
		signal,
		onUpdate,
		extension,
		human: context.human,
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
	readonly source?: ToolContributionSource;
	readonly targetSource?: ToolContributionSource;
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
			? diagnosticSourceFromToolContribution(options.source, options.toolName)
			: options.toolName
				? { kind: "tool", name: options.toolName }
				: undefined,
		targetSource: options.targetSource
			? diagnosticSourceFromToolContribution(
					options.targetSource,
					options.toolName,
				)
			: undefined,
		toolName: options.toolName,
		phase: "resolve",
		details: {
			contributionSource: options.source,
			targetContributionSource: options.targetSource,
			...options.details,
		},
	});
}

function diagnosticSourceFromToolContribution(
	source: ToolContributionSource,
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

function compareDefinitionPriority(
	left: DefinitionEntry,
	right: DefinitionEntry,
): number {
	if (left.priority !== right.priority) return right.priority - left.priority;
	return left.order - right.order;
}

function comparePatchApplyOrder(left: PatchEntry, right: PatchEntry): number {
	if (left.priority !== right.priority) return left.priority - right.priority;
	return left.order - right.order;
}

function isResolvedTool(
	value: ResolvedTool | undefined,
): value is ResolvedTool {
	return value !== undefined;
}

function formatSource(source: ToolContributionSource): string {
	return `${source.kind}:${source.id}`;
}
