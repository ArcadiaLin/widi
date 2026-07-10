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
	formatSkillsForSystemPrompt,
	type JsonlSessionMetadata,
	type PromptTemplate,
	type Session,
	type Skill,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	getSupportedThinkingLevels,
	type ImageContent,
} from "@earendil-works/pi-ai";
import type {
	AgentProfile,
	AgentProfileOverride,
	AgentProfileRegistry,
	AgentProfileSource,
} from "./agent-profile.js";
import { parseAgentProfileReference } from "./agent-profile.js";
import {
	type AgentRecord,
	type AgentRecordSnapshot,
	createAgentRecord,
	createAgentRecordFromProfileReference,
	snapshotAgentRecord,
} from "./agent-record.ts";
import type { OrchestratorClient } from "./client.ts";
import {
	BUILT_IN_COMMANDS,
	BUILT_IN_INLINE_COMMANDS,
	type BuiltInInlineCommandBinding,
	type Command,
	type CommandArgumentsCompletionPayload,
	type CommandCandidate,
	type CommandInvocation,
	type CommandStatusCheck,
	getBuiltInCommands,
	type InlineCommandMatch,
	type InputResult,
	type ParsedLineCommand,
	parseLineCommand,
	scanInlineCommands,
} from "./command.ts";
import {
	createOrchestratorDiagnostic,
	dedupeDiagnostics,
	type OrchestratorDiagnostic,
	OrchestratorError,
	toCoreDiagnosticFromPromptTemplateDiagnostic,
	toCoreDiagnosticFromSkillDiagnostic,
	toDiagnostic,
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
} from "./extension/index.ts";
import type { HumanRequest, HumanResponse } from "./human-request.ts";
import { HumanRequestBroker } from "./human-request.ts";
import {
	type ModelRegistry,
	modelReference,
	parseModelReference,
	parseThinkingLevel,
	THINKING_LEVELS,
} from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
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
import type {
	AgentId,
	AgentLifecycleStatus,
	AgentToolsSnapshot,
	OrchestratorEvent,
	OrchestratorEventListener,
	RuntimeModel,
} from "./types.ts";

export type {
	AgentProfileRecordReference,
	AgentRecord,
	AgentRecordSnapshot,
} from "./agent-record.ts";

export type {
	AgentId,
	AgentLifecycleStatus,
	OrchestratorEvent,
	OrchestratorEventListener,
} from "./types.ts";

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

export interface AgentPromptTemplateCandidateListResult {
	readonly templates: readonly CommandCandidate[];
}

export interface AgentSkillCandidateListResult {
	readonly skills: readonly CommandCandidate[];
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
	metadata: JsonlSessionMetadata;
}

export type SpawnAgentHarnessOptions =
	| SpawnAgentHarnessCreateOptions
	| SpawnAgentHarnessResumeOptions;

