import type {
	BeforeAgentStartResult,
	ContextResult,
	ToolCallResult,
	ToolResultPatch,
} from "@earendil-works/pi-agent-core";
import { type CoreDiagnostic, createDiagnostic } from "../diagnostics.ts";
import type { ToolRegistry } from "../tool-registry.ts";
import type {
	ExtensionIdentity,
	ExtensionInterceptorRegistration,
	ExtensionObserverRegistration,
	LoadedExtensionScope,
} from "./loader.ts";
import type {
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionInterceptorEventFor,
	ExtensionInterceptorFor,
	ExtensionInterceptorName,
	ExtensionInterceptorResultFor,
	ExtensionObservedEvent,
	ExtensionObservedEventName,
	ExtensionObserver,
	ExtensionSessionContext,
} from "./types.ts";

export interface ExtensionRunnerOptions {
	loadedScope: LoadedExtensionScope;
}

export class ExtensionRunner {
	readonly agentId: string;
	readonly profileId: string;
	readonly extensionIds: readonly string[];
	readonly extensions: readonly ExtensionIdentity[];
	readonly diagnostics: readonly CoreDiagnostic[];

	private readonly _loadedScope: LoadedExtensionScope;
	private _actions: ExtensionActions = createUnboundActions();
	private _contextActions: ExtensionContextActions = {};
	private _commandContextActions: ExtensionCommandContextActions = {
		waitForIdle: async () => {},
	};
	private _staleMessage: string | undefined;

	constructor(options: ExtensionRunnerOptions) {
		this._loadedScope = options.loadedScope;
		this.agentId = options.loadedScope.agentId;
		this.profileId = options.loadedScope.profileId;
		this.extensionIds = [...options.loadedScope.extensionIds];
		this.extensions = [...options.loadedScope.extensions];
		this.diagnostics = [...options.loadedScope.diagnostics];
	}

	bindCore(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
	): void {
		this._actions = actions;
		this._contextActions = contextActions;
	}

	bindCommandContext(actions?: ExtensionCommandContextActions): void {
		this._commandContextActions = actions ?? {
			waitForIdle: async () => {},
		};
	}

	createContext(extensionId = this.extensionIds[0] ?? ""): ExtensionContext {
		const runner = this;
		return {
			extensionId,
			agentId: this.agentId,
			profileId: this.profileId,
			actions: this._createContextActions(),
			session: this._createSessionContext(extensionId),
			get signal() {
				runner._assertActive();
				return runner._contextActions.getSignal?.();
			},
			isIdle: () => {
				this._assertActive();
				return this._contextActions.isIdle?.() ?? true;
			},
		};
	}

	createCommandContext(
		extensionId = this.extensionIds[0] ?? "",
	): ExtensionCommandContext {
		return {
			...this.createContext(extensionId),
			waitForIdle: async () => {
				this._assertActive();
				await this._commandContextActions.waitForIdle();
			},
		};
	}

	invalidate(
		message = "This extension context is stale after runtime replacement or reload.",
	): void {
		this._staleMessage = message;
	}

	contributeToolsTo(registry: ToolRegistry): void {
		for (const contribution of this._loadedScope.toolContributions) {
			if (contribution.kind === "define") {
				registry.defineTool(contribution.definition, contribution.source);
			} else {
				registry.patchTool(
					contribution.targetToolName,
					contribution.patch,
					contribution.source,
				);
			}
		}
	}

	async emitObserved(event: ExtensionObservedEvent): Promise<CoreDiagnostic[]> {
		const diagnostics: CoreDiagnostic[] = [];
		const handlers = this._loadedScope.observerHandlers.get(event.type) ?? [];
		for (const registration of handlers) {
			try {
				await (registration.handler as ExtensionObserver)(
					event,
					this.createContext(registration.extensionId),
				);
			} catch (error) {
				diagnostics.push(this._createHandlerDiagnostic(registration, error));
			}
		}
		return diagnostics;
	}

	async intercept<TName extends ExtensionInterceptorName>(
		event: ExtensionInterceptorEventFor<TName>,
	): Promise<ExtensionInterceptorResultFor<TName>> {
		const handlers = this._loadedScope.interceptorHandlers.get(
			event.type as TName,
		);
		if (!handlers || handlers.length === 0) {
			return undefined as ExtensionInterceptorResultFor<TName>;
		}
		if (event.type === "before_agent_start") {
			return (await this._interceptBeforeAgentStart(
				event as ExtensionInterceptorEventFor<"before_agent_start">,
				handlers as ExtensionInterceptorRegistration<"before_agent_start">[],
			)) as ExtensionInterceptorResultFor<TName>;
		}
		if (event.type === "context") {
			return (await this._interceptContext(
				event as ExtensionInterceptorEventFor<"context">,
				handlers as ExtensionInterceptorRegistration<"context">[],
			)) as ExtensionInterceptorResultFor<TName>;
		}
		if (event.type === "tool_call") {
			return (await this._interceptToolCall(
				event as ExtensionInterceptorEventFor<"tool_call">,
				handlers as ExtensionInterceptorRegistration<"tool_call">[],
			)) as ExtensionInterceptorResultFor<TName>;
		}
		return (await this._interceptToolResult(
			event as ExtensionInterceptorEventFor<"tool_result">,
			handlers as ExtensionInterceptorRegistration<"tool_result">[],
		)) as ExtensionInterceptorResultFor<TName>;
	}

