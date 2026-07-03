import type {
	BeforeAgentStartResult,
	ContextResult,
	ToolCallResult,
	ToolResultPatch,
} from "@earendil-works/pi-agent-core";
import { type CoreDiagnostic, createDiagnostic } from "../diagnostics.ts";
import type { CommandInputInvoke } from "../orchestrator/commands.ts";
import type { ToolRegistry } from "../tool-registry.ts";
import type {
	ExtensionCommandContribution,
	ExtensionIdentity,
	ExtensionInterceptorRegistration,
	ExtensionToolContribution,
	LoadedExtensionScope,
} from "./loader.ts";
import type {
	ExtensionActionFailure,
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
	ExtensionObserver,
	ExtensionSessionContext,
} from "./types.ts";

export interface ExtensionRunnerOptions {
	loadedScope: LoadedExtensionScope;
}

export interface ExtensionInterceptorRun<
	TName extends ExtensionInterceptorName,
> {
	result: ExtensionInterceptorResultFor<TName>;
	diagnostics: readonly CoreDiagnostic[];
}

export type ExtensionHookSnapshot =
	| {
			kind: "observe";
			extensionId: string;
			eventName: ExtensionObservedEvent["type"];
	  }
	| {
			kind: "intercept";
			extensionId: string;
			eventName: ExtensionInterceptorName;
	  };

export type ExtensionToolContributionSnapshot =
	| {
			kind: "define";
			extensionId: string;
			toolName: string;
			source: ExtensionToolContribution["source"];
	  }
	| {
			kind: "patch";
			extensionId: string;
			targetToolName: string;
			patchedFields: readonly string[];
			source: ExtensionToolContribution["source"];
	  };

export interface ExtensionRunnerSnapshot {
	extensionIds: readonly string[];
	extensions: readonly ExtensionIdentity[];
	hooks: readonly ExtensionHookSnapshot[];
	commands: readonly ExtensionCommandSnapshot[];
	toolContributions: readonly ExtensionToolContributionSnapshot[];
	stale: {
		readonly stale: boolean;
		readonly message?: string;
	};
}

export interface ExtensionCommandSnapshot {
	readonly extensionId: string;
	readonly inputInvoke: CommandInputInvoke;
}

export interface ResolvedExtensionCommand {
	readonly extensionId: string;
	readonly inputInvoke: CommandInputInvoke;
	readonly handler: ExtensionCommandContribution["handler"];
}