export interface SpawnAgentHarnessResult {
	agentId: AgentId;
	harness: AgentHarness;
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

type CommandArgumentsCompletionResult =
	| { readonly ok: true; readonly argument: string }
	| { readonly ok: false; readonly diagnostic: OrchestratorDiagnostic };

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
	private _clients: Map<string, OrchestratorClient<OrchestratorEvent>> =
		new Map();
	private readonly _humanRequests: HumanRequestBroker;
	private _nextCommandId = 1;
	private _nextInputId = 1;

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
		this._humanRequests = new HumanRequestBroker({
			findHumanRequestHandler: () =>
				Array.from(this._clients.values()).find((entry) => entry.requestHuman)
					?.requestHuman,
			emit: async (event) => {
				await this._emit(event);
			},
			publishDiagnostic: async (diagnostic) => {
				await this._publishDiagnostic(diagnostic);
			},
			recordAgentLifecycleFailure: async (agentId, code, message, error) => {
				await this._recordAgentLifecycleFailure(agentId, code, message, error);
			},
		});
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
		return snapshotAgentRecord(this._requireAgentRecord(agentId));
	}

	listAgents(): AgentListResult {
		return {
			agents: Array.from(this.agents.values()).map((record) =>
				snapshotAgentRecord(record),
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

	async listAgentPromptTemplateCandidates(
		agentId: AgentId,
	): Promise<AgentPromptTemplateCandidateListResult> {
		const templates = await this._loadAgentPromptTemplates(agentId);
		return {
			templates: templates.map((template) => ({
				value: template.name,
				label: template.name,
				description: template.description,
			})),
		};
	}

	async getAgentPromptTemplate(
		agentId: AgentId,
		name: string,
	): Promise<PromptTemplate> {
		const templates = await this._loadAgentPromptTemplates(agentId);
		const template = templates.find((candidate) => candidate.name === name);
		if (!template) {
			throw new OrchestratorError(
				createOrchestratorDiagnostic({
					severity: "error",
					code: "prompt_template.not_found",
					message: `Prompt template not found: ${name}`,
					agentId,
					recoverable: true,
				}),
			);
		}
		return template;
	}

	private async _loadAgentPromptTemplates(
		agentId: AgentId,
	): Promise<PromptTemplate[]> {
		const record = this._requireAgentRecord(agentId);
		const resolvedProfile = await this._resolveProfileById(
			record.profile.reference.id,
			agentId,
		);
		const loaded = await this.resourceLoader.loadPromptTemplates(
			resolvedProfile.profile.promptTemplates,
		);
		await this._publishDiagnostics(
			loaded.diagnostics.map((diagnostic) =>
				toCoreDiagnosticFromPromptTemplateDiagnostic(diagnostic, {
					agentId,
					profileId: resolvedProfile.profile.id,
					phase: "resolve",
				}),
			),
		);
		return loaded.promptTemplates.map(({ promptTemplate }) => promptTemplate);
	}

	async listAgentSkillCandidates(
		agentId: AgentId,
	): Promise<AgentSkillCandidateListResult> {
		const skills = await this._loadAgentSkills(agentId);
		return {
			skills: skills.map((skill) => ({
				value: skill.name,
				label: skill.name,
				description: skill.description,
			})),
		};
	}

	async getAgentSkill(agentId: AgentId, name: string): Promise<Skill> {
		const skills = await this._loadAgentSkills(agentId);
		const skill = skills.find((candidate) => candidate.name === name);
		if (!skill) {
			throw new OrchestratorError(
				createOrchestratorDiagnostic({
					severity: "error",
					code: "skill.not_found",
					message: `Skill not found: ${name}`,
					agentId,
					recoverable: true,
				}),
			);
		}
		return skill;
	}

	private async _loadAgentSkills(agentId: AgentId): Promise<Skill[]> {
		const record = this._requireAgentRecord(agentId);
		const resolvedProfile = await this._resolveProfileById(
			record.profile.reference.id,
			agentId,
		);
		const loaded = await this.resourceLoader.loadSkills(
			resolvedProfile.profile.skills,
		);
		await this._publishDiagnostics(
			loaded.diagnostics.map((diagnostic) =>
				toCoreDiagnosticFromSkillDiagnostic(diagnostic, {
					agentId,
					profileId: resolvedProfile.profile.id,
					phase: "resolve",
				}),
			),
		);
		return loaded.skills.map(({ skill }) => skill);
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

	// Command input is an AgentOrchestrator public runtime surface. It stays
	// here with command ids, gateway checks, argument completion, inline
	// expansion, event emission, and session writes.
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
			const inlineResult = await this._expandInlineInput(
				agentId,
				text,
				options,
			);
			if (inlineResult) return inlineResult;
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

		let commandArgument = parsed.argument;
		let executionInvocation = invocation;

		// Argument check: a declared-required argument that is missing asks a
		// client for completion before rejecting the command.
		if (command.command.arguments?.required && !parsed.argument.trim()) {
			const completion = await this._completeCommandArguments({
				agentId,
				commandId,
				binding: command,
				invocation,
				argumentPrefix: parsed.argument,
			});
			if (!completion.ok) {
				await this._emit({
					type: "command_rejected",
					commandId,
					command: invocation,
					diagnostic: completion.diagnostic,
					completedAt: now(),
				});
				await this._publishDiagnostic(completion.diagnostic);
				return {
					kind: "rejected",
					commandId,
					diagnostic: completion.diagnostic,
				};
			}
			commandArgument = completion.argument;
			executionInvocation = {
				...invocation,
				argument: commandArgument,
			};
			// The human wait can outlive the gateway's precondition (e.g.
			// /steer's running turn); recheck so the stale command still
			// rejects side-effect free instead of failing mid-execution.
			const staleDiagnostic = this._commandGateway(
				this._requireAgentRecord(agentId),
				command,
				commandId,
			);
			if (staleDiagnostic) {
				await this._emit({
					type: "command_rejected",
					commandId,
					command: executionInvocation,
					diagnostic: staleDiagnostic,
					completedAt: now(),
				});
				await this._publishDiagnostic(staleDiagnostic);
				return { kind: "rejected", commandId, diagnostic: staleDiagnostic };
			}
		}

		await this._emit({
			type: "command_accepted",
			commandId,
			command: executionInvocation,
			createdAt: now(),
		});

		try {
			const value = await command.execute(commandArgument);
			await this._emit({
				type: "command_completed",
				commandId,
				command: executionInvocation,
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
				command: executionInvocation,
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
		await this._humanRequests.cancelForAgent(
			agentId,
			reason ?? `Agent disposed: ${agentId}`,
		);
		this._forceAgentStatus(agentId, "disposed");
	}

	async disposeAll(reason?: string): Promise<void> {
		for (const agentId of [...this.agents.keys()]) {
			await this.disposeAgent(agentId, reason);
		}
		await this._humanRequests.cancelAll(reason ?? "Orchestrator disposed.");
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
		return await this._humanRequests.request(request);
	}

	async cancelHumanRequest(
		requestId: string,
		reason?: string,
	): Promise<boolean> {
		return await this._humanRequests.cancel(requestId, reason);
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
		metadata: JsonlSessionMetadata,
	): Promise<ResolvedAgentProfile> {
		const profileReference = parseAgentProfileReference(
			metadata.metadata?.profile,
		);
		if (!profileReference) {
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
		const parsed = parseThinkingLevel(level);
		if (parsed && parsed === level) return parsed;
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
			createAgentRecord({
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
			await this._setAgentStatus(agentId, "idle");
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
				createAgentRecord({
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

			await this._setAgentStatus(agentId, "idle");
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
			// Callback instead of a string so the skills listing tracks the
			// harness's current resources and active tools at each turn start.
			systemPrompt: ({ resources: current, activeTools }) =>
				buildAgentSystemPrompt(profile.systemPrompt, current, activeTools),
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

	private _markAgentUnavailable(options: {
		agentId: AgentId;
		resolvedProfile: ResolvedAgentProfile | undefined;
		metadata: JsonlSessionMetadata;
		sessionMetadata?: AgentSessionMetadata;
		model: RuntimeModel;
		diagnostic: OrchestratorDiagnostic;
	}): void {
		const existing = this.agents.get(options.agentId);
		const record = options.resolvedProfile
			? createAgentRecord({
					agentId: options.agentId,
					status: "unavailable",
					resolvedProfile: options.resolvedProfile,
					sessionMetadata: options.sessionMetadata,
					model: options.model,
				})
			: createAgentRecordFromProfileReference({
					agentId: options.agentId,
					status: "unavailable",
					profile: {
						reference: parseAgentProfileReference(
							options.metadata.metadata?.profile,
						) ?? { id: "unknown" },
					},
					sessionMetadata: options.sessionMetadata,
					model: options.model,
				});
		this.agents.set(options.agentId, {
			...record,
			resourceDiagnostics: existing?.resourceDiagnostics
				? [...existing.resourceDiagnostics]
				: [],
			extensionDiagnostics: existing?.extensionDiagnostics
				? [...existing.extensionDiagnostics]
				: [],
			diagnostics: [...(existing?.diagnostics ?? []), options.diagnostic],
		});
		this._agentToolSets.delete(options.agentId);
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

		const before = snapshotAgentRecord(record);
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
				after: snapshotAgentRecord(record),
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
				after: snapshotAgentRecord(record),
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
				after: snapshotAgentRecord(record),
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

	// Command input runtime surface.
	//
	// This is intentionally not a collaborator yet: command input is the
	// orchestrator's public ingress for human text. Keep ids, gateway,
	// argument completion, inline expansion, command events, and session
	// expansion writes together until a future narrow-host extraction exists.
	private _createCommandId(): string {
		const id = `orchestrator-command-${this._nextCommandId}`;
		this._nextCommandId += 1;
		return id;
	}

	private _createInputId(): string {
		const id = `orchestrator-input-${this._nextInputId}`;
		this._nextInputId += 1;
		return id;
	}

	// Scans a line-command miss for inline commands and expands them in
	// place. Returns undefined when the input contains none (the caller
	// falls through to the plain prompt path). All-or-nothing: any gateway,
	// completion, or expand failure drops the whole input - a half-expanded
	// prompt must never reach the model.
	private async _expandInlineInput(
		agentId: AgentId,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<InputResult | undefined> {
		const matches = scanInlineCommands(
			text,
			BUILT_IN_INLINE_COMMANDS.map((binding) => binding.command),
		);
		if (matches.length === 0) return undefined;

		const inputId = this._createInputId();
		const expansions: Array<{
			match: InlineCommandMatch;
			commandId: string;
			invocation: CommandInvocation;
			replacement: string;
		}> = [];
		for (const match of matches) {
			const binding = this._findInlineCommand(match);
			if (!binding) continue;
			const commandId = this._createCommandId();
			let invocation: CommandInvocation = {
				name: match.name,
				trigger: match.trigger,
				argument: match.argument,
				source: binding.command.source,
				placement: "inline",
			};
			await this._emit({
				type: "command_detected",
				commandId,
				command: invocation,
				inputId,
				createdAt: now(),
			});

			const rejectWith = async (
				diagnostic: OrchestratorDiagnostic,
			): Promise<InputResult> => {
				await this._emit({
					type: "command_rejected",
					commandId,
					command: invocation,
					diagnostic,
					inputId,
					completedAt: now(),
				});
				await this._publishDiagnostic(diagnostic);
				return { kind: "rejected", commandId, diagnostic };
			};

			const gatewayDiagnostic = this._commandGateway(
				this._requireAgentRecord(agentId),
				{ command: binding.command },
				commandId,
			);
			if (gatewayDiagnostic) return await rejectWith(gatewayDiagnostic);

			let commandArgument = match.argument;
			if (binding.command.arguments?.required && !commandArgument.trim()) {
				const completion = await this._completeCommandArguments({
					agentId,
					commandId,
					binding,
					invocation,
					argumentPrefix: match.argument,
				});
				if (!completion.ok) return await rejectWith(completion.diagnostic);
				commandArgument = completion.argument;
				invocation = { ...invocation, argument: commandArgument };
				const staleDiagnostic = this._commandGateway(
					this._requireAgentRecord(agentId),
					{ command: binding.command },
					commandId,
				);
				if (staleDiagnostic) return await rejectWith(staleDiagnostic);
			}

			await this._emit({
				type: "command_accepted",
				commandId,
				command: invocation,
				inputId,
				createdAt: now(),
			});
			try {
				const replacement = await binding.expand(
					this,
					agentId,
					commandArgument,
				);
				await this._emit({
					type: "command_completed",
					commandId,
					command: invocation,
					result: replacement,
					inputId,
					completedAt: now(),
				});
				expansions.push({ match, commandId, invocation, replacement });
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
					inputId,
					completedAt: now(),
				});
				await this._publishDiagnostic(diagnostic);
				return { kind: "failed", commandId, diagnostic };
			}
		}
		if (expansions.length === 0) return undefined;

		let expandedText = "";
		let cursor = 0;
		for (const expansion of expansions) {
			expandedText += text.slice(cursor, expansion.match.start);
			expandedText += expansion.replacement;
			cursor = expansion.match.end;
		}
		expandedText += text.slice(cursor);

		// Dual record: the user message carries the expanded text the model
		// actually sees; the custom entry preserves the original input and
		// expansion positions for UI replay.
		await this.sessionManager.appendCommandExpansionEntry(agentId, {
			inputId,
			originalText: text,
			expansions: expansions.map((expansion) => ({
				commandId: expansion.commandId,
				name: expansion.invocation.name,
				trigger: expansion.invocation.trigger,
				argument: expansion.invocation.argument,
				start: expansion.match.start,
				end: expansion.match.end,
			})),
		});

		return {
			kind: "prompt",
			message: await this.promptAgent(agentId, expandedText, {
				images: options?.images ? [...options.images] : undefined,
			}),
		};
	}

	private _findInlineCommand(
		match: InlineCommandMatch,
	): BuiltInInlineCommandBinding | undefined {
		return BUILT_IN_INLINE_COMMANDS.find(
			(binding) =>
				binding.command.trigger === match.trigger &&
				binding.command.name === match.name,
		);
	}

	private async _completeCommandArguments(options: {
		agentId: AgentId;
		commandId: string;
		binding: Pick<LineCommandBinding, "command">;
		invocation: CommandInvocation;
		argumentPrefix: string;
	}): Promise<CommandArgumentsCompletionResult> {
		const { agentId, commandId, binding, invocation, argumentPrefix } = options;
		let response: HumanResponse;
		try {
			// A complete() failure short-circuits before any human request.
			const candidates = [
				...((await binding.command.arguments?.complete?.({
					agentId,
					command: binding.command,
					argumentPrefix,
					orchestrator: this,
				})) ?? []),
			];
			const payload: CommandArgumentsCompletionPayload = {
				commandId,
				command: invocation,
				argumentHint: binding.command.argumentHint,
				argumentPrefix,
				candidates,
			};
			response = await this.requestHuman({
				source: { kind: "agent", agentId },
				kind: "argumentsCompletion",
				title: `Complete ${binding.command.trigger}${binding.command.name} arguments`,
				message: `Command ${binding.command.trigger}${binding.command.name} requires an argument.`,
				options:
					candidates.length > 0
						? candidates.map((candidate) => candidate.value)
						: undefined,
				placeholder: binding.command.argumentHint,
				allowFreeInput: true,
				payload,
			});
		} catch (error) {
			const failureDiagnostic = toDiagnostic(error, {
				code: "command.arguments_completion_failed",
				message: `Failed to complete arguments for command ${binding.command.trigger}${binding.command.name}: ${formatError(error)}`,
				operationSource: { kind: "human" },
				agentId,
				commandId,
				recoverable: true,
			});
			return {
				ok: false,
				diagnostic: this._createCommandArgumentsRequiredDiagnostic({
					agentId,
					commandId,
					command: binding.command,
					details: commandArgumentsCompletionFailureDetails(failureDiagnostic),
				}),
			};
		}

		if (response.kind !== "input" && response.kind !== "select") {
			return {
				ok: false,
				diagnostic: this._createCommandArgumentsRequiredDiagnostic({
					agentId,
					commandId,
					command: binding.command,
					details: {
						completionFailureCode:
							"command.arguments_completion_invalid_response",
						responseKind: response.kind,
					},
				}),
			};
		}
		const argument = response.value;
		if (argument === undefined || !argument.trim()) {
			return {
				ok: false,
				diagnostic: this._createCommandArgumentsRequiredDiagnostic({
					agentId,
					commandId,
					command: binding.command,
					details: {
						completionFailureCode: "command.arguments_completion_empty",
						responseKind: response.kind,
					},
				}),
			};
		}
		return { ok: true, argument };
	}

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

	private _createCommandArgumentsRequiredDiagnostic(options: {
		agentId: AgentId;
		commandId: string;
		command: Command;
		details?: Record<string, unknown>;
	}): OrchestratorDiagnostic {
		return createOrchestratorDiagnostic({
			severity: "error",
			code: "command.arguments_required",
			message: `Command ${options.command.trigger}${options.command.name} requires an argument.`,
			operationSource: { kind: "human" },
			agentId: options.agentId,
			commandId: options.commandId,
			recoverable: true,
			details: options.details,
		});
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

function isBlockedExtensionDiagnostic(
	diagnostic: OrchestratorDiagnostic,
): boolean {
	return (
		diagnostic.domain === "extension" && diagnostic.disposition === "blocked"
	);
}

function commandArgumentsCompletionFailureDetails(
	diagnostic: OrchestratorDiagnostic,
): Record<string, unknown> {
	return {
		completionFailureCode: diagnostic.code,
		completionFailureMessage: diagnostic.message,
		requestId: diagnostic.requestId,
	};
}

/**
 * Compose the harness system prompt from the profile prompt plus a
 * model-visible skills listing (agentskills.io block via pi-agent-core).
 * The listing tells the model to read the skill file, so it is only
 * appended when a read tool is active; skills stay reachable through the
 * `<skill:...>` inline command either way.
 */
export function buildAgentSystemPrompt(
	basePrompt: string,
	resources: AgentHarnessResources,
	activeTools: readonly { name: string }[],
): string {
	const hasReadTool = activeTools.some((tool) => tool.name === "read");
	if (!hasReadTool) return basePrompt;
	const skillsSection = formatSkillsForSystemPrompt(resources.skills ?? []);
	if (skillsSection === "") return basePrompt;
	return `${basePrompt}\n\n${skillsSection}`;
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

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function now(): string {
	return new Date().toISOString();
}
