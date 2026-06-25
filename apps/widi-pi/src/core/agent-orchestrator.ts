/**
 * AgentOrchestrator - Core abstraction for orchestrating multiple agents lifecycle and sessions management.
 *
 * This Class is shared between all run modes (interactive, print, rpc).
 */

import {
	AgentHarness,
	type AgentHarnessEvent,
	type AgentHarnessResources,
	type AgentTool,
	type ExecutionEnv,
	type Session,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtendedJsonlSessionMetadata } from "../storage/jsonl-repo.ts";
import type {
	AgentProfile,
	AgentProfileOverride,
	AgentProfileRegistry,
} from "./agent-profile.js";
import {
	type DiagnosticDisposition,
	type DiagnosticSource,
	dedupeDiagnostics,
	type OrchestratorDiagnostic,
	OrchestratorError,
	toCoreDiagnosticFromPromptTemplateDiagnostic,
	toCoreDiagnosticFromSkillDiagnostic,
} from "./diagnostics.ts";
import type { ModelRegistry } from "./model-registry.js";
import type { OrchestratorClient } from "./orchestrator/clients.ts";
import type {
	OperationSource,
	OrchestratorCommand,
	OrchestratorCommandResult,
	OrchestratorCommandValue,
	RuntimeModel,
} from "./orchestrator/commands.ts";
import type {
	HumanRequest,
	HumanRequestEnvelope,
	HumanResponse,
} from "./orchestrator/human-request.ts";
import type { ResourceLoader } from "./resource-loader.js";
import type {
	AgentSessionMetadata,
	SessionManager,
} from "./session-manager.ts";
import type { SettingManager } from "./setting-manager.js";
import {
	createAgentToolsFromResolvedTools,
	ToolRegistry,
} from "./tools/tool-registry.ts";

export type OrchestratorEvent =
	| {
			readonly type: "agent_harness_event";
			agentId: AgentId;
			event: AgentHarnessEvent;
	  }
	| {
			readonly type: "command_accepted";
			commandId: string;
			command: OrchestratorCommand;
			createdAt: string;
	  }
	| {
			readonly type: "command_completed";
			commandId: string;
			command: OrchestratorCommand;
			result: OrchestratorCommandValue;
			completedAt: string;
	  }
	| {
			readonly type: "command_rejected";
			commandId: string;
			command?: OrchestratorCommand;
			diagnostic: OrchestratorDiagnostic;
			completedAt: string;
	  }
	| {
			readonly type: "human_request_pending";
			request: HumanRequestEnvelope;
	  }
	| {
			readonly type: "human_request_resolved";
			requestId: string;
			response: HumanResponse;
			completedAt: string;
	  }
	| {
			readonly type: "human_request_timeout";
			requestId: string;
			completedAt: string;
	  }
	| {
			readonly type: "human_request_cancelled";
			requestId: string;
			reason?: string;
			completedAt: string;
	  }
	| {
			readonly type: "diagnostic";
			diagnostic: OrchestratorDiagnostic;
			createdAt: string;
	  }
	| {
			readonly type: "agent_spawned";
			agentId: AgentId;
			profile: AgentProfile;
			model: RuntimeModel;
	  }
	| {
			readonly type: "agent_resumed";
			agentId: AgentId;
			profile: AgentProfile;
			model: RuntimeModel;
	  };

export type OrchestratorEventListener = (
	event: OrchestratorEvent,
) => Promise<void> | void;
export interface AgentOrchestratorConfigs {
	executionEnv: ExecutionEnv;
	resourceLoader: ResourceLoader;
	sessionManager: SessionManager;
	settingManager: SettingManager;
	modelRegistry: ModelRegistry;
	profileRegistry: AgentProfileRegistry;
	toolRegistry?: ToolRegistry;
	defaultProfileId: string;
	enabledProfileIds?: readonly string[];
	defaultModel: RuntimeModel;
}

export type AgentId = string;

interface PendingHumanRequest {
	envelope: HumanRequestEnvelope;
	controller: AbortController;
	cancel(reason?: string): Promise<void>;
}

interface AgentToolState {
	tools: AgentTool[];
	activeToolNames: string[];
}

interface AgentToolStateHarness {
	getTools(): AgentTool[];
	setTools(tools: AgentTool[], activeToolNames?: string[]): Promise<void>;
	getActiveTools(): AgentTool[];
	setActiveTools(toolNames: string[]): Promise<void>;
}

