import {
	type CoreDiagnostic,
	createDiagnostic,
	type DiagnosticSeverity,
} from "../diagnostics.ts";
import type { ToolRegistry } from "../tools/tool-registry.ts";
import type {
	ExtensionActions,
	ExtensionActivationApi,
	ExtensionEvent,
	ExtensionEventName,
	ExtensionFactory,
	ExtensionHandler,
	ExtensionHandlerFor,
	ToolDefinition,
	ToolSource,
} from "./types.ts";

type ExtensionToolDefinition = ToolDefinition;

interface ExtensionHandlerRegistration<TName extends ExtensionEventName> {
	extensionId: string;
	eventName: TName;
	handler: ExtensionHandlerFor<TName>;
}

export interface ActivateExtensionScopeOptions {
	agentId: string;
	profileId: string;
	extensionIds?: readonly string[];
	missingExtensionSeverity?: "ignore" | "warning" | "error";
	actions: ExtensionActions;
}

export interface ExtensionToolContribution {
	extensionId: string;
	definition: ExtensionToolDefinition;
	source: ToolSource;
}

export class ExtensionScope {
	readonly agentId: string;
	readonly profileId: string;
	readonly extensionIds: readonly string[];
	readonly diagnostics: readonly CoreDiagnostic[];
	readonly toolContributions: readonly ExtensionToolContribution[];

	private readonly _actions: ExtensionActions;
	private readonly _handlers: ReadonlyMap<
		ExtensionEventName,
		readonly ExtensionHandlerRegistration<ExtensionEventName>[]
	>;

	constructor(options: {
		agentId: string;
		profileId: string;
		extensionIds: readonly string[];
		actions: ExtensionActions;
		diagnostics: readonly CoreDiagnostic[];
		toolContributions: readonly ExtensionToolContribution[];
		handlers: ReadonlyMap<
			ExtensionEventName,
			readonly ExtensionHandlerRegistration<ExtensionEventName>[]
		>;
	}) {
		this.agentId = options.agentId;
		this.profileId = options.profileId;
		this.extensionIds = [...options.extensionIds];
		this._actions = options.actions;
		this.diagnostics = [...options.diagnostics];
		this.toolContributions = [...options.toolContributions];
		this._handlers = new Map(
			[...options.handlers].map(([eventName, handlers]) => [
				eventName,
				[...handlers],
			]),
		);
	}

	defineToolsTo(registry: ToolRegistry): void {
		for (const contribution of this.toolContributions) {
			registry.defineTool(contribution.definition, contribution.source);
		}
	}

	async emit(event: ExtensionEvent): Promise<CoreDiagnostic[]> {
		const diagnostics: CoreDiagnostic[] = [];
		const handlers = this._handlers.get(event.type) ?? [];
		for (const registration of handlers) {
			try {
				await (registration.handler as ExtensionHandler)(event, {
					extensionId: registration.extensionId,
					agentId: this.agentId,
					profileId: this.profileId,
					actions: this._actions,
				});
			} catch (error) {
				diagnostics.push(
					createExtensionDiagnostic({
						code: "extension.handler_failed",
						severity: "warning",
						message: `Extension '${registration.extensionId}' handler '${registration.eventName}' failed: ${formatError(error)}`,
						extensionId: registration.extensionId,
						agentId: this.agentId,
						profileId: this.profileId,
						phase: "runtime",
						details: {
							eventName: registration.eventName,
						},
					}),
				);
			}
		}
		return diagnostics;
	}
}

export class ExtensionRunner {
	private readonly _factories = new Map<string, ExtensionFactory>();

	registerExtensionFactory(
		extensionId: string,
		factory: ExtensionFactory,
	): () => void {
		const normalizedId = extensionId.trim();
		if (!normalizedId) {
			throw new Error("Extension id must not be empty.");
		}
		this._factories.set(normalizedId, factory);
		return () => {
			if (this._factories.get(normalizedId) === factory) {
				this._factories.delete(normalizedId);
			}
		};
	}

