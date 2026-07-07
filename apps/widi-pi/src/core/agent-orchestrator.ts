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
import {
	type AssistantMessage,
	getSupportedThinkingLevels,
	type ImageContent,
} from "@earendil-works/pi-ai";
import type { ExtendedJsonlSessionMetadata } from "../storage/jsonl-repo.ts";
import type {
	AgentProfile,
	AgentProfileCommandPolicy,
	AgentProfileOverride,
	AgentProfileReference,
	AgentProfileRegistry,
	AgentProfileSource,
} from "./agent-profile.js";
import { toAgentProfileReference } from "./agent-profile.js";
import type { OrchestratorClient } from "./client.ts";
import {
	BUILT_IN_COMMANDS,
	type Command,
	type CommandCandidate,
	type CommandInvocation,
	type CommandStatusCheck,
	getBuiltInCommands,
	type InputResult,
	type ParsedLineCommand,
	parseLineCommand,
} from "./command.ts";
import {
	type DiagnosticDisposition,
	type DiagnosticSource,
	dedupeDiagnostics,
	type OrchestratorDiagnostic,
	OrchestratorError,
	toCoreDiagnosticFromPromptTemplateDiagnostic,
	toCoreDiagnosticFromSkillDiagnostic,
} from "./diagnostics.ts";
import {
	type ExtensionActionFailure,
	type ExtensionActions,
	type ExtensionFactory,
	type ExtensionIdentity,
	type ExtensionInterceptorEventFor,
	type ExtensionInterceptorName,
	type ExtensionInterceptorResultFor,
	ExtensionLoader,
	ExtensionRunner,
	type ExtensionRunnerSnapshot,
	type ToolLifecycleEvent,
} from "./extension/index.ts";
import type {
	HumanRequest,
	HumanRequestEnvelope,
	HumanResponse,
} from "./human-request.ts";
import type { ModelRegistry } from "./model-registry.js";
import type { OperationSource } from "./operation-source.ts";
import type { ResourceLoader } from "./resource-loader.js";
import type { AgentToolsSnapshot, RuntimeModel } from "./runtime-types.ts";
import type {
	AgentSessionCandidate,
	AgentSessionMetadata,
	AgentSessionSnapshot,
	AgentSessionTreeSnapshot,
	ForkAgentSessionOptions,
	SessionManager,
} from "./session-manager.ts";
import type { SettingManager } from "./setting-manager.js";
import {
	createAgentToolsFromResolvedTools,
	ToolRegistry,
} from "./tool-registry.ts";

export type OrchestratorEvent =
	| {
			readonly type: "agent_harness_event";
			agentId: AgentId;
			event: AgentHarnessEvent;
	  }
	| {
			readonly type: "tool_lifecycle_event";
			agentId: AgentId;
			event: ToolLifecycleEvent;
	  }
	| {
			readonly type: "command_detected";
			commandId: string;
			command: CommandInvocation;
			createdAt: string;
	  }
	| {
			readonly type: "command_accepted";
			commandId: string;
			command: CommandInvocation;
			createdAt: string;
	  }
	| {
			readonly type: "command_completed";
			commandId: string;
			command: CommandInvocation;
			result: unknown;
			completedAt: string;
	  }
	| {
			readonly type: "command_failed";
			commandId: string;
			command: CommandInvocation;
			diagnostic: OrchestratorDiagnostic;
			completedAt: string;
	  }
	| {
			readonly type: "command_rejected";
			commandId: string;
			command?: CommandInvocation;
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
	extensionLoader?: ExtensionLoader;
	defaultProfileId: string;
	enabledProfileIds?: readonly string[];
	defaultModel: RuntimeModel;
	defaultThinkingLevel?: ThinkingLevel;
}

export type AgentId = string;

export type AgentLifecycleStatus =
	| "creating"
	| "ready"
	| "running"
	| "idle"
	| "unavailable"
	| "disposed";

export interface AgentProfileRecordReference {
	readonly reference: AgentProfileReference;
	readonly source?: AgentProfileSource;
	readonly entryId?: string;
}

export interface AgentRecord {
	readonly agentId: AgentId;
	status: AgentLifecycleStatus;
	readonly profile: AgentProfileRecordReference;
	// Command gating facts snapshotted from the resolved profile.
	readonly capabilities?: AgentProfile["capabilities"];
	readonly commandPolicy?: AgentProfileCommandPolicy;
	sessionMetadata?: AgentSessionMetadata;
	model: RuntimeModel;
	harness?: AgentHarness;
	toolSnapshot?: AgentToolsSnapshot;
	extensionRunner?: ExtensionRunner;
	resourceDiagnostics: OrchestratorDiagnostic[];
	extensionDiagnostics: OrchestratorDiagnostic[];
	diagnostics: OrchestratorDiagnostic[];
}

export interface AgentRecordSnapshot {
	readonly agentId: AgentId;
	readonly status: AgentLifecycleStatus;
	readonly profile: AgentProfileRecordReference;
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly model: RuntimeModel;
	readonly hasHarness: boolean;
	readonly toolSnapshot?: AgentToolsSnapshot;
	readonly extensionIds: readonly string[];
	readonly extensions: readonly ExtensionIdentity[];
	readonly extensionSnapshot: ExtensionRunnerSnapshot;
	readonly resourceDiagnostics: readonly OrchestratorDiagnostic[];
	readonly extensionDiagnostics: readonly OrchestratorDiagnostic[];
	readonly diagnostics: readonly OrchestratorDiagnostic[];
}

export interface AgentSessionCommandResult {
	readonly agentId: AgentId;
	readonly snapshot: AgentRecordSnapshot;
}

export interface AgentSessionListResult {
	readonly sessions: readonly AgentSessionCandidate[];
}

export interface AgentListResult {
	readonly agents: readonly AgentRecordSnapshot[];
}

export interface AgentModelCandidateListResult {
	readonly models: readonly CommandCandidate[];
}

export interface AgentThinkingLevelCandidateListResult {
	readonly levels: readonly CommandCandidate[];
}

export interface AgentThinkingLevelCommandResult {
	readonly level: ThinkingLevel;
}

export type ExtensionReloadAgentStatus = "reloaded" | "skipped" | "failed";

export type ExtensionReloadAgentSkipReason =
	| "creating"
	| "running"
	| "disposed"
	| "unavailable"
	| "missing_harness"
	| "unknown_agent";

export interface ExtensionReloadAgentResult {
	readonly agentId: string;
	readonly status: ExtensionReloadAgentStatus;
	readonly reason?: ExtensionReloadAgentSkipReason;
	readonly diagnostics: readonly OrchestratorDiagnostic[];
	readonly before?: AgentRecordSnapshot;
	readonly after?: AgentRecordSnapshot;
}

export interface ExtensionReloadResult {
	readonly catalog: {
		readonly loaded: readonly ExtensionIdentity[];
		readonly diagnostics: readonly OrchestratorDiagnostic[];
	};
	readonly agents: readonly ExtensionReloadAgentResult[];
}

interface PendingHumanRequest {
	envelope: HumanRequestEnvelope;
	agentId?: AgentId;
	controller: AbortController;
	cancel(reason?: string): Promise<void>;
}

interface AgentToolSet {
	tools: AgentTool[];
	toolNames: string[];
	requestedToolNames: string[] | undefined;
	activeToolNames: string[];
	activeToolSelection: ActiveToolSelection;
	profileId: string;
}

type ActiveToolSelection =
	| { readonly mode: "default_all" }
	| { readonly mode: "explicit"; readonly toolNames: readonly string[] };

interface ResolvedAgentProfile {
	profile: AgentProfile;
	source: AgentProfileSource;
	entryId: string;
}

interface StreamingToolCallRef {
	toolCallId?: string;
	toolName?: string;
}

interface AgentToolSetHarness {
	getTools(): AgentTool[];
	setTools(tools: AgentTool[], activeToolNames?: string[]): Promise<void>;
	getActiveTools(): AgentTool[];
	setActiveTools(toolNames: string[]): Promise<void>;
}

interface LineCommandBinding {
	readonly command: Command;
	readonly checkStatus?: CommandStatusCheck;
	execute(args: string): Promise<unknown>;
}