function validateToolNames(
	toolNames: readonly string[],
	tools: readonly AgentTool[],
) {
	const toolsByName = new Set(tools.map((tool) => tool.name));
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	const missing: string[] = [];
	for (const name of toolNames) {
		if (seen.has(name)) duplicates.add(name);
		seen.add(name);
		if (!toolsByName.has(name)) missing.push(name);
	}
	if (duplicates.size > 0) {
		throw new Error(
			`Duplicate active tool name(s): ${[...duplicates].join(", ")}`,
		);
	}
	if (missing.length > 0) {
		throw new Error(`Unknown active tool name(s): ${missing.join(", ")}`);
	}
}

interface SpawnAgentHarnessCommonOptions {
	model?: RuntimeModel;
	inheritModelFromAgentId?: AgentId;
}

export interface SpawnAgentHarnessCreateOptions
	extends SpawnAgentHarnessCommonOptions {
	resume?: false;
	profileId?: string;
	profileOverride?: AgentProfileOverride;
}

export interface SpawnAgentHarnessResumeOptions
	extends SpawnAgentHarnessCommonOptions {
	resume: true;
	metadata: ExtendedJsonlSessionMetadata;
}

export type SpawnAgentHarnessOptions =
	| SpawnAgentHarnessCreateOptions
	| SpawnAgentHarnessResumeOptions;

export interface SpawnAgentHarnessResult {
	agentId: AgentId;
	harness: AgentHarness;
}

export class AgentOrchestrator {
	private _defaultModel: RuntimeModel;
	private _defaultProfileId: string;
	private _enabledProfileIds: readonly string[] | undefined;
	readonly agents: Map<AgentId, AgentHarness> = new Map();
	readonly executionEnv: ExecutionEnv;
	readonly resourceLoader: ResourceLoader;
	readonly sessionManager: SessionManager;
	readonly settingManager: SettingManager;
	readonly modelRegistry: ModelRegistry;
	readonly profileRegistry: AgentProfileRegistry;
	readonly toolRegistry: ToolRegistry;

	private _unsubscribeAgentHarness: Map<AgentId, () => void> = new Map();
	private _eventListeners: Set<OrchestratorEventListener> = new Set();
	private _agentToolStates: Map<AgentId, AgentToolState> = new Map();
	private _clients: Map<string, OrchestratorClient<OrchestratorEvent>> =
		new Map();
	private _pendingHumanRequests: Map<string, PendingHumanRequest> = new Map();
	private _nextCommandId = 1;
	private _nextHumanRequestId = 1;

	constructor(config: AgentOrchestratorConfigs) {
		this.executionEnv = config.executionEnv;
		this.resourceLoader = config.resourceLoader;
		this.sessionManager = config.sessionManager;
		this.settingManager = config.settingManager;
		this.modelRegistry = config.modelRegistry;
		this.profileRegistry = config.profileRegistry;
		this.toolRegistry = config.toolRegistry ?? new ToolRegistry();
		this._defaultProfileId = config.defaultProfileId;
		this._enabledProfileIds = config.enabledProfileIds
			? [...config.enabledProfileIds]
			: undefined;
		this._defaultModel = config.defaultModel;
	}

	async spawnAgentHarness(
		options: SpawnAgentHarnessOptions = {},
	): Promise<SpawnAgentHarnessResult> {
		await this.emitStartupDiagnostics();
		if (options.resume) {
			return await this._resumeAgentHarness(options);
		}

		const agentProfile = await this._resolveCreateProfile(options);
		const model = this._resolveSpawnModel(options);
		return await this._createAgentHarness(agentProfile, model);
	}

	getDefaultModel(): RuntimeModel {
		return this._defaultModel;
	}

	setDefaultModel(model: RuntimeModel): void {
		this._defaultModel = model;
	}

	getDefaultProfileId(): string {
		return this._defaultProfileId;
	}

	setDefaultProfileId(profileId: string): void {
		this._defaultProfileId = profileId;
	}

	getEnabledProfileIds(): readonly string[] | undefined {
		return this._enabledProfileIds ? [...this._enabledProfileIds] : undefined;
	}

	setEnabledProfileIds(profileIds: readonly string[] | undefined): void {
		this._enabledProfileIds = profileIds ? [...profileIds] : undefined;
	}

	async emitStartupDiagnostics(): Promise<void> {
		await this._publishDiagnostics(this._drainCoreDiagnostics());
	}

	getAgentHarness(agentId: AgentId): AgentHarness | undefined {
		return this.agents.get(agentId);
	}