	private async _interceptBeforeAgentStart(
		event: ExtensionInterceptorEventFor<"before_agent_start">,
		registrations: ExtensionInterceptorRegistration<"before_agent_start">[],
	): Promise<BeforeAgentStartResult | undefined> {
		const result: BeforeAgentStartResult = {};
		let hasResult = false;
		for (const registration of registrations) {
			const nextResult = await this._runInterceptor(registration, event);
			if (nextResult === undefined) continue;
			hasResult = true;
			if (nextResult.messages) {
				result.messages = [...(result.messages ?? []), ...nextResult.messages];
			}
			if (nextResult.systemPrompt !== undefined) {
				result.systemPrompt = nextResult.systemPrompt;
			}
		}
		return hasResult ? result : undefined;
	}

	private async _interceptContext(
		event: ExtensionInterceptorEventFor<"context">,
		registrations: ExtensionInterceptorRegistration<"context">[],
	): Promise<ContextResult | undefined> {
		let messages = [...event.messages];
		let hasResult = false;
		for (const registration of registrations) {
			const nextResult = await this._runInterceptor(registration, {
				...event,
				messages,
			});
			if (nextResult === undefined) continue;
			hasResult = true;
			messages = nextResult.messages;
		}
		return hasResult ? { messages } : undefined;
	}

	private async _interceptToolCall(
		event: ExtensionInterceptorEventFor<"tool_call">,
		registrations: ExtensionInterceptorRegistration<"tool_call">[],
	): Promise<ToolCallResult | undefined> {
		for (const registration of registrations) {
			const result = await this._runInterceptor(registration, event);
			if (result?.block) {
				return { block: true, reason: result.reason };
			}
		}
		return undefined;
	}

	private async _interceptToolResult(
		event: ExtensionInterceptorEventFor<"tool_result">,
		registrations: ExtensionInterceptorRegistration<"tool_result">[],
	): Promise<ToolResultPatch | undefined> {
		const patch: ToolResultPatch = {};
		let hasPatch = false;
		let nextEvent = event;
		for (const registration of registrations) {
			const result = await this._runInterceptor(registration, nextEvent);
			if (result === undefined) continue;
			hasPatch = true;
			if (Object.hasOwn(result, "content")) patch.content = result.content;
			if (Object.hasOwn(result, "details")) patch.details = result.details;
			if (Object.hasOwn(result, "isError")) patch.isError = result.isError;
			if (result.terminate) patch.terminate = true;
			nextEvent = {
				...nextEvent,
				content: patch.content ?? nextEvent.content,
				details: Object.hasOwn(patch, "details")
					? patch.details
					: nextEvent.details,
				isError: patch.isError ?? nextEvent.isError,
			};
		}
		return hasPatch ? patch : undefined;
	}

	private async _runInterceptor<TName extends ExtensionInterceptorName>(
		registration: ExtensionInterceptorRegistration<TName>,
		event: ExtensionInterceptorEventFor<TName>,
	): Promise<ExtensionInterceptorResultFor<TName>> {
		return await (registration.handler as ExtensionInterceptorFor<TName>)(
			event,
			this.createContext(registration.extensionId),
		);
	}

	private _assertActive(): void {
		if (this._staleMessage) {
			throw new Error(this._staleMessage);
		}
	}

	private _createContextActions(): ExtensionActions {
		return {
			getAgentTools: (agentId) => {
				this._assertActive();
				return this._actions.getAgentTools(agentId);
			},
			setAgentTools: async (agentId, toolNames, activeToolNames) => {
				this._assertActive();
				await this._actions.setAgentTools(agentId, toolNames, activeToolNames);
			},
			setAgentActiveTools: async (agentId, toolNames) => {
				this._assertActive();
				await this._actions.setAgentActiveTools(agentId, toolNames);
			},
			requestHuman: async (request) => {
				this._assertActive();
				return await this._actions.requestHuman(request);
			},
			dispatch: async (command) => {
				this._assertActive();
				return await this._actions.dispatch(command);
			},
		};
	}

	private _createSessionContext(extensionId: string): ExtensionSessionContext {
		return {
			appendEntry: async (type, data) => {
				this._assertActive();
				return await this._requireSessionActions().appendEntry(
					extensionId,
					type,
					data,
				);
			},
			findEntries: async (type) => {
				this._assertActive();
				return await this._requireSessionActions().findEntries(
					extensionId,
					type,
				);
			},
		};
	}

	private _requireSessionActions() {
		const session = this._contextActions.session;
		if (!session) {
			throw new Error("Extension runner session actions are not bound.");
		}
		return session;
	}

	private _createHandlerDiagnostic(
		registration: ExtensionObserverRegistration<ExtensionObservedEventName>,
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

function createUnboundActions(): ExtensionActions {
	const notBound = () => {
		throw new Error("Extension runner core actions are not bound.");
	};
	return {
		getAgentTools: () => notBound(),
		setAgentTools: async () => notBound(),
		setAgentActiveTools: async () => notBound(),
		requestHuman: async () => notBound(),
		dispatch: async () => notBound(),
	};
}