	async activateForAgent(
		options: ActivateExtensionScopeOptions,
	): Promise<ExtensionScope> {
		const diagnostics: CoreDiagnostic[] = [];
		const toolContributions: ExtensionToolContribution[] = [];
		const handlers = new Map<
			ExtensionEventName,
			ExtensionHandlerRegistration<ExtensionEventName>[]
		>();
		const extensionIds = normalizeExtensionIds(options.extensionIds ?? []);

		for (const extensionId of extensionIds) {
			const factory = this._factories.get(extensionId);
			if (!factory) {
				const diagnostic = createMissingFactoryDiagnostic({
					extensionId,
					agentId: options.agentId,
					profileId: options.profileId,
					severity: options.missingExtensionSeverity ?? "warning",
				});
				if (diagnostic) diagnostics.push(diagnostic);
				continue;
			}

			try {
				await factory(
					createActivationApi({
						extensionId,
						agentId: options.agentId,
						profileId: options.profileId,
						toolContributions,
						handlers,
					}),
				);
			} catch (error) {
				diagnostics.push(
					createExtensionDiagnostic({
						code: "extension.activation_failed",
						severity: "error",
						message: `Extension '${extensionId}' activation failed: ${formatError(error)}`,
						extensionId,
						agentId: options.agentId,
						profileId: options.profileId,
					}),
				);
			}
		}

		return new ExtensionScope({
			agentId: options.agentId,
			profileId: options.profileId,
			extensionIds,
			actions: options.actions,
			diagnostics,
			toolContributions,
			handlers,
		});
	}
}

function createActivationApi(options: {
	extensionId: string;
	agentId: string;
	profileId: string;
	toolContributions: ExtensionToolContribution[];
	handlers: Map<
		ExtensionEventName,
		ExtensionHandlerRegistration<ExtensionEventName>[]
	>;
}): ExtensionActivationApi {
	return {
		extensionId: options.extensionId,
		agentId: options.agentId,
		profileId: options.profileId,
		registerTool: (tool) => {
			options.toolContributions.push({
				extensionId: options.extensionId,
				definition: tool as ExtensionToolDefinition,
				source: { kind: "extension", id: options.extensionId },
			});
		},
		on: (eventName, handler) => {
			const registrations = options.handlers.get(eventName) ?? [];
			registrations.push({
				extensionId: options.extensionId,
				eventName,
				handler: handler as ExtensionHandlerFor<ExtensionEventName>,
			});
			options.handlers.set(eventName, registrations);
		},
	};
}

function normalizeExtensionIds(extensionIds: readonly string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const rawId of extensionIds) {
		const extensionId = rawId.trim();
		if (!extensionId || seen.has(extensionId)) continue;
		seen.add(extensionId);
		normalized.push(extensionId);
	}
	return normalized;
}

function createMissingFactoryDiagnostic(options: {
	extensionId: string;
	agentId: string;
	profileId: string;
	severity: "ignore" | "warning" | "error";
}): CoreDiagnostic | undefined {
	if (options.severity === "ignore") return undefined;
	return createExtensionDiagnostic({
		code: "extension.factory_missing",
		severity: options.severity,
		message: `Extension '${options.extensionId}' is requested by profile '${options.profileId}' but no factory is registered.`,
		extensionId: options.extensionId,
		agentId: options.agentId,
		profileId: options.profileId,
	});
}

function createExtensionDiagnostic(options: {
	code: string;
	severity: DiagnosticSeverity;
	message: string;
	extensionId: string;
	agentId: string;
	profileId: string;
	phase?: CoreDiagnostic["phase"];
	details?: Record<string, unknown>;
}): CoreDiagnostic {
	return createDiagnostic({
		domain: "extension",
		code: options.code,
		severity: options.severity,
		disposition: options.severity === "error" ? "degraded" : "reported",
		recoverable: true,
		message: options.message,
		source: { kind: "extension", id: options.extensionId },
		phase: options.phase ?? "resolve",
		agentId: options.agentId,
		profileId: options.profileId,
		extensionId: options.extensionId,
		details: options.details,
	});
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