	getAgentModel(agentId: AgentId): RuntimeModel {
		return this._requireAgentHarness(agentId).getModel();
	}

	async setAgentModel(agentId: AgentId, model: RuntimeModel): Promise<void> {
		await this._requireAgentHarness(agentId).setModel(model);
	}

	getAgentTools(agentId: AgentId): AgentTool[] {
		const harness = this._requireAgentHarness(agentId) as AgentHarness &
			Partial<AgentToolStateHarness>;
		return (
			harness.getTools?.() ?? [...this._requireAgentToolState(agentId).tools]
		);
	}

	async setAgentTools(
		agentId: AgentId,
		tools: AgentTool[],
		activeToolNames?: string[],
	): Promise<void> {
		const harness = this._requireAgentHarness(agentId) as AgentHarness &
			Partial<AgentToolStateHarness>;
		const nextActiveToolNames =
			activeToolNames ?? this._requireAgentToolState(agentId).activeToolNames;
		validateToolNames(nextActiveToolNames, tools);
		await harness.setTools?.(tools, activeToolNames);
		this._agentToolStates.set(agentId, {
			tools: [...tools],
			activeToolNames: [...nextActiveToolNames],
		});
	}

	getAgentActiveTools(agentId: AgentId): AgentTool[] {
		const harness = this._requireAgentHarness(agentId) as AgentHarness &
			Partial<AgentToolStateHarness>;
		if (harness.getActiveTools) {
			return harness.getActiveTools();
		}
		const state = this._requireAgentToolState(agentId);
		const toolsByName = new Map(state.tools.map((tool) => [tool.name, tool]));
		return state.activeToolNames.map((name) => {
			const tool = toolsByName.get(name);
			if (!tool) throw new Error(`Unknown active tool: ${name}`);
			return tool;
		});
	}

	async setAgentActiveTools(
		agentId: AgentId,
		toolNames: string[],
	): Promise<void> {
		const harness = this._requireAgentHarness(agentId) as AgentHarness &
			Partial<AgentToolStateHarness>;
		const state = this._requireAgentToolState(agentId);
		validateToolNames(toolNames, state.tools);
		await harness.setActiveTools?.(toolNames);
		this._agentToolStates.set(agentId, {
			tools: [...state.tools],
			activeToolNames: [...toolNames],
		});
	}

	async promptAgent(
		agentId: AgentId,
		text: string,
		options?: { images?: ImageContent[] },
	) {
		return await this._requireAgentHarness(agentId).prompt(text, options);
	}

