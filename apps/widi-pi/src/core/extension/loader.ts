import {
	type CoreDiagnostic,
	createDiagnostic,
	type DiagnosticSeverity,
} from "../diagnostics.ts";
import type {
	ExtensionActivationApi,
	ExtensionEventName,
	ExtensionFactory,
	ExtensionHandlerFor,
	ToolDefinition,
	ToolSource,
} from "./types.ts";

type ExtensionToolDefinition = ToolDefinition;

export interface ExtensionHandlerRegistration<
	TName extends ExtensionEventName,
> {
	extensionId: string;
	eventName: TName;
	handler: ExtensionHandlerFor<TName>;
}

export interface LoadExtensionScopeOptions {
	agentId: string;
	profileId: string;
	extensionIds?: readonly string[];
	missingExtensionSeverity?: "ignore" | "warning" | "error";
}

export interface ExtensionToolContribution {
	extensionId: string;
	definition: ExtensionToolDefinition;
	source: ToolSource;
}

export interface LoadedExtensionScope {
	agentId: string;
	profileId: string;
	extensionIds: readonly string[];
	diagnostics: readonly CoreDiagnostic[];
	toolContributions: readonly ExtensionToolContribution[];
	handlers: ReadonlyMap<
		ExtensionEventName,
		readonly ExtensionHandlerRegistration<ExtensionEventName>[]
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

		return {
			agentId: options.agentId,
			profileId: options.profileId,
			extensionIds,
			diagnostics,
			toolContributions,
			handlers,
		};
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
