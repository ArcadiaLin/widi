import type {
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	BeforeAgentStartResult,
	BeforeProviderRequestResult,
	ContextResult,
	ToolCallResult,
	ToolResultPatch,
} from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { type Command, type CommandArguments, commandKey } from "../command.ts";
import { type CoreDiagnostic, createDiagnostic } from "../diagnostics.ts";
import type { ToolRegistry } from "../tool-registry.ts";
import type {
	ExtensionCommandContribution,
	ExtensionIdentity,
	ExtensionInterceptorRegistration,
	ExtensionProviderContribution,
	ExtensionResourceContribution,
	ExtensionToolContribution,
	LoadedExtensionScope,
} from "./loader.ts";
import type {
	ExtensionActionFailure,
	ExtensionActions,
	ExtensionCommandArguments,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionCommandHandler,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionCoreActions,
	ExtensionInlineCommandExpand,
	ExtensionInputEvent,
	ExtensionInputResult,
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

// Input runs carry extension attribution so the orchestrator can publish
// input_transformed/input_blocked facts without re-deriving blame.
export type ExtensionInputInterceptRun = {
	diagnostics: readonly CoreDiagnostic[];
} & (
	| { kind: "pass" }
	| {
			kind: "transform";
			text: string;
			images?: readonly ImageContent[];
			// Extensions that returned a rewrite, in application order.
			transformedBy: readonly string[];
	  }
	| {
			kind: "block";
			reason?: string;
			// The extension whose handler ended the pipeline - a deliberate
			// block, or a crash blocked fail-closed.
			blockedBy: string;
	  }
);

type ExtensionInterceptorHandlerRun<TName extends ExtensionInterceptorName> =
	| {
			ok: true;
			result: ExtensionInterceptorResultFor<TName>;
	  }
	| {
			ok: false;
			diagnostic: CoreDiagnostic;
	  };

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

// Provider contribution facts stay secret-free: model ids and an OAuth flag
// only - never the config value references (a literal apiKey is a secret).
export interface ExtensionProviderContributionSnapshot {
	readonly extensionId: string;
	readonly providerName: string;
	readonly modelIds: readonly string[];
	readonly oauth: boolean;
}

export interface ExtensionRunnerSnapshot {
	extensionIds: readonly string[];
	extensions: readonly ExtensionIdentity[];
	hooks: readonly ExtensionHookSnapshot[];
	commands: readonly ExtensionCommandSnapshot[];
	toolContributions: readonly ExtensionToolContributionSnapshot[];
	resourceContributions: readonly ExtensionResourceContribution[];
	providerContributions: readonly ExtensionProviderContributionSnapshot[];
	stale: {
		readonly stale: boolean;
		readonly message?: string;
	};
}

export interface ExtensionCommandSnapshot {
	readonly extensionId: string;
	readonly command: Command;
}

export interface ResolvedExtensionLineCommand {
	readonly kind: "line";
	readonly extensionId: string;
	readonly command: Command;
	readonly handler: ExtensionCommandHandler;
}

export interface ResolvedExtensionInlineCommand {
	readonly kind: "inline";
	readonly extensionId: string;
	readonly command: Command;
	readonly expand: ExtensionInlineCommandExpand;
}

export type ResolvedExtensionCommand =
	| ResolvedExtensionLineCommand
	| ResolvedExtensionInlineCommand;

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
	private _actions: ExtensionCoreActions = createUnboundActions();
	private _contextActions: ExtensionContextActions = {};
	private _commandContextActions: ExtensionCommandContextActions =
		createUnboundCommandContextActions();
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
		actions: ExtensionCoreActions,
		contextActions: ExtensionContextActions,
	): void {
		this._actions = actions;
		this._contextActions = contextActions;
	}

	bindCommandContext(actions?: ExtensionCommandContextActions): void {
		this._commandContextActions =
			actions ?? createUnboundCommandContextActions();
	}

	createContext(extensionId = this.extensionIds[0]): ExtensionContext {
		if (!extensionId) {
			throw new Error(
				"Extension context requires an extension id; this runner has no loaded extensions.",
			);
		}
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
		extensionId = this.extensionIds[0],
		options: { commandId?: string } = {},
	): ExtensionCommandContext {
		const failure = (
			action: ExtensionActionFailure["action"],
		): Omit<ExtensionActionFailure, "error"> => ({
			extensionId,
			action,
			code: "extension.action_failed",
		});
		return {
			...this.createContext(extensionId),
			// Command contexts carry the executing command's id so presentation
			// actions correlate with the command_* events of the same execution.
			actions: this._createContextActions(extensionId, options.commandId),
			waitForIdle: async () => {
				this._assertActive();
				await this._commandContextActions.waitForIdle();
			},
			newSession: async () =>
				await this._runReportedAction(
					failure("newSession"),
					async () => await this._commandContextActions.newSession(extensionId),
				),
			forkSession: async (options) =>
				await this._runReportedAction(
					failure("forkSession"),
					async () =>
						await this._commandContextActions.forkSession(extensionId, options),
				),
			navigateTree: async (targetId, options) =>
				await this._runReportedAction(
					failure("navigateTree"),
					async () =>
						await this._commandContextActions.navigateTree(
							extensionId,
							targetId,
							options,
						),
				),
			listSessions: async () =>
				await this._runReportedAction(
					failure("listSessions"),
					async () =>
						await this._commandContextActions.listSessions(extensionId),
				),
			resumeSession: async (reference) =>
				await this._runReportedAction(
					failure("resumeSession"),
					async () =>
						await this._commandContextActions.resumeSession(
							extensionId,
							reference,
						),
				),
		};
	}

	getCommands(
		options: { reservedCommands?: readonly Command[] } = {},
	): ResolvedExtensionCommand[] {
		return resolveExtensionCommands(
			this._loadedScope.commandContributions,
			options.reservedCommands ?? [],
		);
	}

	getCommand(
		command: Pick<Command, "placement" | "trigger" | "name">,
		options: { reservedCommands?: readonly Command[] } = {},
	): ResolvedExtensionCommand | undefined {
		return this.getCommands(options).find(
			(resolved) => commandKey(resolved.command) === commandKey(command),
		);
	}

	getResourceContributions(): readonly ExtensionResourceContribution[] {
		return this._loadedScope.resourceContributions;
	}

	getProviderContributions(): readonly ExtensionProviderContribution[] {
		return this._loadedScope.providerContributions;
	}

	invalidate(
		message = "This extension context is stale after runtime replacement or reload.",
	): void {
		this._staleMessage = message;
	}

	isStale(): boolean {
		return this._staleMessage !== undefined;
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
			commands: this.getCommands().map((command) => ({
				extensionId: command.extensionId,
				command: { ...command.command },
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
			resourceContributions: this._loadedScope.resourceContributions.map(
				(contribution) => ({
					extensionId: contribution.extensionId,
					skillPaths: [...contribution.skillPaths],
					promptTemplatePaths: [...contribution.promptTemplatePaths],
				}),
			),
			providerContributions: this._loadedScope.providerContributions.map(
				(contribution) => ({
					extensionId: contribution.extensionId,
					providerName: contribution.providerName,
					modelIds: (contribution.config.models ?? []).map((model) => model.id),
					oauth: contribution.config.oauth !== undefined,
				}),
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
		if (event.type === "input") {
			const run = await this.interceptInput(
				event as ExtensionInterceptorEventFor<"input">,
			);
			const result: ExtensionInputResult =
				run.kind === "block"
					? { block: true, reason: run.reason }
					: run.kind === "transform"
						? { text: run.text, images: run.images }
						: undefined;
			return {
				result: result as ExtensionInterceptorResultFor<TName>,
				diagnostics: run.diagnostics,
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
		} else if (event.type === "before_provider_request") {
			result = (await this._interceptBeforeProviderRequest(
				event as ExtensionInterceptorEventFor<"before_provider_request">,
				handlers as ExtensionInterceptorRegistration<"before_provider_request">[],
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
			const run = await this._runInterceptor(registration, event);
			if (!run.ok) {
				diagnostics.push(run.diagnostic);
				continue;
			}
			const nextResult = run.result;
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

	// Provider request pipeline (ME slice 9): context-style composition - each
	// handler sees the stream options as patched so far, and a failed handler
	// is skipped without touching the request (this is a shaping hook, not a
	// policy gate). The composed change is returned as a single faithful
	// base-to-final patch, including key deletes.
	private async _interceptBeforeProviderRequest(
		event: ExtensionInterceptorEventFor<"before_provider_request">,
		registrations: ExtensionInterceptorRegistration<"before_provider_request">[],
		diagnostics: CoreDiagnostic[],
	): Promise<BeforeProviderRequestResult | undefined> {
		const base = cloneStreamOptions(event.streamOptions);
		let current = base;
		let hasResult = false;
		for (const registration of registrations) {
			const run = await this._runInterceptor(registration, {
				...event,
				streamOptions: cloneStreamOptions(current),
			});
			if (!run.ok) {
				diagnostics.push(run.diagnostic);
				continue;
			}
			const nextResult = run.result;
			if (nextResult?.streamOptions === undefined) continue;
			hasResult = true;
			current = applyStreamOptionsPatch(current, nextResult.streamOptions);
		}
		if (!hasResult) return undefined;
		return { streamOptions: diffStreamOptions(event.streamOptions, current) };
	}

	private async _interceptContext(
		event: ExtensionInterceptorEventFor<"context">,
		registrations: ExtensionInterceptorRegistration<"context">[],
		diagnostics: CoreDiagnostic[],
	): Promise<ContextResult | undefined> {
		let messages = [...event.messages];
		let hasResult = false;
		for (const registration of registrations) {
			const run = await this._runInterceptor(registration, {
				...event,
				messages,
			});
			if (!run.ok) {
				diagnostics.push(run.diagnostic);
				continue;
			}
			const nextResult = run.result;
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
			const run = await this._runInterceptor(registration, event);
			if (!run.ok) {
				diagnostics.push(run.diagnostic);
				return { block: true };
			}
			const result = run.result;
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
			const run = await this._runInterceptor(registration, nextEvent);
			if (!run.ok) {
				diagnostics.push(run.diagnostic);
				continue;
			}
			const result = run.result;
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

	// Input pipeline (ME slice 6): each handler sees the text as rewritten so
	// far (like context); the first block short-circuits (like tool_call). A
	// crashed handler blocks fail-closed - an input policy must not be
	// bypassed by its own failure.
	async interceptInput(
		event: ExtensionInputEvent,
	): Promise<ExtensionInputInterceptRun> {
		const registrations = (this._loadedScope.interceptorHandlers.get("input") ??
			[]) as readonly ExtensionInterceptorRegistration<"input">[];
		const diagnostics: CoreDiagnostic[] = [];
		const transformedBy: string[] = [];
		let text = event.text;
		let images = event.images;
		for (const registration of registrations) {
			const run = await this._runInterceptor(registration, {
				type: "input",
				text,
				images,
			});
			if (!run.ok) {
				diagnostics.push(run.diagnostic);
				return {
					kind: "block",
					diagnostics,
					blockedBy: registration.extensionId,
				};
			}
			const result = run.result;
			if (result === undefined) continue;
			if ("block" in result) {
				return {
					kind: "block",
					diagnostics,
					reason: result.reason,
					blockedBy: registration.extensionId,
				};
			}
			transformedBy.push(registration.extensionId);
			text = result.text;
			images = result.images ?? images;
		}
		if (text === event.text && images === event.images) {
			return { kind: "pass", diagnostics };
		}
		return { kind: "transform", diagnostics, text, images, transformedBy };
	}

	private async _runInterceptor<TName extends ExtensionInterceptorName>(
		registration: ExtensionInterceptorRegistration<TName>,
		event: ExtensionInterceptorEventFor<TName>,
	): Promise<ExtensionInterceptorHandlerRun<TName>> {
		try {
			return {
				ok: true,
				result: await (registration.handler as ExtensionInterceptorFor<TName>)(
					event,
					this.createContext(registration.extensionId),
				),
			};
		} catch (error) {
			return {
				ok: false,
				diagnostic: this._createHandlerDiagnostic(registration, error),
			};
		}
	}

	private _assertActive(): void {
		if (this._staleMessage) {
			throw new Error(this._staleMessage);
		}
	}

	// Narrowing boundary: the scoped author-facing actions inject this
	// runner's agent id and the calling extension's id; neither ever appears
	// in an ExtensionActions signature. commandId is set only for command
	// contexts and flows into presentation actions.
	private _createContextActions(
		extensionId: string,
		commandId?: string,
	): ExtensionActions {
		const agentId = this.agentId;
		const failure = (
			action: ExtensionActionFailure["action"],
		): Omit<ExtensionActionFailure, "error"> => ({
			extensionId,
			action,
			code: "extension.action_failed",
		});
		return {
			getTools: () => {
				this._assertActive();
				return this._actions.getAgentTools(agentId);
			},
			setTools: async (toolNames, activeToolNames) => {
				await this._runReportedAction(failure("setTools"), async () => {
					await this._actions.setAgentTools(
						agentId,
						toolNames,
						activeToolNames,
					);
				});
			},
			setActiveTools: async (toolNames) => {
				await this._runReportedAction(failure("setActiveTools"), async () => {
					await this._actions.setAgentActiveTools(agentId, toolNames);
				});
			},
			requestHuman: async (request) =>
				await this._runReportedAction(
					failure("requestHuman"),
					async () =>
						await this._actions.requestHuman(agentId, extensionId, request),
				),
			emitOutput: async (text) => {
				await this._runReportedAction(failure("emitOutput"), async () => {
					await this._actions.emitOutput(agentId, extensionId, text, commandId);
				});
			},
			prompt: async (text, options) => {
				await this._runReportedAction(failure("prompt"), async () => {
					await this._actions.promptAgent(agentId, text, options);
				});
			},
			steer: async (text, options) => {
				await this._runReportedAction(failure("steer"), async () => {
					await this._actions.steerAgent(agentId, text, options);
				});
			},
			followUp: async (text, options) => {
				await this._runReportedAction(failure("followUp"), async () => {
					await this._actions.followUpAgent(agentId, text, options);
				});
			},
			setSessionName: async (name) => {
				await this._runReportedAction(failure("setSessionName"), async () => {
					await this._actions.setAgentSessionName(agentId, name);
				});
			},
			getSessionName: async () =>
				await this._runReportedAction(
					failure("getSessionName"),
					async () => await this._actions.getAgentSessionName(agentId),
				),
			compact: async (customInstructions) =>
				await this._runReportedAction(
					failure("compact"),
					async () =>
						await this._actions.compactAgent(agentId, customInstructions),
				),
			getCommands: () => {
				this._assertActive();
				return this._actions.listCommands(agentId);
			},
			setModel: async (reference) =>
				await this._runReportedAction(
					failure("setModel"),
					async () =>
						await this._actions.setAgentModelByReference(agentId, reference),
				),
			getModel: () => {
				this._assertActive();
				return this._actions.getAgentModel(agentId);
			},
			listModelCandidates: async () =>
				await this._runReportedAction(
					failure("listModelCandidates"),
					async () => await this._actions.listModelCandidates(),
				),
			getThinkingLevel: () => {
				this._assertActive();
				return this._actions.getAgentThinkingLevel(agentId);
			},
			setThinkingLevel: async (level) => {
				await this._runReportedAction(failure("setThinkingLevel"), async () => {
					await this._actions.setAgentThinkingLevel(agentId, level);
				});
			},
			abort: async () => {
				await this._runReportedAction(failure("abort"), async () => {
					await this._actions.abortAgent(agentId);
				});
			},
			exec: async (command, options) =>
				await this._runReportedAction(
					failure("exec"),
					async () =>
						await this._actions.exec(agentId, extensionId, command, options),
				),
		};
	}

	private async _runReportedAction<T>(
		failure: Omit<ExtensionActionFailure, "error">,
		run: () => Promise<T>,
	): Promise<T> {
		this._assertActive();
		try {
			return await run();
		} catch (error) {
			await this._reportActionFailure({ ...failure, error });
			throw error;
		}
	}

	private _createSessionContext(extensionId: string): ExtensionSessionContext {
		return {
			appendEntry: async (type, data) =>
				await this._runReportedAction(
					{
						extensionId,
						action: "appendEntry",
						code: "extension.custom_entry_append_failed",
					},
					async () =>
						await this._requireSessionActions().appendEntry(
							extensionId,
							type,
							data,
						),
				),
			findEntries: async (type) =>
				await this._runReportedAction(
					{
						extensionId,
						action: "findEntries",
						code: "extension.custom_entry_find_failed",
					},
					async () =>
						await this._requireSessionActions().findEntries(extensionId, type),
				),
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

function cloneStreamOptions(
	streamOptions: AgentHarnessStreamOptions,
): AgentHarnessStreamOptions {
	return {
		...streamOptions,
		headers: streamOptions.headers ? { ...streamOptions.headers } : undefined,
		metadata: streamOptions.metadata
			? { ...streamOptions.metadata }
			: undefined,
	};
}

// Mirrors the Pi harness patch semantics (module-private upstream): scalar
// keys apply when present, header/metadata patches merge key-wise with
// `undefined` deleting a key and an explicit `undefined` map clearing all.
function applyStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	patch: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
	const result = cloneStreamOptions(base);

	if (Object.hasOwn(patch, "transport")) result.transport = patch.transport;
	if (Object.hasOwn(patch, "timeoutMs")) result.timeoutMs = patch.timeoutMs;
	if (Object.hasOwn(patch, "maxRetries")) result.maxRetries = patch.maxRetries;
	if (Object.hasOwn(patch, "maxRetryDelayMs")) {
		result.maxRetryDelayMs = patch.maxRetryDelayMs;
	}
	if (Object.hasOwn(patch, "cacheRetention")) {
		result.cacheRetention = patch.cacheRetention;
	}

	if (Object.hasOwn(patch, "headers")) {
		if (patch.headers === undefined) {
			result.headers = undefined;
		} else {
			const headers = { ...(result.headers ?? {}) };
			for (const [key, value] of Object.entries(patch.headers)) {
				if (value === undefined) delete headers[key];
				else headers[key] = value;
			}
			result.headers = Object.keys(headers).length > 0 ? headers : undefined;
		}
	}

	if (Object.hasOwn(patch, "metadata")) {
		if (patch.metadata === undefined) {
			result.metadata = undefined;
		} else {
			const metadata = { ...(result.metadata ?? {}) };
			for (const [key, value] of Object.entries(patch.metadata)) {
				if (value === undefined) delete metadata[key];
				else metadata[key] = value;
			}
			result.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
		}
	}

	return result;
}

// Encode base-to-final as one patch. Key-wise deletes keep the encoding
// faithful for composed handler chains that removed headers or metadata.
function diffStreamOptions(
	base: AgentHarnessStreamOptions,
	final: AgentHarnessStreamOptions,
): AgentHarnessStreamOptionsPatch {
	const patch: AgentHarnessStreamOptionsPatch = {};
	if (base.transport !== final.transport) patch.transport = final.transport;
	if (base.timeoutMs !== final.timeoutMs) patch.timeoutMs = final.timeoutMs;
	if (base.maxRetries !== final.maxRetries) {
		patch.maxRetries = final.maxRetries;
	}
	if (base.maxRetryDelayMs !== final.maxRetryDelayMs) {
		patch.maxRetryDelayMs = final.maxRetryDelayMs;
	}
	if (base.cacheRetention !== final.cacheRetention) {
		patch.cacheRetention = final.cacheRetention;
	}

	const headerPatch = diffRecord(base.headers, final.headers);
	if (headerPatch) patch.headers = headerPatch;
	const metadataPatch = diffRecord(base.metadata, final.metadata);
	if (metadataPatch) patch.metadata = metadataPatch;
	return patch;
}

function diffRecord<T>(
	base: Record<string, T> | undefined,
	final: Record<string, T> | undefined,
): Record<string, T | undefined> | undefined {
	const patch: Record<string, T | undefined> = {};
	for (const key of Object.keys(base ?? {})) {
		if (!Object.hasOwn(final ?? {}, key)) patch[key] = undefined;
	}
	for (const [key, value] of Object.entries(final ?? {})) {
		if (base?.[key] !== value) patch[key] = value;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}

function resolveExtensionCommands(
	contributions: readonly ExtensionCommandContribution[],
	reservedCommands: readonly Command[],
): ResolvedExtensionCommand[] {
	const takenCommandKeys = new Set(reservedCommands.map(commandKey));
	const counts = new Map<string, number>();
	for (const contribution of contributions) {
		const key = commandKey(contribution);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	const seen = new Map<string, number>();
	return contributions.map((contribution) => {
		const contributionKey = commandKey(contribution);
		const occurrence = (seen.get(contributionKey) ?? 0) + 1;
		// Duplicated names start suffixed by occurrence; a unique name starts
		// plain and falls back to `${name}-1`, `${name}-2`, ... when it
		// collides with a reserved command.
		let suffix = (counts.get(contributionKey) ?? 0) > 1 ? occurrence : 0;
		let invocationName =
			suffix > 0 ? `${contribution.name}-${suffix}` : contribution.name;
		let candidateKey = commandKey({
			placement: contribution.placement,
			trigger: contribution.trigger,
			name: invocationName,
		});
		while (takenCommandKeys.has(candidateKey)) {
			suffix += 1;
			invocationName = `${contribution.name}-${suffix}`;
			candidateKey = commandKey({
				placement: contribution.placement,
				trigger: contribution.trigger,
				name: invocationName,
			});
		}
		seen.set(contributionKey, Math.max(occurrence, suffix));
		takenCommandKeys.add(candidateKey);
		const source = {
			kind: "extension",
			extensionId: contribution.extensionId,
		} as const;
		if (contribution.placement === "inline") {
			return {
				kind: "inline",
				extensionId: contribution.extensionId,
				command: {
					name: invocationName,
					placement: "inline",
					trigger: contribution.trigger,
					closeTrigger: contribution.closeTrigger,
					description: contribution.description,
					argumentHint: contribution.argumentHint,
					arguments: toCommandArguments(contribution.arguments),
					source,
				},
				expand: contribution.expand,
			};
		}
		return {
			kind: "line",
			extensionId: contribution.extensionId,
			command: {
				name: invocationName,
				placement: "line",
				trigger: contribution.trigger,
				description: contribution.description,
				argumentHint: contribution.argumentHint,
				arguments: toCommandArguments(contribution.arguments),
				source,
			},
			handler: contribution.handler,
		};
	});
}

// Narrowing boundary: the extension completion callback receives the
// argument prefix only - never the orchestrator handle carried by the
// core CommandCompletionContext.
function toCommandArguments(
	args: ExtensionCommandArguments | undefined,
): CommandArguments | undefined {
	if (!args) return undefined;
	const getCompletion = args.getArgumentsCompletion?.bind(args);
	return {
		required: args.required,
		complete: getCompletion
			? async (context) => await getCompletion(context.argumentPrefix)
			: undefined,
	};
}

// waitForIdle stays a no-op when unbound (an idle fact without a harness is
// vacuously settled); session control must never silently no-op, so unbound
// session operations throw.
function createUnboundCommandContextActions(): ExtensionCommandContextActions {
	const notBound = () => {
		throw new Error("Extension runner command context actions are not bound.");
	};
	return {
		waitForIdle: async () => {},
		newSession: async () => notBound(),
		forkSession: async () => notBound(),
		navigateTree: async () => notBound(),
		listSessions: async () => notBound(),
		resumeSession: async () => notBound(),
	};
}

function createUnboundActions(): ExtensionCoreActions {
	const notBound = () => {
		throw new Error("Extension runner core actions are not bound.");
	};
	return {
		getAgentTools: () => notBound(),
		setAgentTools: async () => notBound(),
		setAgentActiveTools: async () => notBound(),
		requestHuman: async () => notBound(),
		emitOutput: async () => notBound(),
		promptAgent: async () => notBound(),
		steerAgent: async () => notBound(),
		followUpAgent: async () => notBound(),
		setAgentSessionName: async () => notBound(),
		getAgentSessionName: async () => notBound(),
		compactAgent: async () => notBound(),
		listCommands: () => notBound(),
		setAgentModelByReference: async () => notBound(),
		getAgentModel: () => notBound(),
		listModelCandidates: async () => notBound(),
		getAgentThinkingLevel: () => notBound(),
		setAgentThinkingLevel: async () => notBound(),
		abortAgent: async () => notBound(),
		exec: async () => notBound(),
	};
}