	async steerAgent(
		agentId: AgentId,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<void> {
		await this._requireAgentHarness(agentId).steer(text, options);
	}

	async followUpAgent(
		agentId: AgentId,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<void> {
		await this._requireAgentHarness(agentId).followUp(text, options);
	}

	async nextTurnAgent(
		agentId: AgentId,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<void> {
		await this._requireAgentHarness(agentId).nextTurn(text, options);
	}

	async abortAgent(agentId: AgentId) {
		return await this._requireAgentHarness(agentId).abort();
	}

	async compactAgent(agentId: AgentId, customInstructions?: string) {
		return await this._requireAgentHarness(agentId).compact(customInstructions);
	}

	async navigateAgentTree(
		agentId: AgentId,
		targetId: string,
		options?: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		},
	) {
		return await this._requireAgentHarness(agentId).navigateTree(
			targetId,
			options,
		);
	}

	registerClient(client: OrchestratorClient<OrchestratorEvent>): () => void {
		this._clients.set(client.id, client);
		return () => {
			if (this._clients.get(client.id) === client) {
				this._clients.delete(client.id);
			}
		};
	}

	async dispatch(
		command: OrchestratorCommand,
	): Promise<OrchestratorCommandResult> {
		const commandId = command.id ?? this._createCommandId();
		await this._emit({
			type: "command_accepted",
			commandId,
			command,
			createdAt: now(),
		});

		try {
			const value =
				command.kind === "human.request"
					? await this.requestHuman({
							...command.request,
							source: command.source,
						})
					: await this._executeCommand(command);
			await this._emit({
				type: "command_completed",
				commandId,
				command,
				result: value,
				completedAt: now(),
			});
			return { ok: true, commandId, value };
		} catch (error) {
			const diagnostic = toDiagnostic(error, {
				code: "orchestrator.command_failed",
				message: error instanceof Error ? error.message : String(error),
				operationSource: command.source,
				agentId: "agentId" in command ? command.agentId : undefined,
				commandId,
				recoverable: true,
			});
			await this._emit({
				type: "command_rejected",
				commandId,
				command,
				diagnostic,
				completedAt: now(),
			});
			await this._publishDiagnostic(diagnostic);
			return { ok: false, commandId, diagnostic };
		}
	}

	async requestHuman(request: HumanRequest): Promise<HumanResponse> {
		const client = Array.from(this._clients.values()).find(
			(entry) => entry.requestHuman,
		);
		const requestHuman = client?.requestHuman;
		const requestId = this._createHumanRequestId();
		const envelope: HumanRequestEnvelope = {
			...request,
			id: requestId,
			createdAt: now(),
		};

		if (!requestHuman) {
			const diagnostic = createOrchestratorDiagnostic({
				severity: "error",
				code: "orchestrator.human_request_unhandled",
				message: "No orchestrator client can handle human requests.",
				operationSource: request.source,
				requestId,
				recoverable: true,
			});
			await this._publishDiagnostic(diagnostic);
			throw new OrchestratorError(diagnostic);
		}

		const controller = new AbortController();
		const abortFromCaller = () => controller.abort();
		request.signal?.addEventListener("abort", abortFromCaller, { once: true });

		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		let cancelPending: (reason?: string) => Promise<void> = async () => {};
		try {
			const responsePromise = new Promise<HumanResponse>((resolve, reject) => {
				let settled = false;
				let abortHandler: (() => void) | undefined;
				const cleanup = () => {
					if (timeoutId) clearTimeout(timeoutId);
					request.signal?.removeEventListener("abort", abortFromCaller);
					if (abortHandler) {
						controller.signal.removeEventListener("abort", abortHandler);
					}
				};
				const rejectWithDiagnostic = (
					diagnostic: OrchestratorDiagnostic,
					beforeReject?: () => void,
				) => {
					if (settled) return;
					settled = true;
					cleanup();
					beforeReject?.();
					reject(new OrchestratorError(diagnostic));
				};
				abortHandler = () => {
					rejectWithDiagnostic(
						createOrchestratorDiagnostic({
							severity: "error",
							code: "orchestrator.human_request_aborted",
							message: "Human request was aborted.",
							operationSource: request.source,
							requestId,
							recoverable: true,
						}),
					);
				};
				controller.signal.addEventListener("abort", abortHandler, {
					once: true,
				});
				cancelPending = async (reason) => {
					if (settled) return;
					await this._emit({
						type: "human_request_cancelled",
						requestId,
						reason,
						completedAt: now(),
					});
					rejectWithDiagnostic(
						createOrchestratorDiagnostic({
							severity: "error",
							code: "orchestrator.human_request_cancelled",
							message: reason
								? `Human request was cancelled: ${reason}`
								: "Human request was cancelled.",
							operationSource: request.source,
							requestId,
							recoverable: true,
						}),
						() => controller.abort(),
					);
				};
				if (request.timeoutMs !== undefined) {
					timeoutId = setTimeout(() => {
						void this._emit({
							type: "human_request_timeout",
							requestId,
							completedAt: now(),
						});
						rejectWithDiagnostic(
							createOrchestratorDiagnostic({
								severity: "error",
								code: "orchestrator.human_request_timeout",
								message: "Human request timed out.",
								operationSource: request.source,
								requestId,
								recoverable: true,
							}),
							() => controller.abort(),
						);
					}, request.timeoutMs);
				}
				requestHuman(envelope, controller.signal).then(
					(value) => {
						if (settled) return;
						settled = true;
						cleanup();
						resolve(value);
					},
					(error) => {
						if (settled) return;
						settled = true;
						cleanup();
						reject(error);
					},
				);
			});
			this._pendingHumanRequests.set(requestId, {
				envelope,
				controller,
				cancel: (reason) => cancelPending(reason),
			});
			await this._emit({ type: "human_request_pending", request: envelope });
			const response = await responsePromise;
			this._pendingHumanRequests.delete(requestId);
			await this._emit({
				type: "human_request_resolved",
				requestId,
				response,
				completedAt: now(),
			});
			return response;
		} catch (error) {
			this._pendingHumanRequests.delete(requestId);
			const diagnostic = toDiagnostic(error, {
				code: "orchestrator.command_failed",
				message: error instanceof Error ? error.message : String(error),
				operationSource: request.source,
				requestId,
				recoverable: true,
			});
			await this._publishDiagnostic(diagnostic);
			throw new OrchestratorError(diagnostic);
		}
	}

	async cancelHumanRequest(
		requestId: string,
		reason?: string,
	): Promise<boolean> {
		const pending = this._pendingHumanRequests.get(requestId);
		if (!pending) return false;
		await pending.cancel(reason);
		return true;
	}

	subscribe(listener: OrchestratorEventListener): () => void {
		this._eventListeners.add(listener);
		return () => this._eventListeners.delete(listener);
	}

	subscribeAgent(
		agentId: AgentId,
		listener: OrchestratorEventListener,
	): () => void {
		return this.subscribe((event) => {
			if ("agentId" in event && event.agentId === agentId) {
				return listener(event);
			}
		});
	}

	private _allocateAgentId(profile: AgentProfile): AgentId {
		const base =
			profile.label
				.trim()
				.toLocaleLowerCase()
				.replace(/[^a-z0-9-]+/g, "-")
				.replace(/^-+|-+$/g, "") || "agent";
		let agentId: AgentId = base;
		let suffix = 2;

		while (this.agents.has(agentId)) {
			agentId = `${base}-${suffix}`;
			suffix += 1;
		}

		return agentId;
	}

	private _resolveSpawnModel(options: SpawnAgentHarnessOptions): RuntimeModel {
		if (options.model) {
			return options.model;
		}

		if (options.inheritModelFromAgentId) {
			const sourceHarness = this.agents.get(options.inheritModelFromAgentId);
			if (!sourceHarness) {
				throw new Error(
					`Cannot inherit model from unknown agent: ${options.inheritModelFromAgentId}`,
				);
			}
			return sourceHarness.getModel();
		}

		return this._defaultModel;
	}

	private async _resolveCreateProfile(
		options: SpawnAgentHarnessCreateOptions,
	): Promise<AgentProfile> {
		const profileId = options.profileId ?? this._defaultProfileId;
		const profile = await this._resolveProfileById(profileId, undefined);
		return await this._applyProfileOverride(profile, options.profileOverride);
	}

	private async _resolveResumeProfile(
		agentId: AgentId,
		metadata: ExtendedJsonlSessionMetadata,
	): Promise<AgentProfile> {
		const profileReference = metadata.metadata?.profile;
		if (!profileReference?.id) {
			throw new OrchestratorError(
				createOrchestratorDiagnostic({
					severity: "error",
					code: "profile.resolution_failed",
					message: `Cannot resume agent ${agentId}: session metadata does not contain a profile reference.`,
					agentId,
					phase: "resume",
					recoverable: true,
				}),
			);
		}
		return await this._resolveProfileById(profileReference.id, agentId);
	}

	private async _resolveProfileById(
		profileId: string,
		agentId: AgentId | undefined,
	): Promise<AgentProfile> {
		const result = await this.profileRegistry.resolveProfile(profileId);
		await this._publishDiagnostics(result.diagnostics);
		if (!result.ok) {
			const diagnostic = createOrchestratorDiagnostic({
				severity: "error",
				code: "profile.resolution_failed",
				message: `Cannot resolve profile ${profileId}: ${result.reason}.`,
				agentId,
				profileId,
				phase: "resolve",
				recoverable: true,
			});
			await this._publishDiagnostic(diagnostic);
			throw new OrchestratorError(diagnostic);
		}

		if (!this._isProfileEnabled(result.profile.id)) {
			const diagnostic = createOrchestratorDiagnostic({
				severity: "error",
				code: "profile.disabled",
				message: `Profile is disabled by runtime policy: ${result.profile.id}`,
				agentId,
				profileId: result.profile.id,
				phase: "resolve",
				recoverable: true,
			});
			await this._publishDiagnostic(diagnostic);
			throw new OrchestratorError(diagnostic);
		}

		return result.profile;
	}

	private _isProfileEnabled(profileId: string): boolean {
		return (
			this._enabledProfileIds === undefined ||
			this._enabledProfileIds.includes(profileId)
		);
	}

	private async _applyProfileOverride(
		profile: AgentProfile,
		override: AgentProfileOverride | undefined,
	): Promise<AgentProfile> {
		if (!override) {
			return profile;
		}

		if ("id" in override) {
			const diagnostic = createOrchestratorDiagnostic({
				severity: "error",
				code: "profile.override_invalid",
				message: "Profile override cannot change profile id.",
				profileId: profile.id,
				phase: "create",
				recoverable: true,
			});
			await this._publishDiagnostic(diagnostic);
			throw new OrchestratorError(diagnostic);
		}

		const merged: AgentProfile = {
			...profile,
			...override,
			capabilities: override.capabilities
				? { ...profile.capabilities, ...override.capabilities }
				: profile.capabilities,
		};
		if (merged.persist && changesRecoverableProfileFields(override)) {
			const diagnostic = createOrchestratorDiagnostic({
				severity: "error",
				code: "profile.override_not_persistable",
				message:
					"Profile override changes recoverable profile fields and cannot create a persistent session.",
				profileId: profile.id,
				phase: "create",
				recoverable: true,
			});
			await this._publishDiagnostic(diagnostic);
			throw new OrchestratorError(diagnostic);
		}
		return merged;
	}

	private _resolveResumeModel(
		options: SpawnAgentHarnessResumeOptions,
		contextModel: { provider: string; modelId: string } | null,
	): RuntimeModel {
		if (options.model || options.inheritModelFromAgentId) {
			return this._resolveSpawnModel(options);
		}

		if (!contextModel) {
			return this._defaultModel;
		}

		const model = this.modelRegistry.find(
			contextModel.provider,
			contextModel.modelId,
		);
		if (!model) {
			throw new Error(
				`Cannot resume model ${contextModel.provider}/${contextModel.modelId}: model is not registered.`,
			);
		}
		return model;
	}

	private _resolveThinkingLevel(level: string): ThinkingLevel {
		if (
			level === "off" ||
			level === "minimal" ||
			level === "low" ||
			level === "medium" ||
			level === "high" ||
			level === "xhigh"
		) {
			return level;
		}
		throw new Error(
			`Cannot resume session with invalid thinking level: ${level}`,
		);
	}

	private async _createAgentHarness(
		profile: AgentProfile,
		model: RuntimeModel,
	): Promise<SpawnAgentHarnessResult> {
		const agentId = this._allocateAgentId(profile);
		const session = await this.sessionManager.createAgentSession({
			agentId: agentId,
			agentProfile: profile,
		});

		const harness = await this._buildAgentHarness({
			agentId,
			profile,
			session,
			model,
		});
		await this._emit({ type: "agent_spawned", agentId, profile, model });
		return { agentId, harness };
	}

	private async _resumeAgentHarness(
		options: SpawnAgentHarnessResumeOptions,
	): Promise<SpawnAgentHarnessResult> {
		const agentId = options.metadata.id;
		const cachedHarness = this.agents.get(agentId);
		if (cachedHarness) {
			return { agentId, harness: cachedHarness };
		}

		const profile = await this._resolveResumeProfile(agentId, options.metadata);
		const session = await this.sessionManager.resumeAgentSession({
			agentId,
			metadata: options.metadata,
		});
		const context = (await session.buildContext()) as Awaited<
			ReturnType<typeof session.buildContext>
		> & {
			activeToolNames?: string[] | null;
		};
		const model = this._resolveResumeModel(options, context.model);
		const harness = await this._buildAgentHarness({
			agentId,
			profile,
			session,
			model,
			thinkingLevel: this._resolveThinkingLevel(context.thinkingLevel),
			activeToolNames: context.activeToolNames ?? undefined,
		});

		await this._emit({ type: "agent_resumed", agentId, profile, model });
		return { agentId, harness };
	}

	private async _buildAgentHarness(options: {
		agentId: AgentId;
		profile: AgentProfile;
		session: Session<AgentSessionMetadata>;
		model: RuntimeModel;
		thinkingLevel?: ThinkingLevel;
		activeToolNames?: string[];
	}): Promise<AgentHarness> {
		const { agentId, profile, session, model } = options;
		const LoadedSkill = await this.resourceLoader.loadSkills(profile.skills);
		const LoadedPromptTemplate = await this.resourceLoader.loadPromptTemplates(
			profile.promptTemplates,
		);

		const resourceDiagnostics: OrchestratorDiagnostic[] = [
			...LoadedSkill.diagnostics.map((diagnostic) =>
				toCoreDiagnosticFromSkillDiagnostic(diagnostic, {
					agentId,
					profileId: profile.id,
					phase: "resolve",
				}),
			),
			...LoadedPromptTemplate.diagnostics.map((diagnostic) =>
				toCoreDiagnosticFromPromptTemplateDiagnostic(diagnostic, {
					agentId,
					profileId: profile.id,
					phase: "resolve",
				}),
			),
		];
		await this._publishDiagnostics(resourceDiagnostics);

		const resources: AgentHarnessResources = {
			// this step ignore thie "ResourceSource", may be has any other usage;
			skills: LoadedSkill.skills.map(({ skill }) => skill),
			promptTemplates: LoadedPromptTemplate.promptTemplates.map(
				({ promptTemplate }) => promptTemplate,
			),
		};
		const toolRegistry = ToolRegistry.from(
			this.toolRegistry.getContributions(),
		);
		const resolvedTools = toolRegistry.resolve({
			requestedToolNames: profile.tools,
			activeToolNames: options.activeToolNames,
		});
		await this._publishDiagnostics(
			resolvedTools.diagnostics.map((diagnostic) => ({
				...diagnostic,
				agentId,
				profileId: profile.id,
				phase: "resolve",
			})),
		);
		const agentTools = createAgentToolsFromResolvedTools(resolvedTools.tools, {
			env: this.executionEnv,
			human: {
				request: async (request) =>
					await this.requestHuman({
						...request,
						source: { kind: "agent", agentId },
					}),
			},
		});

		const harness = new AgentHarness({
			env: this.executionEnv,
			session: session,
			resources: resources,
			tools: agentTools,
			systemPrompt: profile.systemPrompt,
			model: model,
			thinkingLevel: options.thinkingLevel,
			activeToolNames: [...resolvedTools.activeToolNames],
			getApiKeyAndHeaders: async (requestModel) => {
				const result =
					await this.modelRegistry.getApiKeyAndHeaders(requestModel);
				await this._publishDiagnostics(this._drainCoreDiagnostics());
				if (!result.ok) {
					throw new Error(result.error);
				}
				return result.apiKey || result.headers
					? { apiKey: result.apiKey ?? "", headers: result.headers }
					: undefined;
			},
		});
		this.agents.set(agentId, harness);
		this._agentToolStates.set(agentId, {
			tools: [...agentTools],
			activeToolNames: [...resolvedTools.activeToolNames],
		});
		this._unsubscribeAgentHarness.set(
			agentId,
			harness.subscribe((event) => {
				void this._emit({ type: "agent_harness_event", agentId, event });
			}),
		);
		return harness;
	}

	private _requireAgentHarness(agentId: AgentId): AgentHarness {
		const harness = this.agents.get(agentId);
		if (!harness) {
			throw new Error(`Unknown agent: ${agentId}`);
		}
		return harness;
	}

	private _requireAgentToolState(agentId: AgentId): AgentToolState {
		const state = this._agentToolStates.get(agentId);
		if (!state) {
			throw new Error(`Unknown agent tool state: ${agentId}`);
		}
		return state;
	}

	private async _executeCommand(
		command: OrchestratorCommand,
	): Promise<OrchestratorCommandValue> {
		switch (command.kind) {
			case "agent.prompt":
				return await this.promptAgent(command.agentId, command.text, {
					images: command.images,
				});
			case "agent.steer":
				await this.steerAgent(command.agentId, command.text, {
					images: command.images,
				});
				return undefined;
			case "agent.followUp":
				await this.followUpAgent(command.agentId, command.text, {
					images: command.images,
				});
				return undefined;
			case "agent.nextTurn":
				await this.nextTurnAgent(command.agentId, command.text, {
					images: command.images,
				});
				return undefined;
			case "agent.abort":
				return await this.abortAgent(command.agentId);
			case "agent.compact":
				return await this.compactAgent(
					command.agentId,
					command.customInstructions,
				);
			case "agent.navigateTree":
				return await this.navigateAgentTree(command.agentId, command.targetId, {
					summarize: command.summarize,
					customInstructions: command.customInstructions,
					replaceInstructions: command.replaceInstructions,
					label: command.label,
				});
			case "agent.getModel":
				return this.getAgentModel(command.agentId);
			case "agent.setModel":
				await this.setAgentModel(command.agentId, command.model);
				return undefined;
			case "agent.getTools":
				return this.getAgentTools(command.agentId);
			case "agent.setTools":
				await this.setAgentTools(
					command.agentId,
					command.tools,
					command.activeToolNames,
				);
				return undefined;
			case "agent.getActiveTools":
				return this.getAgentActiveTools(command.agentId);
			case "agent.setActiveTools":
				await this.setAgentActiveTools(command.agentId, command.toolNames);
				return undefined;
			case "human.request":
				return await this.requestHuman({
					...command.request,
					source: command.source,
				});
		}
	}

	private async _emit(
		event: OrchestratorEvent,
		options: { sendToClients?: boolean } = {},
	): Promise<void> {
		for (const listener of this._eventListeners) {
			await listener(event);
		}
		if (options.sendToClients === false) return;
		for (const client of this._clients.values()) {
			if (!client.receive) continue;
			try {
				await client.receive(event);
			} catch (error) {
				await this._publishDiagnostic(
					createOrchestratorDiagnostic({
						severity: "warning",
						code: "orchestrator.client_failed",
						message: error instanceof Error ? error.message : String(error),
						disposition: "reported",
						recoverable: true,
					}),
					{ sendToClients: false },
				);
			}
		}
	}

	private async _publishDiagnostic(
		diagnostic: OrchestratorDiagnostic,
		options: { sendToClients?: boolean } = {},
	): Promise<void> {
		await this._emit(
			{
				type: "diagnostic",
				diagnostic,
				createdAt: now(),
			},
			options,
		);
	}

	private async _publishDiagnostics(
		diagnostics: readonly OrchestratorDiagnostic[],
		options: { sendToClients?: boolean } = {},
	): Promise<void> {
		for (const diagnostic of dedupeDiagnostics(diagnostics)) {
			await this._publishDiagnostic(diagnostic, options);
		}
	}

	private _drainCoreDiagnostics(): OrchestratorDiagnostic[] {
		return [
			...this.settingManager.drainDiagnostics(),
			...this.modelRegistry.authStorage.drainDiagnostics(),
			...this.modelRegistry.drainDiagnostics(),
		];
	}

	private _createCommandId(): string {
		const id = `orchestrator-command-${this._nextCommandId}`;
		this._nextCommandId += 1;
		return id;
	}

	private _createHumanRequestId(): string {
		const id = `human-request-${this._nextHumanRequestId}`;
		this._nextHumanRequestId += 1;
		return id;
	}
}

function toDiagnostic(
	error: unknown,
	fallback: Omit<
		OrchestratorDiagnostic,
		"domain" | "disposition" | "severity" | "source"
	> & {
		severity?: OrchestratorDiagnostic["severity"];
		disposition?: DiagnosticDisposition;
		operationSource?: OperationSource;
	},
): OrchestratorDiagnostic {
	if (error instanceof OrchestratorError) return error.diagnostic;
	return createOrchestratorDiagnostic({
		severity: fallback.severity ?? "error",
		disposition: fallback.disposition,
		code: fallback.code,
		message: fallback.message,
		operationSource: fallback.operationSource,
		agentId: fallback.agentId,
		requestId: fallback.requestId,
		commandId: fallback.commandId,
		recoverable: fallback.recoverable,
	});
}

function createOrchestratorDiagnostic(
	diagnostic: Omit<
		OrchestratorDiagnostic,
		"domain" | "disposition" | "source"
	> & {
		readonly domain?: OrchestratorDiagnostic["domain"];
		readonly disposition?: DiagnosticDisposition;
		readonly source?: DiagnosticSource;
		readonly operationSource?: OperationSource;
	},
): OrchestratorDiagnostic {
	const {
		domain,
		disposition,
		operationSource: inputOperationSource,
		source: inputSource,
		...rest
	} = diagnostic;
	const source = inputSource ?? operationSource(inputOperationSource);
	return {
		...rest,
		domain: domain ?? domainFromDiagnosticCode(diagnostic.code),
		disposition: disposition ?? "blocked",
		source,
	};
}

function domainFromDiagnosticCode(
	code: string,
): OrchestratorDiagnostic["domain"] {
	const [domain] = code.split(".");
	if (
		domain === "profile" ||
		domain === "resource" ||
		domain === "tool" ||
		domain === "model" ||
		domain === "auth" ||
		domain === "settings" ||
		domain === "extension" ||
		domain === "orchestrator"
	) {
		return domain;
	}
	return "orchestrator";
}

function operationSource(
	source: OperationSource | undefined,
): DiagnosticSource | undefined {
	return source ? { kind: "operation", source } : undefined;
}

function changesRecoverableProfileFields(
	override: AgentProfileOverride,
): boolean {
	return (
		override.systemPrompt !== undefined ||
		override.tools !== undefined ||
		override.skills !== undefined ||
		override.promptTemplates !== undefined ||
		override.extensions !== undefined ||
		override.capabilities !== undefined ||
		override.persist !== undefined
	);
}

function now(): string {
	return new Date().toISOString();
}
