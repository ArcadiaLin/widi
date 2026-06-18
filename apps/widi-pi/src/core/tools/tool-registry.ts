import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type {
	SessionFactStore,
	ToolContribution,
	ToolContributionSource,
	ToolDefinition,
	ToolDefinitionPatch,
	ToolExtensionContext,
	ToolExecutionContext,
} from "./types.ts";

type RegistryToolDefinition = ToolDefinition<TSchema, unknown, unknown>;
type RegistryToolDefinitionPatch = ToolDefinitionPatch<TSchema, unknown, unknown>;
export type AnyToolContribution = ToolContribution<TSchema, unknown, unknown>;

export type ToolRegistryDiagnosticSeverity = "info" | "warning" | "error";

export type ToolRegistryDiagnosticCode =
	| "tool_define_conflict"
	| "tool_patch_target_missing"
	| "tool_patch_field_conflict"
	| "tool_requested_duplicate"
	| "tool_requested_missing"
	| "tool_active_duplicate"
	| "tool_active_missing"
	| "tool_invalid_name";

export interface ToolRegistryDiagnostic {
	severity: ToolRegistryDiagnosticSeverity;
	code: ToolRegistryDiagnosticCode;
	message: string;
	toolName?: string;
	source?: ToolContributionSource;
	targetSource?: ToolContributionSource;
	recoverable: boolean;
}

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
	session: SessionFactStore;
	extension?: ToolExtensionContext;
	createExtensionContext?: (source: ToolContributionSource, toolName: string) => ToolExtensionContext | undefined;
	getState?: (toolCallId: string, toolName: string) => unknown;
	setState?: (toolCallId: string, toolName: string, state: unknown) => void;
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
	"label",
	"description",
	"promptSnippet",
	"promptGuidelines",
	"prepareArguments",
	"executionMode",
	"executionEnv",
	"createState",
	"reduceState",
	"execute",
] as const satisfies readonly (keyof RegistryToolDefinitionPatch)[];

export class ToolRegistry {
	private readonly _contributions: StoredContribution[] = [];
	private _nextOrder = 0;

	constructor() {}

	static from(contributions: readonly AnyToolContribution[]): ToolRegistry {
		const registry = new ToolRegistry();
		registry.addContributions(contributions);
		return registry;
	}

	addContribution<TParamsSchema extends TSchema, TDetails, TState>(
		contribution: ToolContribution<TParamsSchema, TDetails, TState>,
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
			const resolved = this._resolveDefinition(entry, patchesByTarget.get(name) ?? [], diagnostics);
			resolvedByName.set(name, resolved);
		}

		for (const [targetToolName, patches] of patchesByTarget) {
			if (definitions.has(targetToolName)) continue;
			for (const patch of patches) {
				diagnostics.push({
					severity: "warning",
					code: "tool_patch_target_missing",
					message: `Tool patch from ${formatSource(patch.source)} targets missing tool '${targetToolName}'.`,
					toolName: targetToolName,
					source: patch.source,
					recoverable: true,
				});
			}
		}

		const allTools = Array.from(resolvedByName.values());
		const visibleToolNames = this._resolveVisibleToolNames(options.requestedToolNames, resolvedByName, diagnostics);
		const tools = visibleToolNames.map((name) => resolvedByName.get(name)).filter(isResolvedTool);
		const visibleByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
		const activeToolNames = this._resolveActiveToolNames(options.activeToolNames, visibleByName, diagnostics);

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
			diagnostics.push({
				severity: "error",
				code: "tool_invalid_name",
				message: `Tool definition from ${formatSource(stored.contribution.source)} has an empty name.`,
				source: stored.contribution.source,
				recoverable: true,
			});
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