const patchInspectableFields = [
	"description",
	"parameters",
	"strict",
	"execute",
	"aroundExecute",
] as const;

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
			actions: this._createContextActions(extensionId),
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

	getInputCommands(
		options: { reservedNames?: readonly string[] } = {},
	): ResolvedExtensionCommand[] {
		return resolveExtensionCommands(
			this._loadedScope.commandContributions,
			options.reservedNames ?? [],
		);
	}

	getInputCommand(
		name: string,
		options: { reservedNames?: readonly string[] } = {},
	): ResolvedExtensionCommand | undefined {
		return this.getInputCommands(options).find(
			(command) => command.inputInvoke.name === name,
		);
	}

	invalidate(
		message = "This extension context is stale after runtime replacement or reload.",
	): void {
		this._staleMessage = message;
	}

	inspect(): ExtensionRunnerSnapshot {
		const hooks: ExtensionHookSnapshot[] = [];
		for (const handlers of this._loadedScope.observerHandlers.values()) {
			for (const registration of handlers) {
				hooks.push({
					kind: "observe",
					extensionId: registration.extensionId,
					eventName: registration.eventName,
				});
			}
		}
		for (const handlers of this._loadedScope.interceptorHandlers.values()) {
			for (const registration of handlers) {
				hooks.push({
					kind: "intercept",
					extensionId: registration.extensionId,
					eventName: registration.eventName,
				});
			}
		}

		return {
			extensionIds: [...this.extensionIds],
			extensions: [...this.extensions],
			hooks,
			commands: this.getInputCommands().map((command) => ({
				extensionId: command.extensionId,
				inputInvoke: { ...command.inputInvoke },
			})),
			toolContributions: this._loadedScope.toolContributions.map(
				(contribution) => {
					if (contribution.kind === "define") {
						return {
							kind: "define",
							extensionId: contribution.extensionId,
							toolName: contribution.definition.name,
							source: contribution.source,
						};
					}
					return {
						kind: "patch",
						extensionId: contribution.extensionId,
						targetToolName: contribution.targetToolName,
						patchedFields: patchInspectableFields.filter((field) =>
							Object.hasOwn(contribution.patch, field),
						),
						source: contribution.source,
					};
				},
			),
			stale: this._staleMessage
				? { stale: true, message: this._staleMessage }
				: { stale: false },
		};
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
		return (await this.interceptWithDiagnostics(event)).result;
	}

	async interceptWithDiagnostics<TName extends ExtensionInterceptorName>(
		event: ExtensionInterceptorEventFor<TName>,
	): Promise<ExtensionInterceptorRun<TName>> {
		const handlers = this._loadedScope.interceptorHandlers.get(
			event.type as TName,
		);
		if (!handlers || handlers.length === 0) {
			return {
				result: undefined as ExtensionInterceptorResultFor<TName>,
				diagnostics: [],
			};
		}
		const diagnostics: CoreDiagnostic[] = [];
		let result: ExtensionInterceptorResultFor<TName>;
		if (event.type === "before_agent_start") {
			result = (await this._interceptBeforeAgentStart(
				event as ExtensionInterceptorEventFor<"before_agent_start">,
				handlers as ExtensionInterceptorRegistration<"before_agent_start">[],
				diagnostics,
			)) as ExtensionInterceptorResultFor<TName>;
		} else if (event.type === "context") {
			result = (await this._interceptContext(
				event as ExtensionInterceptorEventFor<"context">,
				handlers as ExtensionInterceptorRegistration<"context">[],
				diagnostics,
			)) as ExtensionInterceptorResultFor<TName>;
		} else if (event.type === "tool_call") {
			result = (await this._interceptToolCall(
				event as ExtensionInterceptorEventFor<"tool_call">,
				handlers as ExtensionInterceptorRegistration<"tool_call">[],
				diagnostics,
			)) as ExtensionInterceptorResultFor<TName>;
		} else {
			result = (await this._interceptToolResult(
				event as ExtensionInterceptorEventFor<"tool_result">,
				handlers as ExtensionInterceptorRegistration<"tool_result">[],
				diagnostics,
			)) as ExtensionInterceptorResultFor<TName>;
		}
		return { result, diagnostics };
	}

	private async _interceptBeforeAgentStart(
		event: ExtensionInterceptorEventFor<"before_agent_start">,
		registrations: ExtensionInterceptorRegistration<"before_agent_start">[],
		diagnostics: CoreDiagnostic[],
	): Promise<BeforeAgentStartResult | undefined> {
		const result: BeforeAgentStartResult = {};
		let hasResult = false;
		for (const registration of registrations) {
			const nextResult = await this._runInterceptor(
				registration,
				event,
				diagnostics,
			);
			if (diagnostics.length > 0) return undefined;
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
		diagnostics: CoreDiagnostic[],
	): Promise<ContextResult | undefined> {
		let messages = [...event.messages];
		let hasResult = false;
		for (const registration of registrations) {
			const nextResult = await this._runInterceptor(
				registration,
				{
					...event,
					messages,
				},
				diagnostics,
			);
			if (diagnostics.length > 0) return undefined;
			if (nextResult === undefined) continue;
			hasResult = true;
			messages = nextResult.messages;
		}
		return hasResult ? { messages } : undefined;
	}

	private async _interceptToolCall(
		event: ExtensionInterceptorEventFor<"tool_call">,
		registrations: ExtensionInterceptorRegistration<"tool_call">[],
		diagnostics: CoreDiagnostic[],
	): Promise<ToolCallResult | undefined> {
		for (const registration of registrations) {
			const result = await this._runInterceptor(
				registration,
				event,
				diagnostics,
			);
			if (diagnostics.length > 0) return undefined;
			if (result?.block) {
				return { block: true, reason: result.reason };
			}
		}
		return undefined;
	}

	private async _interceptToolResult(
		event: ExtensionInterceptorEventFor<"tool_result">,
		registrations: ExtensionInterceptorRegistration<"tool_result">[],
		diagnostics: CoreDiagnostic[],
	): Promise<ToolResultPatch | undefined> {
		const patch: ToolResultPatch = {};
		let hasPatch = false;
		let nextEvent = event;
		for (const registration of registrations) {
			const result = await this._runInterceptor(
				registration,
				nextEvent,
				diagnostics,
			);
			if (diagnostics.length > 0) return undefined;
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
		diagnostics: CoreDiagnostic[],
	): Promise<ExtensionInterceptorResultFor<TName>> {
		try {
			return await (registration.handler as ExtensionInterceptorFor<TName>)(
				event,
				this.createContext(registration.extensionId),
			);
		} catch (error) {
			diagnostics.push(this._createHandlerDiagnostic(registration, error));
			return undefined as ExtensionInterceptorResultFor<TName>;
		}
	}

	private _assertActive(): void {
		if (this._staleMessage) {
			throw new Error(this._staleMessage);
		}
	}

	private _createContextActions(extensionId: string): ExtensionActions {
		return {
			getAgentTools: (agentId) => {
				this._assertActive();
				return this._actions.getAgentTools(agentId);
			},
			setAgentTools: async (agentId, toolNames, activeToolNames) => {
				this._assertActive();
				try {
					await this._actions.setAgentTools(
						agentId,
						toolNames,
						activeToolNames,
					);
				} catch (error) {
					await this._reportActionFailure({
						extensionId,
						action: "setAgentTools",
						code: "extension.action_failed",
						error,
					});
					throw error;
				}
			},
			setAgentActiveTools: async (agentId, toolNames) => {
				this._assertActive();
				try {
					await this._actions.setAgentActiveTools(agentId, toolNames);
				} catch (error) {
					await this._reportActionFailure({
						extensionId,
						action: "setAgentActiveTools",
						code: "extension.action_failed",
						error,
					});
					throw error;
				}
			},
			requestHuman: async (request) => {
				this._assertActive();
				try {
					return await this._actions.requestHuman(request);
				} catch (error) {
					await this._reportActionFailure({
						extensionId,
						action: "requestHuman",
						code: "extension.action_failed",
						error,
					});
					throw error;
				}
			},
			dispatch: async (command) => {
				this._assertActive();
				try {
					return await this._actions.dispatch(command);
				} catch (error) {
					await this._reportActionFailure({
						extensionId,
						action: "dispatch",
						code: "extension.action_failed",
						error,
					});
					throw error;
				}
			},
		};
	}

	private _createSessionContext(extensionId: string): ExtensionSessionContext {
		return {
			appendEntry: async (type, data) => {
				this._assertActive();
				try {
					return await this._requireSessionActions().appendEntry(
						extensionId,
						type,
						data,
					);
				} catch (error) {
					await this._reportActionFailure({
						extensionId,
						action: "appendEntry",
						code: "extension.custom_entry_append_failed",
						error,
					});
					throw error;
				}
			},
			findEntries: async (type) => {
				this._assertActive();
				try {
					return await this._requireSessionActions().findEntries(
						extensionId,
						type,
					);
				} catch (error) {
					await this._reportActionFailure({
						extensionId,
						action: "findEntries",
						code: "extension.custom_entry_find_failed",
						error,
					});
					throw error;
				}
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

	private async _reportActionFailure(
		failure: ExtensionActionFailure,
	): Promise<void> {
		await this._contextActions.reportActionFailure?.(failure);
	}

	private _createHandlerDiagnostic(
		registration: {
			readonly extensionId: string;
			readonly eventName: string;
		},
		error: unknown,
	): CoreDiagnostic {
		return createDiagnostic({
			domain: "extension",
			code: "extension.handler_failed",
			severity: "warning",
			disposition: "degraded",
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

function resolveExtensionCommands(
	contributions: readonly ExtensionCommandContribution[],
	reservedNames: readonly string[],
): ResolvedExtensionCommand[] {
	const takenNames = new Set(reservedNames);
	const counts = new Map<string, number>();
	for (const contribution of contributions) {
		const name = contribution.inputInvoke.name;
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}

	const seen = new Map<string, number>();
	return contributions.map((contribution) => {
		const name = contribution.inputInvoke.name;
		const occurrence = (seen.get(name) ?? 0) + 1;
		seen.set(name, occurrence);
		let invocationName =
			(counts.get(name) ?? 0) > 1 ? `${name}:${occurrence}` : name;
		while (takenNames.has(invocationName)) {
			const suffix = (seen.get(name) ?? occurrence) + 1;
			seen.set(name, suffix);
			invocationName = `${name}:${suffix}`;
		}
		takenNames.add(invocationName);
		return {
			extensionId: contribution.extensionId,
			inputInvoke: {
				...contribution.inputInvoke,
				name: invocationName,
			},
			handler: contribution.handler,
		};
	});
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