interface SpawnAgentHarnessCommonOptions {
	model?: RuntimeModel;
	inheritModelFromAgentId?: AgentId;
	thinkingLevel?: ThinkingLevel;
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
	private _defaultThinkingLevel: ThinkingLevel | undefined;
	private _defaultProfileId: string;
	private _enabledProfileIds: readonly string[] | undefined;
	readonly agents: Map<AgentId, AgentRecord> = new Map();
	readonly executionEnv: ExecutionEnv;
	readonly resourceLoader: ResourceLoader;
	readonly sessionManager: SessionManager;
	readonly settingManager: SettingManager;
	readonly modelRegistry: ModelRegistry;
	readonly profileRegistry: AgentProfileRegistry;
	readonly toolRegistry: ToolRegistry;
	readonly extensionLoader: ExtensionLoader;

	private _unsubscribeAgentHarness: Map<AgentId, () => void> = new Map();
	private _unsubscribeAgentExtensionInterceptors: Map<AgentId, () => void> =
		new Map();
	private _eventListeners: Set<OrchestratorEventListener> = new Set();
	private _agentToolSets: Map<AgentId, AgentToolSet> = new Map();
	private _streamingToolCalls: Map<AgentId, Map<number, StreamingToolCallRef>> =
		new Map();
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
		this.modelRegistry.setDiagnosticPublisher(
			async (diagnostics) => await this._publishDiagnostics(diagnostics),
		);
		this.profileRegistry = config.profileRegistry;
		this.toolRegistry = config.toolRegistry ?? new ToolRegistry();
		this.extensionLoader = config.extensionLoader ?? new ExtensionLoader();
		this._defaultProfileId = config.defaultProfileId;
		this._enabledProfileIds = config.enabledProfileIds
			? [...config.enabledProfileIds]
			: undefined;
		this._defaultModel = config.defaultModel;
		this._defaultThinkingLevel = config.defaultThinkingLevel;
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
		return await this._createAgentHarness(agentProfile, model, {
			thinkingLevel: options.thinkingLevel ?? this._defaultThinkingLevel,
		});
	}

	getDefaultModel(): RuntimeModel {
		return this._defaultModel;
	}

	setDefaultModel(model: RuntimeModel): void {
		this._defaultModel = model;
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this._defaultThinkingLevel;
	}

	setDefaultThinkingLevel(thinkingLevel: ThinkingLevel | undefined): void {
		this._defaultThinkingLevel = thinkingLevel;
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

	registerExtensionFactory(
		extensionId: string,
		factory: ExtensionFactory,
	): () => void {
		return this.extensionLoader.registerExtensionFactory(extensionId, factory);
	}

	getAgentHarness(agentId: AgentId): AgentHarness | undefined {
		return this.agents.get(agentId)?.harness;
	}

	getAgentStatus(agentId: AgentId): AgentLifecycleStatus {
		return this._requireAgentRecord(agentId).status;
	}

	inspectAgent(agentId: AgentId): AgentRecordSnapshot {
		return this._snapshotAgentRecord(this._requireAgentRecord(agentId));
	}

	listAgents(): AgentListResult {
		return {
			agents: Array.from(this.agents.values()).map((record) =>
				this._snapshotAgentRecord(record),
			),
		};
	}

	// Command registry
	listCommands(agentId: AgentId): Command[] {
		const record = this._requireAgentRecord(agentId);
		if (record.commandPolicy?.enabled === false) return [];
		// Static gating (profile deny, scope) prunes the list; dynamic gating
		// (agent status) is reported as per-command availability instead.
		const builtInCommands = BUILT_IN_COMMANDS.filter(
			(binding) => !this._commandPolicyDenial(record, binding.command),
		).map((binding) =>
			this._withCommandAvailability(
				record,
				binding.command,
				binding.checkStatus,
			),
		);
		const extensionCommands =
			record.extensionRunner
				?.getCommands({ reservedCommands: getBuiltInCommands() })
				.filter(
					(resolved) => !this._commandPolicyDenial(record, resolved.command),
				)
				.map((resolved) =>
					this._withCommandAvailability(record, resolved.command),
				) ?? [];
		return [...builtInCommands, ...extensionCommands];
	}

	async newAgentSessionFromAgent(
		agentId: AgentId,
	): Promise<AgentSessionCommandResult> {
		const sourceRecord = this._requireAgentRecord(agentId);
		const result = await this.spawnAgentHarness({
			profileId: sourceRecord.profile.reference.id,
			model: sourceRecord.model,
		});
		return {
			agentId: result.agentId,
			snapshot: this.inspectAgent(result.agentId),
		};
	}

	async getAgentSession(agentId: AgentId): Promise<AgentSessionSnapshot> {
		this._requireAgentRecord(agentId);
		return await this.sessionManager.getAgentSessionSnapshot(agentId);
	}

	async getAgentSessionTree(
		agentId: AgentId,
	): Promise<AgentSessionTreeSnapshot> {
		this._requireAgentRecord(agentId);
		return await this.sessionManager.getAgentSessionTree(agentId);
	}

	async setAgentSessionName(
		agentId: AgentId,
		name: string,
	): Promise<AgentSessionSnapshot> {
		this._requireAgentRecord(agentId);
		return await this.sessionManager.setAgentSessionName(agentId, name);
	}

	async forkAgentSessionFromAgent(
		agentId: AgentId,
		options?: ForkAgentSessionOptions,
	): Promise<AgentSessionCommandResult> {
		const sourceRecord = this._requireAgentRecord(agentId);
		const metadata = await this.sessionManager.forkAgentSession(
			agentId,
			options,
		);
		const result = await this.spawnAgentHarness({
			resume: true,
			metadata,
			model: sourceRecord.model,
		});
		return {
			agentId: result.agentId,
			snapshot: this.inspectAgent(result.agentId),
		};
	}

	async listAgentSessions(): Promise<AgentSessionListResult> {
		return {
			sessions: await this.sessionManager.listAgentSessionCandidates(),
		};
	}

	async resumeAgentSessionByReference(
		reference: string,
	): Promise<AgentSessionCommandResult> {
		const metadata =
			await this.sessionManager.resolveAgentSessionReference(reference);
		const result = await this.spawnAgentHarness({
			resume: true,
			metadata,
		});
		return {
			agentId: result.agentId,
			snapshot: this.inspectAgent(result.agentId),
		};
	}

	async recordExtensionDiagnostics(
		agentId: AgentId,
		diagnostics: readonly OrchestratorDiagnostic[],
	): Promise<void> {
		await this._recordAndPublishExtensionDiagnostics(agentId, diagnostics);
	}

	getAgentModel(agentId: AgentId): RuntimeModel {
		return this._requireAgentRecord(agentId).model;
	}

	async setAgentModel(agentId: AgentId, model: RuntimeModel): Promise<void> {
		await this._requireAgentHarness(agentId).setModel(model);
		this._requireAgentRecord(agentId).model = model;
	}

	async listAvailableModelCandidates(): Promise<AgentModelCandidateListResult> {
		const models = await this.modelRegistry.getAvailable();
		return {
			models: models.map((model) => ({
				value: modelReference(model),
				label: model.name,
				description: modelReference(model),
			})),
		};
	}

	async setAgentModelByReference(
		agentId: AgentId,
		reference: string,
	): Promise<RuntimeModel> {
		const parsed = parseModelReference(reference);
		if (!parsed) {
			throw new OrchestratorError(
				createOrchestratorDiagnostic({
					severity: "error",
					code: "model.reference_invalid",
					message: `Model reference must use provider/model syntax: ${reference}`,
					source: { kind: "registry", name: "model", key: reference },
					agentId,
					phase: "runtime",
					recoverable: true,
				}),
			);
		}
		const models = await this.modelRegistry.getAvailable();
		const model = models.find(
			(candidate) =>
				candidate.provider === parsed.provider &&
				candidate.id === parsed.modelId,
		);
		if (!model) {
			throw new OrchestratorError(
				createOrchestratorDiagnostic({
					severity: "error",
					code: "model.not_available",
					message: `Model is not available: ${parsed.provider}/${parsed.modelId}`,
					source: {
						kind: "registry",
						name: "model",
						key: `${parsed.provider}/${parsed.modelId}`,
					},
					agentId,
					provider: parsed.provider,
					modelId: parsed.modelId,
					phase: "runtime",
					recoverable: true,
				}),
			);
		}
		await this.setAgentModel(agentId, model);
		return model;
	}

	listAgentThinkingLevelCandidates(
		agentId: AgentId,
	): AgentThinkingLevelCandidateListResult {
		const record = this._requireAgentRecord(agentId);
		return {
			levels: this._getAgentThinkingLevelCandidates(record),
		};
	}

	async setAgentThinkingLevel(
		agentId: AgentId,
		level: ThinkingLevel,
	): Promise<void> {
		const record = this._requireAgentRecord(agentId);
		if (!record.model.reasoning) {
			throw new OrchestratorError(
				this._createAgentThinkingNotSupportedDiagnostic(record),
			);
		}
		const supportedLevels = getSupportedThinkingLevels(record.model);
		if (!supportedLevels.includes(level)) {
			throw new OrchestratorError(
				createOrchestratorDiagnostic({
					severity: "error",
					code: "model.thinking_level_not_supported",
					message: `Thinking level ${level} is not supported by model ${record.model.provider}/${record.model.id}.`,
					source: { kind: "registry", name: "model", key: "thinkingLevel" },
					agentId,
					provider: record.model.provider,
					modelId: record.model.id,
					phase: "runtime",
					recoverable: true,
					details: { level, supportedLevels },
				}),
			);
		}
		await this._requireAgentHarness(agentId).setThinkingLevel(level);
	}

	async setAgentThinkingLevelByName(
		agentId: AgentId,
		levelName: string,
	): Promise<AgentThinkingLevelCommandResult> {
		const level = parseThinkingLevel(levelName);
		if (!level) {
			throw new OrchestratorError(
				createOrchestratorDiagnostic({
					severity: "error",
					code: "model.thinking_level_invalid",
					message: `Invalid thinking level: ${levelName}`,
					source: { kind: "registry", name: "model", key: "thinkingLevel" },
					agentId,
					phase: "runtime",
					recoverable: true,
					details: { level: levelName, supportedLevels: THINKING_LEVELS },
				}),
			);
		}
		await this.setAgentThinkingLevel(agentId, level);
		return { level };
	}

	getAgentTools(agentId: AgentId): AgentToolsSnapshot {
		const state = this._requireAgentToolSet(agentId);
		return {
			toolNames: [...state.toolNames],
			activeToolNames: [...state.activeToolNames],
		};
	}

	async setAgentTools(
		agentId: AgentId,
		toolNames: string[],
		activeToolNames?: string[],
	): Promise<void> {
		const harness = this._requireAgentHarness(agentId) as AgentHarness &
			Partial<AgentToolSetHarness>;
		const currentState = this._requireAgentToolSet(agentId);
		const next = await this._resolveAgentTools({
			agentId,
			profileId: currentState.profileId,
			requestedToolNames: toolNames,
			activeToolSelection:
				activeToolNames === undefined
					? { mode: "default_all" }
					: { mode: "explicit", toolNames: activeToolNames },
		});
		await harness.setTools?.(next.tools, [...next.activeToolNames]);
		this._setAgentToolSet(agentId, next);
	}

	getAgentActiveTools(agentId: AgentId): string[] {
		return [...this._requireAgentToolSet(agentId).activeToolNames];
	}

	async setAgentActiveTools(
		agentId: AgentId,
		toolNames: string[],
	): Promise<void> {
		const harness = this._requireAgentHarness(agentId) as AgentHarness &
			Partial<AgentToolSetHarness>;
		const currentState = this._requireAgentToolSet(agentId);
		const next = await this._resolveAgentTools({
			agentId,
			profileId: currentState.profileId,
			requestedToolNames: currentState.requestedToolNames,
			activeToolSelection: { mode: "explicit", toolNames },
		});
		await harness.setTools?.(next.tools, [...next.activeToolNames]);
		this._setAgentToolSet(agentId, next);
	}

	async inputAgent(
		agentId: AgentId,
		text: string,
		options?: { images?: ImageContent[]; commands?: boolean },
	): Promise<InputResult> {
		const record = this._requireAgentRecord(agentId);
		// Command parsing can be turned off per call or by profile policy;
		// either way the input goes to the agent as a plain prompt.
		if (
			options?.commands === false ||
			record.commandPolicy?.enabled === false
		) {
			return {
				kind: "prompt",
				message: await this.promptAgent(agentId, text, {
					images: options?.images ? [...options.images] : undefined,
				}),
			};
		}

		const parsed = parseLineCommand(
			text,
			this._getLineCommandTriggers(agentId),
		);
		const command = parsed ? this._findLineCommand(agentId, parsed) : undefined;
		if (!parsed || !command) {
			return {
				kind: "prompt",
				message: await this.promptAgent(agentId, text, {
					images: options?.images ? [...options.images] : undefined,
				}),
			};
		}

		const commandId = this._createCommandId();
		const invocation: CommandInvocation = {
			name: command.command.name,
			trigger: command.command.trigger,
			argument: parsed.argument,
			source: command.command.source,
			placement: command.command.placement,
		};
		await this._emit({
			type: "command_detected",
			commandId,
			command: invocation,
			createdAt: now(),
		});

		// Gateway: rejected before execution, guaranteed side-effect free.
		const gatewayDiagnostic = this._commandGateway(record, command, commandId);
		if (gatewayDiagnostic) {
			await this._emit({
				type: "command_rejected",
				commandId,
				command: invocation,
				diagnostic: gatewayDiagnostic,
				completedAt: now(),
			});
			await this._publishDiagnostic(gatewayDiagnostic);
			return { kind: "rejected", commandId, diagnostic: gatewayDiagnostic };
		}

		// Argument check: a declared-required argument that is missing rejects
		// the command instead of degrading the input to a plain prompt.
		// TODO(argumentsCompletion): request completion from a client first.
		if (command.command.arguments?.required && !parsed.argument.trim()) {
			const diagnostic = createOrchestratorDiagnostic({
				severity: "error",
				code: "command.arguments_required",
				message: `Command ${command.command.trigger}${command.command.name} requires an argument.`,
				operationSource: { kind: "human" },
				agentId,
				commandId,
				recoverable: true,
			});
			await this._emit({
				type: "command_rejected",
				commandId,
				command: invocation,
				diagnostic,
				completedAt: now(),
			});
			await this._publishDiagnostic(diagnostic);
			return { kind: "rejected", commandId, diagnostic };
		}

		await this._emit({
			type: "command_accepted",
			commandId,
			command: invocation,
			createdAt: now(),
		});

		try {
			const value = await command.execute(parsed.argument);
			await this._emit({
				type: "command_completed",
				commandId,
				command: invocation,
				result: value,
				completedAt: now(),
			});
			return { kind: "command", commandId, name: command.command.name, value };
		} catch (error) {
			const diagnostic = toDiagnostic(error, {
				code: "orchestrator.command_failed",
				message: error instanceof Error ? error.message : String(error),
				operationSource: { kind: "human" },
				agentId,
				commandId,
				recoverable: true,
			});
			await this._emit({
				type: "command_failed",
				commandId,
				command: invocation,
				diagnostic,
				completedAt: now(),
			});
			await this._publishDiagnostic(diagnostic);
			return { kind: "failed", commandId, diagnostic };
		}
	}

	async promptAgent(
		agentId: AgentId,
		text: string,
		options?: { images?: ImageContent[] },
	) {
		return await this._runHarnessOperation(agentId, async (harness) => {
			return await harness.prompt(text, options);
		});
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
		await this._runHarnessOperation(agentId, async (harness) => {
			await harness.nextTurn(text, options);
		});
	}

	async abortAgent(agentId: AgentId) {
		return await this._requireAgentHarness(agentId).abort();
	}

	async disposeAgent(agentId: AgentId, reason?: string): Promise<void> {
		const record = this._requireAgentRecord(agentId);
		const harness = record.harness;
		if (harness) {
			await this._disposeAgentHarness(agentId, harness);
		}

		const unsubscribe = this._unsubscribeAgentHarness.get(agentId);
		if (unsubscribe) {
			try {
				unsubscribe();
			} catch (error) {
				await this._recordAgentLifecycleFailure(
					agentId,
					"orchestrator.agent_dispose_failed",
					`Failed to unsubscribe agent ${agentId} harness handlers: ${formatError(error)}`,
					error,
				);
			}
			this._unsubscribeAgentHarness.delete(agentId);
		}
		const unsubscribeExtensionInterceptors =
			this._unsubscribeAgentExtensionInterceptors.get(agentId);
		if (unsubscribeExtensionInterceptors) {
			try {
				unsubscribeExtensionInterceptors();
			} catch (error) {
				await this._recordAgentLifecycleFailure(
					agentId,
					"orchestrator.agent_dispose_failed",
					`Failed to unsubscribe agent ${agentId} extension interceptors: ${formatError(error)}`,
					error,
				);
			}
			this._unsubscribeAgentExtensionInterceptors.delete(agentId);
		}

		record.extensionRunner?.invalidate("Agent has been disposed.");
		delete record.harness;
		this._agentToolSets.delete(agentId);
		this._forgetAllStreamingToolCalls(agentId);
		await this._cancelHumanRequestsForAgent(
			agentId,
			reason ?? `Agent disposed: ${agentId}`,
		);
		this._forceAgentStatus(agentId, "disposed");
	}

	async disposeAll(reason?: string): Promise<void> {
		for (const agentId of [...this.agents.keys()]) {
			await this.disposeAgent(agentId, reason);
		}
		await this._cancelAllHumanRequests(reason ?? "Orchestrator disposed.");
		this._streamingToolCalls.clear();
		try {
			await this.executionEnv.cleanup();
		} catch (error) {
			await this._publishDiagnostic(
				createOrchestratorDiagnostic({
					severity: "warning",
					disposition: "reported",
					code: "orchestrator.dispose_all_failed",
					message: `Failed to cleanup execution environment: ${formatError(error)}`,
					phase: "runtime",
					recoverable: true,
				}),
			);
		}
	}

	async reloadExtensions(
		options: { agentIds?: readonly AgentId[] } = {},
	): Promise<ExtensionReloadResult> {
		const catalog = await this.extensionLoader.reloadAvailableExtensions(
			this.executionEnv,
		);
		await this._publishDiagnostics(catalog.diagnostics);

		const agentIds = options.agentIds
			? [...new Set(options.agentIds)]
			: [...this.agents.keys()];
		const agents: ExtensionReloadAgentResult[] = [];
		for (const agentId of agentIds) {
			agents.push(await this._reloadAgentExtensions(agentId));
		}

		return {
			catalog: {
				loaded: [...catalog.loaded],
				diagnostics: [...catalog.diagnostics],
			},
			agents,
		};
	}

	async compactAgent(agentId: AgentId, customInstructions?: string) {
		return await this._runHarnessOperation(agentId, async (harness) => {
			return await harness.compact(customInstructions);
		});
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
		return await this._runHarnessOperation(agentId, async (harness) => {
			return await harness.navigateTree(targetId, options);
		});
	}

	registerClient(client: OrchestratorClient<OrchestratorEvent>): () => void {
		this._clients.set(client.id, client);
		return () => {
			if (this._clients.get(client.id) === client) {
				this._clients.delete(client.id);
			}
		};
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
				agentId: agentIdFromOperationSource(request.source),
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
			const sourceRecord = this.agents.get(options.inheritModelFromAgentId);
			if (!sourceRecord) {
				throw new Error(
					`Cannot inherit model from unknown agent: ${options.inheritModelFromAgentId}`,
				);
			}
			return sourceRecord.model;
		}

		return this._defaultModel;
	}

	private async _resolveCreateProfile(
		options: SpawnAgentHarnessCreateOptions,
	): Promise<ResolvedAgentProfile> {
		const profileId = options.profileId ?? this._defaultProfileId;
		const resolvedProfile = await this._resolveProfileById(
			profileId,
			undefined,
		);
		return {
			...resolvedProfile,
			profile: await this._applyProfileOverride(
				resolvedProfile.profile,
				options.profileOverride,
			),
		};
	}

	private async _resolveResumeProfile(
		agentId: AgentId,
		metadata: ExtendedJsonlSessionMetadata,
	): Promise<ResolvedAgentProfile> {
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
	): Promise<ResolvedAgentProfile> {
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

		return {
			profile: result.profile,
			source: result.source,
			entryId: result.entryId,
		};
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
		resolvedProfile: ResolvedAgentProfile,
		model: RuntimeModel,
		options: { thinkingLevel?: ThinkingLevel } = {},
	): Promise<SpawnAgentHarnessResult> {
		const { profile } = resolvedProfile;
		const agentId = this._allocateAgentId(profile);
		const session = await this.sessionManager.createAgentSession({
			agentId: agentId,
			agentProfile: profile,
		});
		const sessionMetadata = await session.getMetadata();
		this.agents.set(
			agentId,
			this._createAgentRecord({
				agentId,
				status: "creating",
				resolvedProfile,
				sessionMetadata,
				model,
			}),
		);

		try {
			const harness = await this._buildAgentHarness({
				agentId,
				resolvedProfile,
				session,
				model,
				thinkingLevel: options.thinkingLevel,
			});
			await this._setAgentStatus(agentId, "ready");
			await this._emit({ type: "agent_spawned", agentId, profile, model });
			return { agentId, harness };
		} catch (error) {
			const diagnostic = toDiagnostic(error, {
				code: "orchestrator.agent_unavailable",
				message: `Cannot create agent ${agentId}: ${formatError(error)}`,
				agentId,
				profileId: profile.id,
				phase: "create",
				recoverable: true,
			});
			this._markExistingAgentUnavailable(agentId, diagnostic);
			if (!(error instanceof OrchestratorError)) {
				await this._publishDiagnostic(diagnostic);
			}
			throw error;
		}
	}

	private async _resumeAgentHarness(
		options: SpawnAgentHarnessResumeOptions,
	): Promise<SpawnAgentHarnessResult> {
		const agentId = options.metadata.id;
		const cachedRecord = this.agents.get(agentId);
		if (cachedRecord?.harness) {
			return { agentId, harness: cachedRecord.harness };
		}

		let resolvedProfile: ResolvedAgentProfile | undefined;
		let sessionMetadata: AgentSessionMetadata | undefined = options.metadata;
		let model = this._defaultModel;
		try {
			resolvedProfile = await this._resolveResumeProfile(
				agentId,
				options.metadata,
			);
			const { profile } = resolvedProfile;
			const session = await this.sessionManager.resumeAgentSession({
				agentId,
				metadata: options.metadata,
			});
			sessionMetadata = await session.getMetadata();
			const context = (await session.buildContext()) as Awaited<
				ReturnType<typeof session.buildContext>
			> & {
				activeToolNames?: string[] | null;
			};
			model = this._resolveResumeModel(options, context.model);
			this.agents.set(
				agentId,
				this._createAgentRecord({
					agentId,
					status: "creating",
					resolvedProfile,
					sessionMetadata,
					model,
				}),
			);
			const harness = await this._buildAgentHarness({
				agentId,
				resolvedProfile,
				session,
				model,
				thinkingLevel: this._resolveThinkingLevel(context.thinkingLevel),
				activeToolNames: context.activeToolNames ?? undefined,
			});

			await this._setAgentStatus(agentId, "ready");
			await this._emit({ type: "agent_resumed", agentId, profile, model });
			return { agentId, harness };
		} catch (error) {
			const diagnostic = toDiagnostic(error, {
				code: "orchestrator.agent_unavailable",
				message: `Cannot resume agent ${agentId}: ${formatError(error)}`,
				agentId,
				recoverable: true,
			});
			this._markAgentUnavailable({
				agentId,
				resolvedProfile,
				metadata: options.metadata,
				sessionMetadata,
				model,
				diagnostic,
			});
			await this._publishDiagnostic(diagnostic);
			throw error;
		}
	}

	private async _buildAgentHarness(options: {
		agentId: AgentId;
		resolvedProfile: ResolvedAgentProfile;
		session: Session<AgentSessionMetadata>;
		model: RuntimeModel;
		thinkingLevel?: ThinkingLevel;
		activeToolNames?: string[];
	}): Promise<AgentHarness> {
		const {
			agentId,
			resolvedProfile: { profile },
			session,
			model,
		} = options;
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
		const extensionRunner = await this._createExtensionRunner(agentId, profile);
		await this._publishDiagnostics(extensionRunner.diagnostics);
		this._addAgentDiagnostics(agentId, {
			resourceDiagnostics,
			extensionDiagnostics: [...extensionRunner.diagnostics],
		});
		this._requireAgentRecord(agentId).extensionRunner = extensionRunner;
		const blockedExtensionDiagnostic = extensionRunner.diagnostics.find(
			isBlockedExtensionDiagnostic,
		);
		if (blockedExtensionDiagnostic) {
			throw new OrchestratorError(blockedExtensionDiagnostic);
		}

		const agentToolSet = await this._resolveAgentTools({
			agentId,
			profileId: profile.id,
			requestedToolNames: profile.tools,
			activeToolSelection:
				options.activeToolNames === undefined
					? { mode: "default_all" }
					: { mode: "explicit", toolNames: options.activeToolNames },
		});

		const harness = new AgentHarness({
			env: this.executionEnv,
			session: session,
			models: this.modelRegistry.getRuntime(),
			resources: resources,
			tools: agentToolSet.tools,
			systemPrompt: profile.systemPrompt,
			model: model,
			thinkingLevel: options.thinkingLevel,
			activeToolNames: [...agentToolSet.activeToolNames],
		});
		this._requireAgentRecord(agentId).harness = harness;
		this._setAgentToolSet(agentId, agentToolSet);
		this._bindExtensionRunner(agentId, harness, extensionRunner);
		const unsubscribeInterceptors = this._registerExtensionInterceptors(
			agentId,
			harness,
			extensionRunner,
		);
		const unsubscribeHarnessEvents = harness.subscribe((event) => {
			void this._handleAgentHarnessEvent(agentId, event);
		});
		this._unsubscribeAgentHarness.set(agentId, unsubscribeHarnessEvents);
		this._unsubscribeAgentExtensionInterceptors.set(agentId, () => {
			for (const unsubscribe of unsubscribeInterceptors) {
				unsubscribe();
			}
		});
		return harness;
	}

	private async _createExtensionRunner(
		agentId: AgentId,
		profile: AgentProfile,
	): Promise<ExtensionRunner> {
		const loadedExtensionScope = await this.extensionLoader.loadForAgent({
			agentId,
			profileId: profile.id,
			extensionIds: profile.extensions,
			missingExtensionSeverity: profile.missingExtensionSeverity,
		});
		return new ExtensionRunner({
			loadedScope: loadedExtensionScope,
		});
	}

	private _bindExtensionRunner(
		agentId: AgentId,
		harness: AgentHarness,
		extensionRunner: ExtensionRunner,
	): void {
		extensionRunner.bindCore(this._createExtensionActions(), {
			getSignal: () => undefined,
			isIdle: () => this._requireAgentRecord(agentId).status !== "running",
			reportActionFailure: async (failure) => {
				const diagnostic = this._createExtensionActionFailureDiagnostic({
					agentId,
					profileId: extensionRunner.profileId,
					failure,
				});
				await this._recordAndPublishExtensionDiagnostics(agentId, [diagnostic]);
			},
			session: {
				appendEntry: async (extensionId, type, data) =>
					await this.sessionManager.appendExtensionCustomEntry(
						agentId,
						extensionId,
						type,
						data,
					),
				findEntries: async (extensionId, type) =>
					await this.sessionManager.findExtensionCustomEntries(
						agentId,
						extensionId,
						type,
					),
			},
		});
		extensionRunner.bindCommandContext({
			waitForIdle: async () => {
				await harness.waitForIdle();
			},
		});
	}

	private _registerExtensionInterceptors(
		agentId: AgentId,
		harness: AgentHarness,
		extensionRunner: ExtensionRunner,
	): Array<() => void> {
		return [
			harness.on(
				"before_agent_start",
				async (event) =>
					await this._runExtensionInterceptor<"before_agent_start">(
						agentId,
						extensionRunner,
						event,
					),
			),
			harness.on(
				"context",
				async (event) =>
					await this._runExtensionInterceptor<"context">(
						agentId,
						extensionRunner,
						event,
					),
			),
			harness.on(
				"tool_call",
				async (event) =>
					await this._runExtensionInterceptor<"tool_call">(
						agentId,
						extensionRunner,
						event,
					),
			),
			harness.on(
				"tool_result",
				async (event) =>
					await this._runExtensionInterceptor<"tool_result">(
						agentId,
						extensionRunner,
						event,
					),
			),
		];
	}

	private async _resolveAgentTools(options: {
		agentId: AgentId;
		profileId: string;
		requestedToolNames: readonly string[] | undefined;
		activeToolSelection?: ActiveToolSelection;
		extensionRunner?: ExtensionRunner;
	}): Promise<AgentToolSet> {
		const activeToolSelection = options.activeToolSelection ?? {
			mode: "default_all",
		};
		const activeToolNames =
			activeToolSelection.mode === "explicit"
				? activeToolSelection.toolNames
				: undefined;
		const toolRegistry = this._createScopedToolRegistry(
			options.agentId,
			options.extensionRunner,
		);
		const resolvedTools = toolRegistry.resolve({
			requestedToolNames: options.requestedToolNames,
			activeToolNames,
		});
		await this._publishDiagnostics(
			resolvedTools.diagnostics.map((diagnostic) => ({
				...diagnostic,
				agentId: options.agentId,
				profileId: options.profileId,
				phase: "resolve",
			})),
		);
		const agentTools = createAgentToolsFromResolvedTools(resolvedTools.tools, {
			human: {
				request: async (request) =>
					await this.requestHuman({
						...request,
						source: { kind: "agent", agentId: options.agentId },
					}),
			},
			createExtensionContext: (source) =>
				source.kind === "extension"
					? {
							extensionId: source.id,
							host: {
								agentId: options.agentId,
								profileId: options.profileId,
								actions: this._createExtensionActions(),
							},
						}
					: undefined,
		});
		return {
			tools: [...agentTools],
			toolNames: [...resolvedTools.toolNames],
			requestedToolNames: options.requestedToolNames
				? [...options.requestedToolNames]
				: undefined,
			activeToolNames: [...resolvedTools.activeToolNames],
			activeToolSelection:
				activeToolSelection.mode === "explicit"
					? {
							mode: "explicit",
							toolNames: [...resolvedTools.activeToolNames],
						}
					: { mode: "default_all" },
			profileId: options.profileId,
		};
	}

	private _createScopedToolRegistry(
		agentId: AgentId,
		extensionRunner?: ExtensionRunner,
	): ToolRegistry {
		const registry = this.toolRegistry.clone();
		(
			extensionRunner ?? this.agents.get(agentId)?.extensionRunner
		)?.contributeToolsTo(registry);
		return registry;
	}

	private _createExtensionActions(): ExtensionActions {
		return {
			getAgentTools: (agentId) => this.getAgentTools(agentId),
			setAgentTools: async (agentId, toolNames, activeToolNames) => {
				await this.setAgentTools(agentId, toolNames, activeToolNames);
			},
			setAgentActiveTools: async (agentId, toolNames) => {
				await this.setAgentActiveTools(agentId, toolNames);
			},
			requestHuman: async (request) => await this.requestHuman(request),
		};
	}

	private _createAgentRecord(options: {
		agentId: AgentId;
		status: AgentLifecycleStatus;
		resolvedProfile: ResolvedAgentProfile;
		sessionMetadata?: AgentSessionMetadata;
		model: RuntimeModel;
	}): AgentRecord {
		return {
			agentId: options.agentId,
			status: options.status,
			profile: {
				reference: toAgentProfileReference(options.resolvedProfile.profile),
				source: options.resolvedProfile.source,
				entryId: options.resolvedProfile.entryId,
			},
			capabilities: options.resolvedProfile.profile.capabilities,
			commandPolicy: options.resolvedProfile.profile.commands,
			sessionMetadata: options.sessionMetadata,
			model: options.model,
			resourceDiagnostics: [],
			extensionDiagnostics: [],
			diagnostics: [],
		};
	}

	private _createAgentRecordFromProfileReference(options: {
		agentId: AgentId;
		status: AgentLifecycleStatus;
		profile: AgentProfileRecordReference;
		capabilities?: AgentProfile["capabilities"];
		commandPolicy?: AgentProfileCommandPolicy;
		sessionMetadata?: AgentSessionMetadata;
		model: RuntimeModel;
	}): AgentRecord {
		return {
			agentId: options.agentId,
			status: options.status,
			profile: options.profile,
			capabilities: options.capabilities,
			commandPolicy: options.commandPolicy,
			sessionMetadata: options.sessionMetadata,
			model: options.model,
			resourceDiagnostics: [],
			extensionDiagnostics: [],
			diagnostics: [],
		};
	}

	private _markAgentUnavailable(options: {
		agentId: AgentId;
		resolvedProfile: ResolvedAgentProfile | undefined;
		metadata: ExtendedJsonlSessionMetadata;
		sessionMetadata?: AgentSessionMetadata;
		model: RuntimeModel;
		diagnostic: OrchestratorDiagnostic;
	}): void {
		const existing = this.agents.get(options.agentId);
		const profile = options.resolvedProfile
			? {
					reference: toAgentProfileReference(options.resolvedProfile.profile),
					source: options.resolvedProfile.source,
					entryId: options.resolvedProfile.entryId,
				}
			: {
					reference: options.metadata.metadata?.profile ?? {
						id: "unknown",
					},
				};
		this.agents.set(options.agentId, {
			...this._createAgentRecordFromProfileReference({
				agentId: options.agentId,
				status: "unavailable",
				profile,
				capabilities: options.resolvedProfile?.profile.capabilities,
				commandPolicy: options.resolvedProfile?.profile.commands,
				sessionMetadata: options.sessionMetadata,
				model: options.model,
			}),
			resourceDiagnostics: existing?.resourceDiagnostics
				? [...existing.resourceDiagnostics]
				: [],
			extensionDiagnostics: existing?.extensionDiagnostics
				? [...existing.extensionDiagnostics]
				: [],
			diagnostics: [...(existing?.diagnostics ?? []), options.diagnostic],
		});
		this._agentToolSets.delete(options.agentId);
		this._forgetAllStreamingToolCalls(options.agentId);
	}

	private _markExistingAgentUnavailable(
		agentId: AgentId,
		diagnostic: OrchestratorDiagnostic,
	): void {
		const record = this.agents.get(agentId);
		if (!record) return;
		delete record.harness;
		record.status = "unavailable";
		if (!record.diagnostics.includes(diagnostic)) {
			record.diagnostics.push(diagnostic);
		}
		if (
			diagnostic.domain === "extension" &&
			!record.extensionDiagnostics.includes(diagnostic)
		) {
			record.extensionDiagnostics.push(diagnostic);
		}
		this._agentToolSets.delete(agentId);
		this._forgetAllStreamingToolCalls(agentId);
	}

	private _snapshotAgentRecord(record: AgentRecord): AgentRecordSnapshot {
		return {
			agentId: record.agentId,
			status: record.status,
			profile: { ...record.profile },
			sessionMetadata: record.sessionMetadata,
			model: record.model,
			hasHarness: record.harness !== undefined,
			toolSnapshot: record.toolSnapshot
				? {
						toolNames: [...record.toolSnapshot.toolNames],
						activeToolNames: [...record.toolSnapshot.activeToolNames],
					}
				: undefined,
			extensionIds: record.extensionRunner
				? [...record.extensionRunner.extensionIds]
				: [],
			extensions: record.extensionRunner
				? [...record.extensionRunner.extensions]
				: [],
			extensionSnapshot: record.extensionRunner
				? record.extensionRunner.inspect()
				: createEmptyExtensionSnapshot(),
			resourceDiagnostics: [...record.resourceDiagnostics],
			extensionDiagnostics: [...record.extensionDiagnostics],
			diagnostics: [...record.diagnostics],
		};
	}

	private _requireAgentRecord(agentId: AgentId): AgentRecord {
		const record = this.agents.get(agentId);
		if (!record) {
			throw new Error(`Unknown agent: ${agentId}`);
		}
		return record;
	}

	private _setAgentToolSet(agentId: AgentId, toolSet: AgentToolSet): void {
		const record = this._requireAgentRecord(agentId);
		this._agentToolSets.set(agentId, toolSet);
		record.toolSnapshot = {
			toolNames: [...toolSet.toolNames],
			activeToolNames: [...toolSet.activeToolNames],
		};
	}

	private _addAgentDiagnostics(
		agentId: AgentId,
		diagnostics: {
			resourceDiagnostics?: readonly OrchestratorDiagnostic[];
			extensionDiagnostics?: readonly OrchestratorDiagnostic[];
			diagnostics?: readonly OrchestratorDiagnostic[];
		},
	): void {
		const record = this.agents.get(agentId);
		if (!record) return;
		const resourceDiagnostics = diagnostics.resourceDiagnostics ?? [];
		const extensionDiagnostics = diagnostics.extensionDiagnostics ?? [];
		const generalDiagnostics = diagnostics.diagnostics ?? [];
		record.resourceDiagnostics.push(...resourceDiagnostics);
		record.extensionDiagnostics.push(...extensionDiagnostics);
		record.diagnostics.push(
			...resourceDiagnostics,
			...extensionDiagnostics,
			...generalDiagnostics,
		);
	}

	private async _recordAgentLifecycleFailure(
		agentId: AgentId,
		code: string,
		message: string,
		error: unknown,
	): Promise<void> {
		const diagnostic = createOrchestratorDiagnostic({
			severity: "warning",
			disposition: "reported",
			code,
			message,
			agentId,
			phase: "runtime",
			recoverable: true,
			details: {
				error: formatError(error),
			},
		});
		this._addAgentDiagnostics(agentId, {
			diagnostics: [diagnostic],
		});
		await this._publishDiagnostic(diagnostic);
	}

	private async _recordAndPublishExtensionDiagnostics(
		agentId: AgentId,
		diagnostics: readonly OrchestratorDiagnostic[],
	): Promise<void> {
		this._addAgentDiagnostics(agentId, {
			extensionDiagnostics: diagnostics,
		});
		await this._publishDiagnostics(diagnostics);
	}

	private async _runExtensionInterceptor<
		TName extends ExtensionInterceptorName,
	>(
		agentId: AgentId,
		extensionRunner: ExtensionRunner,
		event: ExtensionInterceptorEventFor<TName>,
	): Promise<ExtensionInterceptorResultFor<TName>> {
		const run = await extensionRunner.interceptWithDiagnostics(event);
		await this._recordAndPublishExtensionDiagnostics(agentId, run.diagnostics);
		return run.result;
	}

	private _createExtensionActionFailureDiagnostic(options: {
		agentId: AgentId;
		profileId: string;
		failure: ExtensionActionFailure;
	}): OrchestratorDiagnostic {
		const { failure } = options;
		return createOrchestratorDiagnostic({
			domain: "extension",
			code: failure.code,
			severity: "warning",
			disposition: "degraded",
			recoverable: true,
			message: `Extension '${failure.extensionId}' action '${failure.action}' failed: ${formatError(failure.error)}`,
			source: { kind: "extension", id: failure.extensionId },
			phase: "runtime",
			agentId: options.agentId,
			profileId: options.profileId,
			extensionId: failure.extensionId,
			details: {
				action: failure.action,
				error: formatError(failure.error),
			},
		});
	}

	private async _reloadAgentExtensions(
		agentId: AgentId,
	): Promise<ExtensionReloadAgentResult> {
		const record = this.agents.get(agentId);
		if (!record) {
			const diagnostic = this._createExtensionReloadDiagnostic({
				code: "extension.reload_agent_failed",
				severity: "warning",
				message: `Cannot reload extensions for unknown agent: ${agentId}`,
				agentId,
			});
			await this._publishDiagnostic(diagnostic);
			return {
				agentId,
				status: "failed",
				reason: "unknown_agent",
				diagnostics: [diagnostic],
			};
		}

		const before = this._snapshotAgentRecord(record);
		const skipReason = this._extensionReloadSkipReason(record);
		if (skipReason) {
			const diagnostic = this._createExtensionReloadDiagnostic({
				code: "extension.reload_agent_skipped",
				severity: "warning",
				message: `Skipped extension reload for agent ${agentId}: ${skipReason}.`,
				agentId,
			});
			this._addAgentDiagnostics(agentId, {
				extensionDiagnostics: [diagnostic],
			});
			await this._publishDiagnostic(diagnostic);
			return {
				agentId,
				status: "skipped",
				reason: skipReason,
				diagnostics: [diagnostic],
				before,
				after: this._snapshotAgentRecord(record),
			};
		}

		try {
			const harness = record.harness as AgentHarness &
				Partial<AgentToolSetHarness>;
			const currentToolSet = this._requireAgentToolSet(agentId);
			const oldRunner = record.extensionRunner;
			const resolvedProfile = await this._resolveProfileById(
				record.profile.reference.id,
				agentId,
			);
			const nextRunner = await this._createExtensionRunner(
				agentId,
				resolvedProfile.profile,
			);
			const nextToolSet = await this._resolveAgentTools({
				agentId,
				profileId: resolvedProfile.profile.id,
				requestedToolNames: currentToolSet.requestedToolNames,
				activeToolSelection:
					currentToolSet.activeToolSelection.mode === "explicit"
						? {
								mode: "explicit",
								toolNames: currentToolSet.activeToolNames,
							}
						: { mode: "default_all" },
				extensionRunner: nextRunner,
			});

			this._bindExtensionRunner(agentId, harness, nextRunner);
			await harness.setTools?.(nextToolSet.tools, [
				...nextToolSet.activeToolNames,
			]);

			const unsubscribeOldInterceptors =
				this._unsubscribeAgentExtensionInterceptors.get(agentId);
			unsubscribeOldInterceptors?.();
			this._unsubscribeAgentExtensionInterceptors.delete(agentId);
			const unsubscribeInterceptors = this._registerExtensionInterceptors(
				agentId,
				harness,
				nextRunner,
			);
			this._unsubscribeAgentExtensionInterceptors.set(agentId, () => {
				for (const unsubscribe of unsubscribeInterceptors) {
					unsubscribe();
				}
			});
			record.extensionRunner = nextRunner;
			record.extensionDiagnostics = [...nextRunner.diagnostics];
			record.diagnostics.push(...nextRunner.diagnostics);
			this._setAgentToolSet(agentId, nextToolSet);
			oldRunner?.invalidate("Extension runtime has been reloaded.");
			const staleBefore = oldRunner
				? {
						...before,
						extensionSnapshot: oldRunner.inspect(),
					}
				: before;
			await this._publishDiagnostics(nextRunner.diagnostics);

			return {
				agentId,
				status: "reloaded",
				diagnostics: [...nextRunner.diagnostics],
				before: staleBefore,
				after: this._snapshotAgentRecord(record),
			};
		} catch (error) {
			const diagnostic = this._createExtensionReloadDiagnostic({
				code: "extension.reload_agent_failed",
				severity: "error",
				message: `Failed to reload extensions for agent ${agentId}: ${formatError(error)}`,
				agentId,
				details: { error: formatError(error) },
			});
			this._addAgentDiagnostics(agentId, {
				extensionDiagnostics: [diagnostic],
			});
			await this._publishDiagnostic(diagnostic);
			return {
				agentId,
				status: "failed",
				diagnostics: [diagnostic],
				before,
				after: this._snapshotAgentRecord(record),
			};
		}
	}

	private _extensionReloadSkipReason(
		record: AgentRecord,
	): ExtensionReloadAgentSkipReason | undefined {
		if (record.status === "creating") return "creating";
		if (record.status === "running") return "running";
		if (record.status === "disposed") return "disposed";
		if (record.status === "unavailable") return "unavailable";
		if (!record.harness) return "missing_harness";
		return undefined;
	}

	private _createExtensionReloadDiagnostic(options: {
		code: "extension.reload_agent_failed" | "extension.reload_agent_skipped";
		severity: OrchestratorDiagnostic["severity"];
		message: string;
		agentId: AgentId;
		details?: Record<string, unknown>;
	}): OrchestratorDiagnostic {
		return createOrchestratorDiagnostic({
			domain: "extension",
			severity: options.severity,
			disposition: options.severity === "error" ? "degraded" : "reported",
			code: options.code,
			message: options.message,
			agentId: options.agentId,
			phase: "runtime",
			recoverable: true,
			source: { kind: "extension", id: "reload" },
			details: options.details,
		});
	}

	private _setAgentStatus(
		agentId: AgentId,
		status: AgentLifecycleStatus,
	): void {
		const record = this._requireAgentRecord(agentId);
		if (record.status === "disposed" || record.status === "unavailable") {
			return;
		}
		record.status = status;
	}

	private _forceAgentStatus(
		agentId: AgentId,
		status: AgentLifecycleStatus,
	): void {
		this._requireAgentRecord(agentId).status = status;
	}

	private async _disposeAgentHarness(
		agentId: AgentId,
		harness: AgentHarness,
	): Promise<void> {
		try {
			await harness.abort();
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.agent_dispose_failed",
				`Failed to abort agent ${agentId} during dispose: ${formatError(error)}`,
				error,
			);
		}
		try {
			await harness.waitForIdle();
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.agent_dispose_failed",
				`Failed waiting for agent ${agentId} to become idle during dispose: ${formatError(error)}`,
				error,
			);
		}
	}

	private async _cancelHumanRequestsForAgent(
		agentId: AgentId,
		reason: string,
	): Promise<void> {
		for (const [requestId, pending] of [...this._pendingHumanRequests]) {
			if (pending.agentId !== agentId) continue;
			try {
				await pending.cancel(reason);
			} catch (error) {
				await this._recordAgentLifecycleFailure(
					agentId,
					"orchestrator.agent_dispose_failed",
					`Failed to cancel human request ${requestId} for agent ${agentId}: ${formatError(error)}`,
					error,
				);
			}
			this._pendingHumanRequests.delete(requestId);
		}
	}

	private async _cancelAllHumanRequests(reason: string): Promise<void> {
		for (const [requestId, pending] of [...this._pendingHumanRequests]) {
			try {
				await pending.cancel(reason);
			} catch (error) {
				await this._publishDiagnostic(
					createOrchestratorDiagnostic({
						severity: "warning",
						disposition: "reported",
						code: "orchestrator.dispose_all_failed",
						message: `Failed to cancel human request ${requestId}: ${formatError(error)}`,
						requestId,
						phase: "runtime",
						recoverable: true,
					}),
				);
			}
			this._pendingHumanRequests.delete(requestId);
		}
	}

	private async _runHarnessOperation<T>(
		agentId: AgentId,
		operation: (harness: AgentHarness) => Promise<T>,
	): Promise<T> {
		const harness = this._requireAgentHarness(agentId);
		this._setAgentStatus(agentId, "running");
		try {
			return await operation(harness);
		} finally {
			if (this._requireAgentRecord(agentId).status === "running") {
				this._setAgentStatus(agentId, "idle");
			}
		}
	}

	private _updateAgentStatusFromHarnessEvent(
		agentId: AgentId,
		event: AgentHarnessEvent,
	): void {
		if (event.type === "agent_start" || event.type === "turn_start") {
			this._setAgentStatus(agentId, "running");
			return;
		}
		if (
			event.type === "agent_end" ||
			event.type === "turn_end" ||
			event.type === "abort" ||
			event.type === "settled"
		) {
			this._setAgentStatus(agentId, "idle");
		}
	}

	private _requireAgentHarness(agentId: AgentId): AgentHarness {
		const harness = this._requireAgentRecord(agentId).harness;
		if (!harness) {
			throw new Error(`Unknown agent: ${agentId}`);
		}
		return harness;
	}

	private _requireAgentToolSet(agentId: AgentId): AgentToolSet {
		this._requireAgentRecord(agentId);
		const state = this._agentToolSets.get(agentId);
		if (!state) {
			throw new Error(`Unknown agent tool state: ${agentId}`);
		}
		return state;
	}

	private async _handleAgentHarnessEvent(
		agentId: AgentId,
		event: AgentHarnessEvent,
	): Promise<void> {
		await this._updateAgentStatusFromHarnessEvent(agentId, event);
		await this._emit({ type: "agent_harness_event", agentId, event });
		const extensionRunner = this.agents.get(agentId)?.extensionRunner;
		if (extensionRunner) {
			const diagnostics = await extensionRunner.emitObserved({
				type: "agent_harness_event",
				agentId,
				event,
			});
			await this._recordAndPublishExtensionDiagnostics(agentId, diagnostics);
		}
		const lifecycleEvent = this._toToolLifecycleEvent(agentId, event);
		if (lifecycleEvent) {
			await this._emit({
				type: "tool_lifecycle_event",
				agentId,
				event: lifecycleEvent,
			});
			if (extensionRunner) {
				const diagnostics = await extensionRunner.emitObserved({
					type: "tool_lifecycle_event",
					agentId,
					event: lifecycleEvent,
				});
				await this._recordAndPublishExtensionDiagnostics(agentId, diagnostics);
			}
		}
	}

	private _toToolLifecycleEvent(
		agentId: AgentId,
		event: AgentHarnessEvent,
	): ToolLifecycleEvent | undefined {
		if (event.type === "message_update") {
			const assistantEvent = event.assistantMessageEvent;
			if (assistantEvent.type === "toolcall_start") {
				const ref = this._rememberStreamingToolCall(agentId, {
					contentIndex: assistantEvent.contentIndex,
					...streamingToolCallRefFromPartial(
						assistantEvent.partial,
						assistantEvent.contentIndex,
					),
				});
				return {
					type: "tool_call_created",
					contentIndex: assistantEvent.contentIndex,
					toolCallId: ref.toolCallId,
					toolName: ref.toolName,
				};
			}
			if (assistantEvent.type === "toolcall_delta") {
				const ref = this._getStreamingToolCall(
					agentId,
					assistantEvent.contentIndex,
				);
				return {
					type: "arguments_delta",
					contentIndex: assistantEvent.contentIndex,
					delta: assistantEvent.delta,
					toolCallId: ref?.toolCallId,
					toolName: ref?.toolName,
				};
			}
			if (assistantEvent.type === "toolcall_end") {
				this._forgetStreamingToolCall(agentId, assistantEvent.contentIndex);
				return {
					type: "arguments_ready",
					contentIndex: assistantEvent.contentIndex,
					toolCallId: assistantEvent.toolCall.id,
					toolName: assistantEvent.toolCall.name,
					args: assistantEvent.toolCall.arguments,
				};
			}
			return undefined;
		}

		if (
			event.type === "message_end" ||
			event.type === "turn_end" ||
			event.type === "agent_end"
		) {
			this._forgetAllStreamingToolCalls(agentId);
			return undefined;
		}

		if (event.type === "tool_execution_start") {
			return {
				type: "execution_started",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
		}

		if (event.type === "tool_execution_update") {
			return {
				type: "execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				partialResult: event.partialResult,
			};
		}

		if (event.type === "tool_execution_end") {
			return {
				type: "execution_result",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
		}

		return undefined;
	}

	private _rememberStreamingToolCall(
		agentId: AgentId,
		ref: StreamingToolCallRef & { contentIndex: number },
	): StreamingToolCallRef {
		let refs = this._streamingToolCalls.get(agentId);
		if (!refs) {
			refs = new Map<number, StreamingToolCallRef>();
			this._streamingToolCalls.set(agentId, refs);
		}
		const next = {
			toolCallId: ref.toolCallId,
			toolName: ref.toolName,
		};
		refs.set(ref.contentIndex, next);
		return next;
	}

	private _getStreamingToolCall(
		agentId: AgentId,
		contentIndex: number,
	): StreamingToolCallRef | undefined {
		return this._streamingToolCalls.get(agentId)?.get(contentIndex);
	}

	private _forgetStreamingToolCall(
		agentId: AgentId,
		contentIndex: number,
	): void {
		const refs = this._streamingToolCalls.get(agentId);
		if (!refs) return;
		refs.delete(contentIndex);
		if (refs.size === 0) {
			this._streamingToolCalls.delete(agentId);
		}
	}

	private _forgetAllStreamingToolCalls(agentId: AgentId): void {
		this._streamingToolCalls.delete(agentId);
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
	private _createHumanRequestId(): string {
		const id = `human-request-${this._nextHumanRequestId}`;
		this._nextHumanRequestId += 1;
		return id;
	}

	private _createCommandId(): string {
		const id = `orchestrator-command-${this._nextCommandId}`;
		this._nextCommandId += 1;
		return id;
	}

	// Command input path
	private _findLineCommand(
		agentId: AgentId,
		parsed: ParsedLineCommand,
	): LineCommandBinding | undefined {
		const builtIn = BUILT_IN_COMMANDS.find(
			(binding) =>
				binding.command.placement === "line" &&
				binding.command.trigger === parsed.trigger &&
				binding.command.name === parsed.name,
		);
		if (builtIn) {
			return {
				command: builtIn.command,
				checkStatus: builtIn.checkStatus,
				execute: async (args) => await builtIn.execute(this, agentId, args),
			};
		}

		const extensionCommand = this._requireAgentRecord(
			agentId,
		).extensionRunner?.getCommand(
			{ placement: "line", trigger: parsed.trigger, name: parsed.name },
			{
				reservedCommands: getBuiltInCommands(),
			},
		);
		if (!extensionCommand) return undefined;
		return {
			command: extensionCommand.command,
			execute: async (args) => {
				const runner = this._requireAgentRecord(agentId).extensionRunner;
				if (!runner) return undefined;
				await extensionCommand.handler(
					args,
					runner.createCommandContext(extensionCommand.extensionId),
				);
				return undefined;
			},
		};
	}

	private _withCommandAvailability(
		record: AgentRecord,
		command: Command,
		checkStatus?: CommandStatusCheck,
	): Command {
		const unavailableReason = checkStatus?.(record.status);
		if (!unavailableReason) return { ...command, available: true };
		return { ...command, available: false, unavailableReason };
	}

	private _getAgentThinkingLevelCandidates(
		record: AgentRecord,
	): CommandCandidate[] {
		if (!record.model.reasoning) {
			throw new OrchestratorError(
				this._createAgentThinkingNotSupportedDiagnostic(record),
			);
		}
		return getSupportedThinkingLevels(record.model).map((level) => ({
			value: level,
			label: level,
		}));
	}

	private _createAgentThinkingNotSupportedDiagnostic(
		record: AgentRecord,
	): OrchestratorDiagnostic {
		return createOrchestratorDiagnostic({
			severity: "error",
			code: "model.thinking_not_supported",
			message: `Model ${record.model.provider}/${record.model.id} does not support thinking levels.`,
			source: { kind: "registry", name: "model", key: "thinkingLevel" },
			agentId: record.agentId,
			provider: record.model.provider,
			modelId: record.model.id,
			phase: "runtime",
			recoverable: true,
		});
	}

	// Command gateway: the sole execution-time arbiter. Checks, in order,
	// profile policy (deny), scope, then agent status declared on the binding.
	private _commandGateway(
		record: AgentRecord,
		binding: Pick<LineCommandBinding, "command" | "checkStatus">,
		commandId: string,
	): OrchestratorDiagnostic | undefined {
		const denial = this._commandPolicyDenial(record, binding.command);
		if (denial) {
			return createOrchestratorDiagnostic({
				severity: "error",
				code: "command.not_permitted",
				message: denial,
				operationSource: { kind: "human" },
				agentId: record.agentId,
				commandId,
				recoverable: true,
			});
		}
		const unavailable = binding.checkStatus?.(record.status);
		if (unavailable) {
			return createOrchestratorDiagnostic({
				severity: "error",
				code: "command.not_available",
				message: unavailable,
				operationSource: { kind: "human" },
				agentId: record.agentId,
				commandId,
				recoverable: true,
			});
		}
		return undefined;
	}

	// Static command gating: profile deny list and scope. Both listCommands
	// (list pruning) and the gateway (execution rejection) consume this fact.
	private _commandPolicyDenial(
		record: AgentRecord,
		command: Command,
	): string | undefined {
		if (record.commandPolicy?.deny?.includes(command.name)) {
			return `Command ${command.trigger}${command.name} is denied by profile policy.`;
		}
		if (
			command.scope === "user-facing" &&
			record.capabilities?.acceptsUserInput === false
		) {
			return `Command ${command.trigger}${command.name} is only available on agents that accept user input.`;
		}
		return undefined;
	}

	private _getLineCommandTriggers(agentId: AgentId): string[] {
		const record = this._requireAgentRecord(agentId);
		const triggers = BUILT_IN_COMMANDS.filter(
			(binding) => binding.command.placement === "line",
		).map((binding) => binding.command.trigger);
		for (const command of record.extensionRunner?.getCommands({
			reservedCommands: getBuiltInCommands(),
		}) ?? []) {
			if (command.command.placement === "line") {
				triggers.push(command.command.trigger);
			}
		}
		return [...new Set(triggers)];
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

function isBlockedExtensionDiagnostic(
	diagnostic: OrchestratorDiagnostic,
): boolean {
	return (
		diagnostic.domain === "extension" && diagnostic.disposition === "blocked"
	);
}

function createEmptyExtensionSnapshot(): ExtensionRunnerSnapshot {
	return {
		extensionIds: [],
		extensions: [],
		hooks: [],
		commands: [],
		toolContributions: [],
		stale: { stale: false },
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

function agentIdFromOperationSource(
	source: OperationSource | undefined,
): AgentId | undefined {
	if (!source) return undefined;
	if (source.kind === "agent" || source.kind === "tool") {
		return source.agentId;
	}
	return undefined;
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

function modelReference(model: RuntimeModel): string {
	return `${model.provider}/${model.id}`;
}

function parseModelReference(
	reference: string,
): { provider: string; modelId: string } | undefined {
	const trimmed = reference.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
		return undefined;
	}
	return {
		provider: trimmed.slice(0, slashIndex),
		modelId: trimmed.slice(slashIndex + 1),
	};
}

const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const satisfies readonly ThinkingLevel[];

function parseThinkingLevel(level: string): ThinkingLevel | undefined {
	const trimmed = level.trim();
	return THINKING_LEVELS.some((candidate) => candidate === trimmed)
		? (trimmed as ThinkingLevel)
		: undefined;
}

function streamingToolCallRefFromPartial(
	partial: AssistantMessage,
	contentIndex: number,
): StreamingToolCallRef {
	const content = partial.content[contentIndex];
	if (!content || content.type !== "toolCall") {
		return {};
	}
	return {
		toolCallId: content.id,
		toolName: content.name,
	};
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function now(): string {
	return new Date().toISOString();
}