		const winner = compareDefinitionPriority(previousEntry, nextEntry) <= 0 ? previousEntry : nextEntry;
		const ignored = winner === previousEntry ? nextEntry : previousEntry;
		definitions.set(toolName, winner);
		diagnostics.push({
			severity: "warning",
			code: "tool_define_conflict",
			message: `Tool '${toolName}' is defined by both ${formatSource(previousEntry.source)} and ${formatSource(nextEntry.source)}; keeping ${formatSource(winner.source)}.`,
			toolName,
			source: ignored.source,
			targetSource: winner.source,
			recoverable: true,
		});
	}

	private _addPatch(
		patchesByTarget: Map<string, PatchEntry[]>,
		diagnostics: ToolRegistryDiagnostic[],
		stored: StoredContribution,
	): void {
		if (stored.contribution.type !== "patch") return;

		const targetToolName = stored.contribution.targetToolName.trim();
		if (!targetToolName) {
			diagnostics.push({
				severity: "error",
				code: "tool_invalid_name",
				message: `Tool patch from ${formatSource(stored.contribution.source)} has an empty target tool name.`,
				source: stored.contribution.source,
				recoverable: true,
			});
			return;
		}

		const patch: PatchEntry = {
			targetToolName,
			patch: stored.contribution.patch as unknown as RegistryToolDefinitionPatch,
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
		const fieldOwners = new Map<keyof RegistryToolDefinitionPatch, PatchEntry>();

		for (const patchEntry of appliedPatches) {
			for (const field of patchReplaceFields) {
				if (patchEntry.patch[field] === undefined) continue;
				const previousOwner = fieldOwners.get(field);
				if (previousOwner) {
					diagnostics.push({
						severity: "warning",
						code: "tool_patch_field_conflict",
						message: `Tool '${entry.definition.name}' field '${field}' is patched by both ${formatSource(previousOwner.source)} and ${formatSource(patchEntry.source)}; priority order decides the final value.`,
						toolName: entry.definition.name,
						source: patchEntry.source,
						targetSource: previousOwner.source,
						recoverable: true,
					});
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
		const names = normalizeToolNames(requestedToolNames, "tool_requested_duplicate", diagnostics);
		const visibleToolNames: string[] = [];
		for (const name of names) {
			if (resolvedByName.has(name)) {
				visibleToolNames.push(name);
				continue;
			}
			diagnostics.push({
				severity: "warning",
				code: "tool_requested_missing",
				message: `Requested tool '${name}' is not registered.`,
				toolName: name,
				recoverable: true,
			});
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
		const names = normalizeToolNames(activeToolNames, "tool_active_duplicate", diagnostics);
		const resolvedActiveToolNames: string[] = [];
		for (const name of names) {
			if (visibleByName.has(name)) {
				resolvedActiveToolNames.push(name);
				continue;
			}
			diagnostics.push({
				severity: "warning",
				code: "tool_active_missing",
				message: `Active tool '${name}' is not visible in the resolved tool set.`,
				toolName: name,
				recoverable: true,
			});
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
			definition.execute(toolCallId, params, createToolExecutionContext(resolvedTool, toolCallId, context, signal, onUpdate)),
	};
}

export function createAgentToolsFromResolvedTools(
	resolvedTools: readonly ResolvedTool[],
	context: ToolAgentAdapterContext,
): Array<AgentTool<TSchema, unknown>> {
	return resolvedTools.map((resolvedTool) => createAgentToolFromResolvedTool(resolvedTool, context));
}

function applyPatch(
	definition: RegistryToolDefinition,
	patch: RegistryToolDefinitionPatch,
): RegistryToolDefinition {
	const next: RegistryToolDefinition = { ...definition };
	if (patch.label !== undefined) next.label = patch.label;
	if (patch.description !== undefined) next.description = patch.description;
	if (patch.promptSnippet !== undefined) next.promptSnippet = patch.promptSnippet;
	if (patch.promptGuidelines !== undefined) next.promptGuidelines = [...patch.promptGuidelines];
	if (patch.prepareArguments !== undefined) next.prepareArguments = patch.prepareArguments;
	if (patch.executionMode !== undefined) next.executionMode = patch.executionMode;
	if (patch.executionEnv !== undefined) next.executionEnv = patch.executionEnv;
	if (patch.sessionFacts !== undefined) next.sessionFacts = [...(next.sessionFacts ?? []), ...patch.sessionFacts];
	if (patch.createState !== undefined) next.createState = patch.createState;
	if (patch.reduceState !== undefined) next.reduceState = patch.reduceState;

	const execute = patch.execute ?? next.execute;
	if (patch.aroundExecute) {
		const aroundExecute = patch.aroundExecute;
		next.execute = (toolCallId, params, context) => aroundExecute(execute, toolCallId, params, context);
	} else if (patch.execute) {
		next.execute = patch.execute;
	}
	return next;
}

function createToolExecutionContext(
	resolvedTool: ResolvedTool,
	toolCallId: string,
	context: ToolAgentAdapterContext,
	signal: AbortSignal | undefined,
	onUpdate: Parameters<AgentTool<TSchema, unknown>["execute"]>[3],
): ToolExecutionContext<unknown, unknown> {
	const extension =
		context.createExtensionContext?.(resolvedTool.source, resolvedTool.definition.name) ?? context.extension;
	return {
		env: context.env,
		signal,
		onUpdate,
		session: context.session,
		extension,
		getState: context.getState ? () => context.getState?.(toolCallId, resolvedTool.definition.name) : undefined,
		setState: context.setState
			? (state) => context.setState?.(toolCallId, resolvedTool.definition.name, state)
			: undefined,
	};
}

function normalizeToolNames(
	names: readonly string[],
	duplicateCode: "tool_requested_duplicate" | "tool_active_duplicate",
	diagnostics: ToolRegistryDiagnostic[],
): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const rawName of names) {
		const name = rawName.trim();
		if (!name) {
			diagnostics.push({
				severity: "error",
				code: "tool_invalid_name",
				message: "Tool name list contains an empty name.",
				recoverable: true,
			});
			continue;
		}
		if (seen.has(name)) {
			diagnostics.push({
				severity: "warning",
				code: duplicateCode,
				message: `Tool name '${name}' is listed more than once; keeping the first occurrence.`,
				toolName: name,
				recoverable: true,
			});
			continue;
		}
		seen.add(name);
		normalized.push(name);
	}
	return normalized;
}

function compareDefinitionPriority(left: DefinitionEntry, right: DefinitionEntry): number {
	if (left.priority !== right.priority) return right.priority - left.priority;
	return left.order - right.order;
}

function comparePatchApplyOrder(left: PatchEntry, right: PatchEntry): number {
	if (left.priority !== right.priority) return left.priority - right.priority;
	return left.order - right.order;
}

function isResolvedTool(value: ResolvedTool | undefined): value is ResolvedTool {
	return value !== undefined;
}

function formatSource(source: ToolContributionSource): string {
	return `${source.kind}:${source.id}`;
}
