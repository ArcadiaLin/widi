import { type CoreDiagnostic, createDiagnostic } from "../diagnostics.ts";
import type { ToolRegistry } from "../tool-registry.ts";
import type {
	ExtensionHandlerRegistration,
	LoadedExtensionScope,
} from "./loader.ts";
import type {
	ExtensionActions,
	ExtensionEvent,
	ExtensionEventName,
	ExtensionHandler,
} from "./types.ts";

export interface ExtensionRunnerOptions {
	loadedScope: LoadedExtensionScope;
	actions: ExtensionActions;
}

export class ExtensionRunner {
	readonly agentId: string;
	readonly profileId: string;
	readonly extensionIds: readonly string[];
	readonly diagnostics: readonly CoreDiagnostic[];

	private readonly _actions: ExtensionActions;
	private readonly _loadedScope: LoadedExtensionScope;

	constructor(options: ExtensionRunnerOptions) {
		this._loadedScope = options.loadedScope;
		this._actions = options.actions;
		this.agentId = options.loadedScope.agentId;
		this.profileId = options.loadedScope.profileId;
		this.extensionIds = [...options.loadedScope.extensionIds];
		this.diagnostics = [...options.loadedScope.diagnostics];
	}

	defineToolsTo(registry: ToolRegistry): void {
		for (const contribution of this._loadedScope.toolContributions) {
			registry.defineTool(contribution.definition, contribution.source);
		}
	}

	async emit(event: ExtensionEvent): Promise<CoreDiagnostic[]> {
		const diagnostics: CoreDiagnostic[] = [];
		const handlers = this._loadedScope.handlers.get(event.type) ?? [];
		for (const registration of handlers) {
			try {
				await (registration.handler as ExtensionHandler)(event, {
					extensionId: registration.extensionId,
					agentId: this.agentId,
					profileId: this.profileId,
					actions: this._actions,
				});
			} catch (error) {
				diagnostics.push(this._createHandlerDiagnostic(registration, error));
			}
		}
		return diagnostics;
	}

	private _createHandlerDiagnostic(
		registration: ExtensionHandlerRegistration<ExtensionEventName>,
		error: unknown,
	): CoreDiagnostic {
		return createDiagnostic({
			domain: "extension",
			code: "extension.handler_failed",
			severity: "warning",
			disposition: "reported",
			recoverable: true,
			message: `Extension '${registration.extensionId}' handler '${registration.eventName}' failed: ${formatError(error)}`,
			source: { kind: "extension", id: registration.extensionId },
			phase: "runtime",
			agentId: this.agentId,
			profileId: this.profileId,
			extensionId: registration.extensionId,
			details: {
				eventName: registration.eventName,
			},
		});
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
