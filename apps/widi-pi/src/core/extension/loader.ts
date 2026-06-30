import {
	type CoreDiagnostic,
	createDiagnostic,
	type DiagnosticSeverity,
} from "../diagnostics.ts";
import type {
	ExtensionActivationApi,
	ExtensionFactory,
	ExtensionInterceptorFor,
	ExtensionInterceptorName,
	ExtensionObservedEventName,
	ExtensionObserverFor,
	ToolDefinition,
	ToolDefinitionPatch,
	ToolSource,
} from "./types.ts";

type ExtensionToolDefinition = ToolDefinition;
type ExtensionToolDefinitionPatch = ToolDefinitionPatch;

export interface ExtensionObserverRegistration<
	TName extends ExtensionObservedEventName,
> {
	extensionId: string;
	eventName: TName;
	handler: ExtensionObserverFor<TName>;
}

export interface ExtensionInterceptorRegistration<
	TName extends ExtensionInterceptorName,
> {
	extensionId: string;
	eventName: TName;
	handler: ExtensionInterceptorFor<TName>;
}

export interface LoadExtensionScopeOptions {
	agentId: string;
	profileId: string;
	extensionIds?: readonly string[];
	missingExtensionSeverity?: "ignore" | "warning" | "error";
}

export type ExtensionToolContribution =
	| {
			kind: "define";
			extensionId: string;
			definition: ExtensionToolDefinition;
			source: ToolSource;
	  }
	| {
			kind: "patch";
			extensionId: string;
			targetToolName: string;
			patch: ExtensionToolDefinitionPatch;
			source: ToolSource;
	  };

export interface LoadedExtensionScope {
	agentId: string;
	profileId: string;
	extensionIds: readonly string[];
	diagnostics: readonly CoreDiagnostic[];
	toolContributions: readonly ExtensionToolContribution[];
	observerHandlers: ReadonlyMap<
		ExtensionObservedEventName,
		readonly ExtensionObserverRegistration<ExtensionObservedEventName>[]
	>;
	interceptorHandlers: ReadonlyMap<
		ExtensionInterceptorName,
		readonly ExtensionInterceptorRegistration<ExtensionInterceptorName>[]
	>;
}

export class ExtensionLoader {
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

	async loadForAgent(
		options: LoadExtensionScopeOptions,
	): Promise<LoadedExtensionScope> {
		const diagnostics: CoreDiagnostic[] = [];
		const toolContributions: ExtensionToolContribution[] = [];
		const observerHandlers = new Map<
			ExtensionObservedEventName,
			ExtensionObserverRegistration<ExtensionObservedEventName>[]
		>();
		const interceptorHandlers = new Map<
			ExtensionInterceptorName,
			ExtensionInterceptorRegistration<ExtensionInterceptorName>[]
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
						observerHandlers,
						interceptorHandlers,
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

		return {
			agentId: options.agentId,
			profileId: options.profileId,
			extensionIds,
			diagnostics,
			toolContributions,
			observerHandlers,
			interceptorHandlers,
		};
	}
}

function createActivationApi(options: {
	extensionId: string;
	agentId: string;
	profileId: string;
	toolContributions: ExtensionToolContribution[];
	observerHandlers: Map<
		ExtensionObservedEventName,
		ExtensionObserverRegistration<ExtensionObservedEventName>[]
	>;
	interceptorHandlers: Map<
		ExtensionInterceptorName,
		ExtensionInterceptorRegistration<ExtensionInterceptorName>[]
	>;
}): ExtensionActivationApi {
	return {
		extensionId: options.extensionId,
		agentId: options.agentId,
		profileId: options.profileId,
		registerTool: (tool) => {
			options.toolContributions.push({
				kind: "define",
				extensionId: options.extensionId,
				definition: tool as ExtensionToolDefinition,
				source: { kind: "extension", id: options.extensionId },
			});
		},
		patchTool: (targetToolName, patch) => {
			options.toolContributions.push({
				kind: "patch",
				extensionId: options.extensionId,
				targetToolName,
				patch: patch as ExtensionToolDefinitionPatch,
				source: { kind: "extension", id: options.extensionId },
			});
		},
		observe: (eventName, handler) => {
			const registrations = options.observerHandlers.get(eventName) ?? [];
			registrations.push({
				extensionId: options.extensionId,
				eventName,
				handler: handler as ExtensionObserverFor<ExtensionObservedEventName>,
			});
			options.observerHandlers.set(eventName, registrations);
		},
		intercept: (eventName, handler) => {
			const registrations = options.interceptorHandlers.get(eventName) ?? [];
			registrations.push({
				extensionId: options.extensionId,
				eventName,
				handler:
					handler as unknown as ExtensionInterceptorFor<ExtensionInterceptorName>,
			});
			options.interceptorHandlers.set(eventName, registrations);
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
		phase: "resolve",
		agentId: options.agentId,
		profileId: options.profileId,
		extensionId: options.extensionId,
		details: options.details,
	});
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
