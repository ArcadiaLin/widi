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
	calculateContextTokens,
	type ExecutionEnv,
	formatSkillsForSystemPrompt,
	getLastAssistantUsage,
	type JsonlSessionMetadata,
	type PromptTemplate,
	type PromptTemplateDiagnostic,
	type Session,
	type Skill,
	type SkillDiagnostic,
	shouldCompact,
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
	type ExtensionCoreActions,
	type ExtensionIdentity,
	type ExtensionInterceptorEventFor,
	type ExtensionInterceptorName,
	type ExtensionInterceptorResultFor,
	ExtensionLoader,
	type ExtensionModule,
	type ExtensionObservedEvent,
	type ExtensionResourceContribution,
	ExtensionRunner,
} from "./extension/index.ts";
import {
	assertExtensionNotificationText,
	assertExtensionOutputText,
	assertExtensionStatusKey,
	type ExtensionMessage,
	type ExtensionStatus,
	type ExtensionStatusSnapshot,
	validateExtensionDiagnosticDraft,
	validateExtensionMessage,
	validateExtensionStatus,
} from "./extension/presentation.ts";
import { ExtensionStatusRegistry } from "./extension/status-registry.ts";
import type { HumanRequest, HumanResponse } from "./human-request.ts";
import { HumanRequestBroker } from "./human-request.ts";
import { stripImagesFromMessages } from "./image-policy.ts";
import {
	type ModelRegistry,
	modelReference,
	type ProviderConfigInput,
	parseModelReference,
	parseThinkingLevel,
	THINKING_LEVELS,
} from "./model-registry.js";
import type { ConfigValueResolver } from "./resolve-config-value.js";
import type {
	ExtensionResourcePathContribution,
	ResourceLoader,
	ResourceSource,
} from "./resource-loader.js";
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
	CandidateItem,
	OrchestratorEvent,
	OrchestratorEventListener,
	PromptExpansion,
	PromptOutcome,
	RuntimeModel,
} from "./types.ts";

export type {
	AgentProfileRecordReference,
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
	readonly models: readonly CandidateItem[];
}

export interface AgentThinkingLevelCandidateListResult {
	readonly levels: readonly CandidateItem[];
}

export interface AgentPromptTemplateCandidateListResult {
	readonly templates: readonly CandidateItem[];
}

export interface AgentSkillCandidateListResult {
	readonly skills: readonly CandidateItem[];
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

interface SpawnAgentCommonOptions {
	model?: RuntimeModel;
	inheritModelFromAgentId?: AgentId;
	thinkingLevel?: ThinkingLevel;
}

export interface SpawnAgentCreateOptions extends SpawnAgentCommonOptions {
	resume?: false;
	profileId?: string;
	profileOverride?: AgentProfileOverride;
}

export interface SpawnAgentResumeOptions extends SpawnAgentCommonOptions {
	resume: true;
	metadata: JsonlSessionMetadata;
}

export type SpawnAgentOptions =
	| SpawnAgentCreateOptions
	| SpawnAgentResumeOptions;

interface SpawnedAgentHarness {
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

export class AgentOrchestrator {
	private _defaultModel: RuntimeModel;
	private _defaultThinkingLevel: ThinkingLevel | undefined;
	private _defaultProfileId: string;
	private _enabledProfileIds: readonly string[] | undefined;
	private readonly _agents: Map<AgentId, AgentRecord> = new Map();
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
	private _extensionObserverDispatchDepth: Map<AgentId, number> = new Map();
	private _agentRunSignals: Map<AgentId, AbortSignal> = new Map();
	private _agentToolSets: Map<AgentId, AgentToolSet> = new Map();
	private _autoCompactingAgents: Set<AgentId> = new Set();
	private readonly _extensionStatuses = new ExtensionStatusRegistry();
	private _clients: Map<string, OrchestratorClient<OrchestratorEvent>> =
		new Map();
	private readonly _humanRequests: HumanRequestBroker;
	private _nextInputId = 1;
	private _nextPresentationId = 1;
	private _nextReportedDiagnosticId = 1;

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

	async spawnAgent(options: SpawnAgentOptions = {}): Promise<AgentId> {
		await this.emitStartupDiagnostics();
		if (options.resume) {
			return (await this._resumeAgentHarness(options)).agentId;
		}

		const agentProfile = await this._resolveCreateProfile(options);
		const model = this._resolveSpawnModel(options);
		const spawned = await this._createAgentHarness(agentProfile, model, {
			thinkingLevel: options.thinkingLevel ?? this._defaultThinkingLevel,
		});
		return spawned.agentId;
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

	registerExtension(extensionId: string, module: ExtensionModule): () => void {
		return this.extensionLoader.registerExtension(extensionId, module);
	}

	getAgentStatus(agentId: AgentId): AgentLifecycleStatus {
		return this._requireAgentRecord(agentId).status;
	}

	inspectAgent(agentId: AgentId): AgentRecordSnapshot {
		return snapshotAgentRecord(this._requireAgentRecord(agentId));
	}

	listAgents(): AgentListResult {
		return {
			agents: Array.from(this._agents.values()).map((record) =>
				snapshotAgentRecord(record),
			),
		};
	}

	listExtensionStatuses(agentId: AgentId): ExtensionStatusSnapshot[] {
		this._requireAgentRecord(agentId);
		return this._extensionStatuses.list(agentId);
	}

	async newAgentSessionFromAgent(
		agentId: AgentId,
	): Promise<AgentSessionCommandResult> {
		const sourceRecord = this._requireAgentRecord(agentId);
		const spawnedAgentId = await this.spawnAgent({
			profileId: sourceRecord.profile.reference.id,
			model: sourceRecord.model,
		});
		return {
			agentId: spawnedAgentId,
			snapshot: this.inspectAgent(spawnedAgentId),
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

	async getAgentSessionName(agentId: AgentId): Promise<string | undefined> {
		return (await this.getAgentSession(agentId)).name;
	}

	async setAgentSessionName(
		agentId: AgentId,
		name: string,
	): Promise<AgentSessionSnapshot> {
		this._requireAgentRecord(agentId);
		const snapshot = await this.sessionManager.setAgentSessionName(
			agentId,
			name,
		);
		await this._emit({
			type: "agent_session_info_changed",
			agentId,
			name: snapshot.name,
			changedAt: now(),
		});
		return snapshot;
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
		await this._emit({
			type: "agent_session_forked",
			agentId,
			forkedSessionId: metadata.id,
			entryId: options?.entryId,
			createdAt: now(),
		});
		const spawnedAgentId = await this.spawnAgent({
			resume: true,
			metadata,
			model: sourceRecord.model,
		});
		return {
			agentId: spawnedAgentId,
			snapshot: this.inspectAgent(spawnedAgentId),
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
		const spawnedAgentId = await this.spawnAgent({
			resume: true,
			metadata,
		});
		return {
			agentId: spawnedAgentId,
			snapshot: this.inspectAgent(spawnedAgentId),
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

	getAgentThinkingLevel(agentId: AgentId): ThinkingLevel {
		return this._requireAgentHarness(agentId).getThinkingLevel();
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
		const loaded = await this._loadMergedAgentPromptTemplates({
			agentId,
			profile: resolvedProfile.profile,
			extensionRunner: activeExtensionRunner(record),
		});
		await this._publishDiagnostics(loaded.diagnostics);
		return loaded.promptTemplates.map(({ promptTemplate }) => promptTemplate);
	}

	private async _loadMergedAgentPromptTemplates(options: {
		agentId: AgentId;
		profile: AgentProfile;
		extensionRunner?: ExtensionRunner;
	}): Promise<{
		promptTemplates: Array<{
			promptTemplate: PromptTemplate;
			source: ResourceSource;
		}>;
		diagnostics: OrchestratorDiagnostic[];
	}> {
		const { agentId, profile, extensionRunner } = options;
		const toResourceDiagnostic = (
			diagnostic: PromptTemplateDiagnostic & { source?: ResourceSource },
		) =>
			toCoreDiagnosticFromPromptTemplateDiagnostic(diagnostic, {
				agentId,
				profileId: profile.id,
				phase: "resolve",
			});
		const loaded = await this.resourceLoader.loadPromptTemplates(
			profile.promptTemplates,
		);
		const diagnostics = loaded.diagnostics.map(toResourceDiagnostic);
		const contributions = listResourcePathContributions(
			extensionRunner,
			(contribution) => contribution.promptTemplatePaths,
		);
		if (contributions.length === 0) {
			return { promptTemplates: loaded.promptTemplates, diagnostics };
		}
		const contributed =
			await this.resourceLoader.loadContributedPromptTemplates(contributions);
		diagnostics.push(...contributed.diagnostics.map(toResourceDiagnostic));
		const merged = this._mergeContributedResources({
			agentId,
			profileId: profile.id,
			resourceType: "prompt_template",
			registered: loaded.promptTemplates.map((entry) => ({
				name: entry.promptTemplate.name,
				entry,
			})),
			contributed: contributed.promptTemplates.map((entry) => ({
				name: entry.promptTemplate.name,
				entry,
			})),
		});
		diagnostics.push(...merged.diagnostics);
		return { promptTemplates: merged.resources, diagnostics };
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
		const loaded = await this._loadMergedAgentSkills({
			agentId,
			profile: resolvedProfile.profile,
			extensionRunner: activeExtensionRunner(record),
		});
		await this._publishDiagnostics(loaded.diagnostics);
		return loaded.skills.map(({ skill }) => skill);
	}

	private async _loadMergedAgentSkills(options: {
		agentId: AgentId;
		profile: AgentProfile;
		extensionRunner?: ExtensionRunner;
	}): Promise<{
		skills: Array<{ skill: Skill; source: ResourceSource }>;
		diagnostics: OrchestratorDiagnostic[];
	}> {
		const { agentId, profile, extensionRunner } = options;
		const toResourceDiagnostic = (
			diagnostic: SkillDiagnostic & { source?: ResourceSource },
		) =>
			toCoreDiagnosticFromSkillDiagnostic(diagnostic, {
				agentId,
				profileId: profile.id,
				phase: "resolve",
			});
		const loaded = await this.resourceLoader.loadSkills(profile.skills);
		const diagnostics = loaded.diagnostics.map(toResourceDiagnostic);
		const contributions = listResourcePathContributions(
			extensionRunner,
			(contribution) => contribution.skillPaths,
		);
		if (contributions.length === 0) {
			return { skills: loaded.skills, diagnostics };
		}
		const contributed =
			await this.resourceLoader.loadContributedSkills(contributions);
		diagnostics.push(...contributed.diagnostics.map(toResourceDiagnostic));
		const merged = this._mergeContributedResources({
			agentId,
			profileId: profile.id,
			resourceType: "skill",
			registered: loaded.skills.map((entry) => ({
				name: entry.skill.name,
				entry,
			})),
			contributed: contributed.skills.map((entry) => ({
				name: entry.skill.name,
				entry,
			})),
		});
		diagnostics.push(...merged.diagnostics);
		return { skills: merged.resources, diagnostics };
	}

	// First-registration-wins (ME slice 8): core-owned profile/cwd resources
	// register first and always win; extension contributions then resolve in
	// activation order. A name collision drops the later contribution with a
	// diagnostic instead of renaming it - skill and template names must not
	// change shape between declaration and invocation.
	private _mergeContributedResources<
		T extends { source: ResourceSource },
	>(options: {
		agentId: AgentId;
		profileId: string;
		resourceType: "skill" | "prompt_template";
		registered: Array<{ name: string; entry: T }>;
		contributed: Array<{ name: string; entry: T }>;
	}): { resources: T[]; diagnostics: OrchestratorDiagnostic[] } {
		const takenNames = new Set(options.registered.map((item) => item.name));
		const resources = options.registered.map((item) => item.entry);
		const diagnostics: OrchestratorDiagnostic[] = [];
		for (const { name, entry } of options.contributed) {
			if (takenNames.has(name)) {
				const extensionId =
					entry.source.kind === "extension"
						? entry.source.extensionId
						: undefined;
				diagnostics.push(
					createOrchestratorDiagnostic({
						severity: "warning",
						disposition: "reported",
						code: "extension.resource_conflict",
						message: `Extension '${extensionId}' ${options.resourceType} '${name}' conflicts with an already registered ${options.resourceType} and was skipped.`,
						agentId: options.agentId,
						profileId: options.profileId,
						extensionId,
						recoverable: true,
						details: {
							resourceType: options.resourceType,
							name,
							path: entry.source.path,
						},
					}),
				);
				continue;
			}
			takenNames.add(name);
			resources.push(entry);
		}
		return { resources, diagnostics };
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
	): CandidateItem[] {
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

	// The single text-input entry point. Extension input interception is
	// applied here so no caller can bypass an input policy; interaction-layer
	// inline expansions are persisted via options.expansion.
	async promptAgent(
		agentId: AgentId,
		text: string,
		options?: { images?: ImageContent[]; expansion?: PromptExpansion },
	): Promise<PromptOutcome> {
		const record = this._requireAgentRecord(agentId);
		let inputText = text;
		let inputImages = options?.images;
		let inputId: string | undefined;
		let pendingInputTransform:
			| {
					inputId: string;
					originalText: string;
					text: string;
					transformedBy: readonly string[];
			  }
			| undefined;
		const runner = record.extensionRunner;
		if (runner && !runner.isStale()) {
			const run = await runner.interceptInput({
				type: "input",
				text: inputText,
				images: inputImages,
			});
			await this._recordAndPublishExtensionDiagnostics(
				agentId,
				run.diagnostics,
			);
			if (run.kind === "block") {
				inputId = this._createInputId();
				await this._emit({
					type: "input_blocked",
					agentId,
					inputId,
					originalText: text,
					reason: run.reason,
					blockedBy: run.blockedBy,
					createdAt: now(),
				});
				return {
					kind: "blocked",
					inputId,
					reason: run.reason,
					blockedBy: run.blockedBy,
				};
			}
			if (run.kind === "transform") {
				inputId = this._createInputId();
				await this._emit({
					type: "input_transformed",
					agentId,
					inputId,
					originalText: text,
					text: run.text,
					transformedBy: run.transformedBy,
					createdAt: now(),
				});
				pendingInputTransform = {
					inputId,
					originalText: text,
					text: run.text,
					transformedBy: run.transformedBy,
				};
				inputText = run.text;
				inputImages = run.images ? [...run.images] : inputImages;
			}
		}

		// Dual record: the user message carries the expanded text the model
		// actually sees; the custom entry preserves the original input and
		// expansion positions for UI replay.
		if (options?.expansion) {
			await this.sessionManager.appendCommandExpansionEntry(agentId, {
				inputId: inputId ?? this._createInputId(),
				originalText: options.expansion.originalText,
				expansions: options.expansion.items,
			});
		}
		// Persistence waits until the rewritten input is known to enter the
		// model-facing prompt path of a fresh turn, so a rewrite never leaves
		// a dangling transform entry without a user message to pair with.
		if (pendingInputTransform && record.status === "idle") {
			await this.sessionManager.appendInputTransformEntry(
				agentId,
				pendingInputTransform,
			);
		}
		const message = await this._runHarnessOperation(
			agentId,
			async (harness) => {
				return await harness.prompt(inputText, {
					images: inputImages ? [...inputImages] : undefined,
				});
			},
		);
		return { kind: "completed", message };
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
		await this._clearExtensionStatusesForAgent(agentId);
		await this._withdrawExtensionProviderContributions(agentId);
		delete record.harness;
		this._agentRunSignals.delete(agentId);
		this._agentToolSets.delete(agentId);
		await this._humanRequests.cancelForAgent(
			agentId,
			reason ?? `Agent disposed: ${agentId}`,
		);
		await this._transitionAgentStatus(agentId, "disposed", { force: true });
	}

	async disposeAll(reason?: string): Promise<void> {
		for (const agentId of [...this._agents.keys()]) {
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
			: [...this._agents.keys()];
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

	private async _requestHumanForAgent(
		agentId: AgentId,
		request: HumanRequest,
	): Promise<HumanResponse> {
		return await this._humanRequests.request(request, { agentId });
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

		while (this._agents.has(agentId)) {
			agentId = `${base}-${suffix}`;
			suffix += 1;
		}

		return agentId;
	}

	private _resolveSpawnModel(options: SpawnAgentOptions): RuntimeModel {
		if (options.model) {
			return options.model;
		}

		if (options.inheritModelFromAgentId) {
			const sourceRecord = this._agents.get(options.inheritModelFromAgentId);
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
		options: SpawnAgentCreateOptions,
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
		options: SpawnAgentResumeOptions,
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
	): Promise<SpawnedAgentHarness> {
		const { profile } = resolvedProfile;
		const agentId = this._allocateAgentId(profile);
		const session = await this.sessionManager.createAgentSession({
			agentId: agentId,
			agentProfile: profile,
		});
		const sessionMetadata = await session.getMetadata();
		await this._registerAgentRecord(
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
			await this._transitionAgentStatus(agentId, "idle");
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
			await this._markExistingAgentUnavailable(agentId, diagnostic);
			if (!(error instanceof OrchestratorError)) {
				await this._publishDiagnostic(diagnostic);
			}
			throw error;
		}
	}

	private async _resumeAgentHarness(
		options: SpawnAgentResumeOptions,
	): Promise<SpawnedAgentHarness> {
		const agentId = options.metadata.id;
		const cachedRecord = this._agents.get(agentId);
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
			await this._registerAgentRecord(
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

			await this._transitionAgentStatus(agentId, "idle");
			await this._emit({ type: "agent_resumed", agentId, profile, model });
			return { agentId, harness };
		} catch (error) {
			const diagnostic = toDiagnostic(error, {
				code: "orchestrator.agent_unavailable",
				message: `Cannot resume agent ${agentId}: ${formatError(error)}`,
				agentId,
				recoverable: true,
			});
			await this._markAgentUnavailable({
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
		// The extension runner exists before resource loading so contributed
		// skill/prompt paths (ME slice 8) join the same load-and-merge pass as
		// profile resources.
		const extensionRunner = await this._createExtensionRunner(agentId, profile);
		await this._publishDiagnostics(extensionRunner.diagnostics);
		this._addAgentDiagnostics(agentId, {
			extensionDiagnostics: [...extensionRunner.diagnostics],
		});
		this._requireAgentRecord(agentId).extensionRunner = extensionRunner;
		const blockedExtensionDiagnostic = extensionRunner.diagnostics.find(
			isBlockedExtensionDiagnostic,
		);
		if (blockedExtensionDiagnostic) {
			throw new OrchestratorError(blockedExtensionDiagnostic);
		}
		// Contributed providers register before the harness exists so their
		// models are selectable from the first turn. Spawn/resume model
		// resolution happens earlier still and cannot reference them.
		await this._applyExtensionProviderContributions(
			agentId,
			profile.id,
			extensionRunner,
		);

		const loadedSkills = await this._loadMergedAgentSkills({
			agentId,
			profile,
			extensionRunner,
		});
		const loadedPromptTemplates = await this._loadMergedAgentPromptTemplates({
			agentId,
			profile,
			extensionRunner,
		});
		const resourceDiagnostics: OrchestratorDiagnostic[] = [
			...loadedSkills.diagnostics,
			...loadedPromptTemplates.diagnostics,
		];
		await this._publishDiagnostics(resourceDiagnostics);
		this._addAgentDiagnostics(agentId, { resourceDiagnostics });

		const resources: AgentHarnessResources = {
			skills: loadedSkills.skills.map(({ skill }) => skill),
			promptTemplates: loadedPromptTemplates.promptTemplates.map(
				({ promptTemplate }) => promptTemplate,
			),
		};
		this._requireAgentRecord(agentId).resources = {
			skills: loadedSkills.skills.map(({ skill, source }) => ({
				name: skill.name,
				source,
			})),
			promptTemplates: loadedPromptTemplates.promptTemplates.map(
				({ promptTemplate, source }) => ({
					name: promptTemplate.name,
					source,
				}),
			),
		};

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
		this._bindExtensionRunner(agentId, extensionRunner);
		const unsubscribeInterceptors = this._registerExtensionInterceptors(
			agentId,
			harness,
			extensionRunner,
		);
		const unsubscribeHarnessEvents = harness.subscribe((event, signal) => {
			void this._handleSubscribedAgentHarnessEvent(agentId, event, signal);
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

	private async _applyExtensionProviderContributions(
		agentId: AgentId,
		profileId: string,
		extensionRunner: ExtensionRunner,
	): Promise<void> {
		const contributions = extensionRunner.getProviderContributions();
		if (contributions.length === 0) return;
		const diagnostics: OrchestratorDiagnostic[] = [];
		const projectTrusted = this.settingManager.isProjectTrusted();
		for (const contribution of contributions) {
			const diagnosticBase = {
				source: {
					kind: "extension",
					id: contribution.extensionId,
				},
				agentId,
				profileId,
				extensionId: contribution.extensionId,
				phase: "create",
				recoverable: true,
			} as const;
			// Trust ruling: `!command` config values resolve through
			// ExecutionEnv.exec at request time, so an untrusted project rejects
			// the whole registration - the same family as the scoped exec gate.
			if (
				!projectTrusted &&
				hasCommandConfigValues(
					contribution.config,
					this.modelRegistry.configValueResolver,
				)
			) {
				diagnostics.push(
					createOrchestratorDiagnostic({
						...diagnosticBase,
						severity: "error",
						disposition: "degraded",
						code: "extension.provider_trust_denied",
						message: `Extension '${contribution.extensionId}' provider '${contribution.providerName}' uses command config values and was denied because the project is not trusted.`,
						details: { providerName: contribution.providerName },
					}),
				);
				continue;
			}
			const result = this.modelRegistry.registerExtensionProvider(
				contribution.providerName,
				contribution.config,
				{ extensionId: contribution.extensionId, agentId },
			);
			if (result.ok) continue;
			if (result.reason === "conflict") {
				diagnostics.push(
					createOrchestratorDiagnostic({
						...diagnosticBase,
						severity: "warning",
						disposition: "reported",
						code: "extension.provider_conflict",
						message: `Extension '${contribution.extensionId}' provider '${contribution.providerName}' conflicts with a ${result.conflictWith} provider and was skipped.`,
						details: {
							providerName: contribution.providerName,
							conflictWith: result.conflictWith,
							ownerExtensionId: result.ownerExtensionId,
						},
					}),
				);
				continue;
			}
			diagnostics.push(
				createOrchestratorDiagnostic({
					...diagnosticBase,
					severity: "error",
					disposition: "degraded",
					code: "extension.provider_invalid",
					message: `Extension '${contribution.extensionId}' provider '${contribution.providerName}' was rejected: ${result.message}`,
					details: {
						providerName: contribution.providerName,
						errorMessage: result.message,
					},
				}),
			);
		}
		if (diagnostics.length === 0) return;
		this._addAgentDiagnostics(agentId, { extensionDiagnostics: diagnostics });
		await this._publishDiagnostics(diagnostics);
	}

	private async _withdrawExtensionProviderContributions(
		agentId: AgentId,
	): Promise<void> {
		try {
			await this.modelRegistry.unregisterExtensionProviders(agentId);
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"extension.provider_unregister_failed",
				`Failed to withdraw extension providers for agent ${agentId}: ${formatError(error)}`,
				error,
			);
		}
	}

	private _bindExtensionRunner(
		agentId: AgentId,
		extensionRunner: ExtensionRunner,
	): void {
		extensionRunner.bindCore(this._createExtensionActions(), {
			getSignal: () => this._agentRunSignals.get(agentId),
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
				"before_provider_request",
				async (event) =>
					await this._runExtensionInterceptor<"before_provider_request">(
						agentId,
						extensionRunner,
						event,
					),
			),
			// The blockImages policy applies after extension results inside this
			// single handler: the harness keeps only the last non-undefined hook
			// result, so a separately registered filter hook could be overridden
			// by an extension transform.
			harness.on("context", async (event) => {
				const result = await this._runExtensionInterceptor<"context">(
					agentId,
					extensionRunner,
					event,
				);
				if (!this.settingManager.getImageSettings().blockImages) {
					return result;
				}
				return {
					messages: stripImagesFromMessages(result?.messages ?? event.messages),
				};
			}),
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
			// Extension-contributed tools get the same runner-scoped actions as
			// extension handlers; a reload re-resolves tools, so contexts never
			// outlive their runner's stale boundary.
			createExtensionContext: (source) => {
				if (source.kind !== "extension") return undefined;
				const extensionRunner =
					options.extensionRunner ??
					this._agents.get(options.agentId)?.extensionRunner;
				if (!extensionRunner) return undefined;
				return {
					extensionId: source.id,
					host: {
						agentId: options.agentId,
						profileId: options.profileId,
						actions: extensionRunner.createContext(source.id).actions,
					},
				};
			},
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
			extensionRunner ?? this._agents.get(agentId)?.extensionRunner
		)?.contributeToolsTo(registry);
		return registry;
	}

	private _createExtensionActions(): ExtensionCoreActions {
		return {
			getAgentTools: (agentId) => this.getAgentTools(agentId),
			setAgentTools: async (agentId, toolNames, activeToolNames) => {
				await this.setAgentTools(agentId, toolNames, activeToolNames);
			},
			setAgentActiveTools: async (agentId, toolNames) => {
				await this.setAgentActiveTools(agentId, toolNames);
			},
			requestHuman: async (agentId, extensionId, request) => {
				const record = this._requireAgentRecord(agentId);
				if (record.capabilities?.canRequestUser === false) {
					throw new OrchestratorError(
						createOrchestratorDiagnostic({
							severity: "error",
							code: "extension.human_request_denied",
							message: `Extension '${extensionId}' human request is denied by profile capability canRequestUser.`,
							source: { kind: "extension", id: extensionId },
							agentId,
							profileId: record.profile.reference.id,
							extensionId,
							phase: "runtime",
							recoverable: true,
						}),
					);
				}
				return await this._requestHumanForAgent(agentId, {
					...request,
					source: { kind: "extension", extensionId },
				});
			},
			emitOutput: async (agentId, extensionId, text) => {
				assertExtensionOutputText(text);
				await this._emit(
					{
						type: "extension_output",
						presentationId: this._createPresentationId(),
						agentId,
						extensionId,
						text,
						createdAt: now(),
					},
					{ observeExtensions: false },
				);
			},
			notify: async (agentId, extensionId, text) => {
				this._requireAgentRecord(agentId);
				assertExtensionNotificationText(text);
				await this._emit(
					{
						type: "extension_notification",
						presentationId: this._createPresentationId(),
						agentId,
						extensionId,
						text,
						createdAt: now(),
					},
					{ observeExtensions: false },
				);
			},
			setStatus: async (agentId, extensionId, key, status) => {
				this._requireAgentRecord(agentId);
				assertExtensionStatusKey(key);
				const validatedStatus: ExtensionStatus =
					validateExtensionStatus(status);
				const changedAt = now();
				const snapshot = this._extensionStatuses.set(
					agentId,
					extensionId,
					key,
					validatedStatus,
					changedAt,
				);
				await this._emit(
					{
						type: "extension_status_changed",
						presentationId: this._createPresentationId(),
						agentId,
						extensionId,
						key,
						status: snapshot.status,
						changedAt,
					},
					{ observeExtensions: false },
				);
			},
			clearStatus: async (agentId, extensionId, key) => {
				this._requireAgentRecord(agentId);
				assertExtensionStatusKey(key);
				if (!this._extensionStatuses.clear(agentId, extensionId, key)) {
					return;
				}
				await this._emit(
					{
						type: "extension_status_changed",
						presentationId: this._createPresentationId(),
						agentId,
						extensionId,
						key,
						changedAt: now(),
					},
					{ observeExtensions: false },
				);
			},
			reportDiagnostic: async (agentId, extensionId, draft) => {
				const record = this._requireAgentRecord(agentId);
				const validatedDraft = validateExtensionDiagnosticDraft(draft);
				const diagnostic = createOrchestratorDiagnostic({
					id: this._createReportedDiagnosticId(),
					domain: "extension",
					code: `extension.${extensionId}.${validatedDraft.code}`,
					severity: validatedDraft.severity,
					disposition: validatedDraft.disposition ?? "reported",
					recoverable: true,
					message: validatedDraft.message,
					source: { kind: "extension", id: extensionId },
					phase: "runtime",
					agentId,
					profileId: record.profile.reference.id,
					extensionId,
					details: validatedDraft.details,
				});
				this._addAgentDiagnostics(agentId, {
					extensionDiagnostics: [diagnostic],
				});
				// Extension-published facts never feed back into extension
				// observers, regardless of observer dispatch depth.
				await this._publishDiagnostic(diagnostic, {
					observeExtensions: false,
				});
			},
			publishMessage: async (agentId, extensionId, message) => {
				this._requireAgentRecord(agentId);
				const validatedMessage: ExtensionMessage =
					validateExtensionMessage(message);
				// Session write comes first: the entry id is the stable identity
				// the event and the action result both carry.
				const entryId = await this.sessionManager.appendExtensionMessageEntry(
					agentId,
					{ extensionId, message: validatedMessage },
				);
				await this._emit(
					{
						type: "extension_message_published",
						presentationId: this._createPresentationId(),
						entryId,
						agentId,
						extensionId,
						message: validatedMessage,
						createdAt: now(),
					},
					{ observeExtensions: false },
				);
				return { entryId };
			},
			promptAgent: async (agentId, text, options) => {
				await this.promptAgent(agentId, text, options);
			},
			steerAgent: async (agentId, text, options) => {
				await this.steerAgent(agentId, text, options);
			},
			followUpAgent: async (agentId, text, options) => {
				await this.followUpAgent(agentId, text, options);
			},
			setAgentSessionName: async (agentId, name) => {
				await this.setAgentSessionName(agentId, name);
			},
			getAgentSessionName: async (agentId) =>
				await this.getAgentSessionName(agentId),
			compactAgent: async (agentId, customInstructions) =>
				await this.compactAgent(agentId, customInstructions),
			setAgentModelByReference: async (agentId, reference) =>
				await this.setAgentModelByReference(agentId, reference),
			getAgentModel: (agentId) => this.getAgentModel(agentId),
			listModelCandidates: async () =>
				(await this.listAvailableModelCandidates()).models,
			getAgentThinkingLevel: (agentId) => this.getAgentThinkingLevel(agentId),
			setAgentThinkingLevel: async (agentId, level) => {
				await this.setAgentThinkingLevel(agentId, level);
			},
			abortAgent: async (agentId) => {
				await this.abortAgent(agentId);
			},
			// Trust ruling: exec runs arbitrary commands in the project cwd, so
			// it is denied until the project trust gate has passed.
			exec: async (agentId, extensionId, command, options) => {
				if (!this.settingManager.isProjectTrusted()) {
					throw new OrchestratorError(
						createOrchestratorDiagnostic({
							severity: "error",
							code: "extension.exec_denied",
							message: `Extension '${extensionId}' exec is denied because the project is not trusted.`,
							source: { kind: "extension", id: extensionId },
							agentId,
							extensionId,
							phase: "runtime",
							recoverable: true,
						}),
					);
				}
				return await this.executionEnv.exec(command, options);
			},
		};
	}

	private async _markAgentUnavailable(options: {
		agentId: AgentId;
		resolvedProfile: ResolvedAgentProfile | undefined;
		metadata: JsonlSessionMetadata;
		sessionMetadata?: AgentSessionMetadata;
		model: RuntimeModel;
		diagnostic: OrchestratorDiagnostic;
	}): Promise<void> {
		const existing = this._agents.get(options.agentId);
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
		this._agentToolSets.delete(options.agentId);
		await this._registerAgentRecord({
			...record,
			resourceDiagnostics: existing?.resourceDiagnostics
				? [...existing.resourceDiagnostics]
				: [],
			extensionDiagnostics: existing?.extensionDiagnostics
				? [...existing.extensionDiagnostics]
				: [],
			diagnostics: [...(existing?.diagnostics ?? []), options.diagnostic],
		});
	}

	private async _markExistingAgentUnavailable(
		agentId: AgentId,
		diagnostic: OrchestratorDiagnostic,
	): Promise<void> {
		const record = this._agents.get(agentId);
		if (!record) return;
		delete record.harness;
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
		await this._transitionAgentStatus(agentId, "unavailable", { force: true });
	}

	private _requireAgentRecord(agentId: AgentId): AgentRecord {
		const record = this._agents.get(agentId);
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
		const record = this._agents.get(agentId);
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
		await this._publishDiagnostics(diagnostics, {
			// A diagnostic produced while an observer is handling another event is
			// still recorded and published to core consumers, but must not feed back
			// into diagnostic observers and recurse indefinitely.
			observeExtensions:
				(this._extensionObserverDispatchDepth.get(agentId) ?? 0) === 0,
		});
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
		const record = this._agents.get(agentId);
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

			this._bindExtensionRunner(agentId, nextRunner);
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
			// Provider contributions follow the runner lifecycle: the stale
			// runner's registrations are withdrawn before the reloaded runner
			// re-registers its own.
			await this._withdrawExtensionProviderContributions(agentId);
			await this._applyExtensionProviderContributions(
				agentId,
				resolvedProfile.profile.id,
				nextRunner,
			);
			oldRunner?.invalidate("Extension runtime has been reloaded.");
			// Clear before publishing the new runner's diagnostics: diagnostic
			// events reach the new runner's observers, and statuses they set
			// must survive the reload cleanup.
			await this._clearExtensionStatusesForAgent(agentId);
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

	private async _registerAgentRecord(record: AgentRecord): Promise<void> {
		const previousStatus = this._agents.get(record.agentId)?.status;
		this._agents.set(record.agentId, record);
		await this._commitAgentStatus(record, record.status, previousStatus);
	}

	private async _transitionAgentStatus(
		agentId: AgentId,
		status: AgentLifecycleStatus,
		options: { force?: boolean } = {},
	): Promise<boolean> {
		const record = this._requireAgentRecord(agentId);
		const previousStatus = record.status;
		if (previousStatus === status) return false;
		if (
			!options.force &&
			(previousStatus === "disposed" || previousStatus === "unavailable")
		) {
			return false;
		}
		return await this._commitAgentStatus(record, status, previousStatus);
	}

	private async _commitAgentStatus(
		record: AgentRecord,
		status: AgentLifecycleStatus,
		previousStatus: AgentLifecycleStatus | undefined,
	): Promise<boolean> {
		if (previousStatus === status) return false;
		record.status = status;
		await this._emit({
			type: "agent_status_changed",
			agentId: record.agentId,
			previousStatus,
			status,
			changedAt: now(),
		});
		return true;
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
		await this._transitionAgentStatus(agentId, "running");
		try {
			return await operation(harness);
		} finally {
			if (this._requireAgentRecord(agentId).status === "running") {
				await this._transitionAgentStatus(agentId, "idle");
			}
		}
	}

	private async _updateAgentStatusFromHarnessEvent(
		agentId: AgentId,
		event: AgentHarnessEvent,
	): Promise<void> {
		if (event.type === "agent_start" || event.type === "turn_start") {
			await this._transitionAgentStatus(agentId, "running");
			return;
		}
		if (
			event.type === "agent_end" ||
			event.type === "turn_end" ||
			event.type === "abort" ||
			event.type === "settled"
		) {
			await this._transitionAgentStatus(agentId, "idle");
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
		// Auto-compaction rides the settled fact: the harness is idle and its
		// pending session writes are flushed, so the branch and the last
		// assistant usage are durable. A settled with queued next turns is
		// skipped - the next run starts immediately and compaction would race
		// its busy check.
		if (event.type === "settled" && event.nextTurnCount === 0) {
			await this._maybeAutoCompactAgent(agentId);
		}
	}

	// Threshold trigger for automatic compaction (settings compaction.enabled /
	// reserveTokens). The check consumes the same facts as the upstream
	// harness: last assistant usage on the current branch versus the model
	// context window. Failure is a warning diagnostic, never a thrown error -
	// an uncompactable over-threshold session keeps running until the provider
	// rejects it, which is the same behavior as before this trigger existed.
	private async _maybeAutoCompactAgent(agentId: AgentId): Promise<void> {
		const settings = this.settingManager.getCompactionSettings();
		if (!settings.enabled) return;
		if (this._autoCompactingAgents.has(agentId)) return;
		const record = this._agents.get(agentId);
		if (!record || record.status !== "idle" || !record.harness) return;
		this._autoCompactingAgents.add(agentId);
		try {
			const snapshot =
				await this.sessionManager.getAgentSessionSnapshot(agentId);
			const usage = getLastAssistantUsage([...snapshot.pathToRoot]);
			if (!usage) return;
			const contextTokens = calculateContextTokens(usage);
			if (!shouldCompact(contextTokens, record.model.contextWindow, settings)) {
				return;
			}
			await this.compactAgent(agentId);
		} catch (error) {
			await this._publishDiagnostic(
				createOrchestratorDiagnostic({
					severity: "warning",
					code: "compaction.auto_failed",
					message: `Automatic compaction failed for agent ${agentId}: ${formatError(error)}`,
					operationSource: { kind: "system" },
					agentId,
					phase: "runtime",
					recoverable: true,
				}),
			);
		} finally {
			this._autoCompactingAgents.delete(agentId);
		}
	}

	private async _handleSubscribedAgentHarnessEvent(
		agentId: AgentId,
		event: AgentHarnessEvent,
		signal?: AbortSignal,
	): Promise<void> {
		if (signal) {
			this._agentRunSignals.set(agentId, signal);
		}
		try {
			await this._handleAgentHarnessEvent(agentId, event);
		} finally {
			// Keep the run signal visible to settled observers, then clear only
			// the signal belonging to this run. A queued next turn may already
			// have installed its own signal while observer dispatch was pending.
			if (
				event.type === "settled" &&
				this._agentRunSignals.get(agentId) === signal
			) {
				this._agentRunSignals.delete(agentId);
			}
		}
	}

	private _isExtensionObservedEvent(
		event: OrchestratorEvent,
	): event is ExtensionObservedEvent {
		switch (event.type) {
			case "agent_harness_event":
			case "agent_resumed":
			case "agent_session_forked":
			case "agent_session_info_changed":
			case "agent_spawned":
			case "diagnostic":
			case "human_request_cancelled":
			case "human_request_pending":
			case "human_request_resolved":
			case "human_request_timeout":
			case "input_blocked":
			case "input_transformed":
				return true;
		}
		return false;
	}

	private _extensionObservedAgentId(
		event: ExtensionObservedEvent,
	): AgentId | undefined {
		return event.type === "diagnostic"
			? event.diagnostic.agentId
			: event.agentId;
	}

	private async _emitToExtensionObservers(
		event: ExtensionObservedEvent,
	): Promise<void> {
		const agentId = this._extensionObservedAgentId(event);
		if (!agentId) return;
		const extensionRunner = this._agents.get(agentId)?.extensionRunner;
		// A stale runner (agent disposed) keeps its record but must not
		// receive further events: its context actions can only fail.
		if (!extensionRunner || extensionRunner.isStale()) return;

		this._extensionObserverDispatchDepth.set(
			agentId,
			(this._extensionObserverDispatchDepth.get(agentId) ?? 0) + 1,
		);
		try {
			const diagnostics = await extensionRunner.emitObserved(event);
			await this._recordAndPublishExtensionDiagnostics(agentId, diagnostics);
		} finally {
			// Dispatches for one agent can interleave, so decrement the live
			// counter instead of restoring a pre-increment snapshot.
			const depth = this._extensionObserverDispatchDepth.get(agentId) ?? 1;
			if (depth <= 1) {
				this._extensionObserverDispatchDepth.delete(agentId);
			} else {
				this._extensionObserverDispatchDepth.set(agentId, depth - 1);
			}
		}
	}

	private async _emit(
		event: OrchestratorEvent,
		options: {
			sendToListeners?: boolean;
			sendToClients?: boolean;
			observeExtensions?: boolean;
		} = {},
	): Promise<void> {
		const listenerFailures: OrchestratorDiagnostic[] = [];
		if (options.sendToListeners !== false) {
			for (const listener of this._eventListeners) {
				try {
					await listener(event);
				} catch (error) {
					listenerFailures.push(
						createOrchestratorDiagnostic({
							severity: "warning",
							code: "orchestrator.listener_failed",
							message: formatError(error),
							disposition: "reported",
							recoverable: true,
							agentId: "agentId" in event ? event.agentId : undefined,
							details: { eventType: event.type },
						}),
					);
				}
			}
		}
		if (options.sendToClients !== false) {
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
							agentId: "agentId" in event ? event.agentId : undefined,
							details: { eventType: event.type },
						}),
						{
							sendToListeners: options.sendToListeners,
							sendToClients: false,
							observeExtensions: false,
						},
					);
				}
			}
		}
		if (
			options.observeExtensions !== false &&
			this._isExtensionObservedEvent(event)
		) {
			await this._emitToExtensionObservers(event);
		}
		for (const diagnostic of listenerFailures) {
			await this._publishDiagnostic(diagnostic, {
				sendToListeners: false,
				observeExtensions: false,
			});
		}
	}

	private async _publishDiagnostic(
		diagnostic: OrchestratorDiagnostic,
		options: {
			sendToListeners?: boolean;
			sendToClients?: boolean;
			observeExtensions?: boolean;
		} = {},
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
		options: {
			sendToListeners?: boolean;
			sendToClients?: boolean;
			observeExtensions?: boolean;
		} = {},
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

	private _createInputId(): string {
		const id = `orchestrator-input-${this._nextInputId}`;
		this._nextInputId += 1;
		return id;
	}

	private _createPresentationId(): string {
		const id = `orchestrator-presentation-${this._nextPresentationId}`;
		this._nextPresentationId += 1;
		return id;
	}

	// Every extension-reported diagnostic is an independent fact: the fresh
	// core id keeps dedupeDiagnostics from ever merging repeated reports.
	private _createReportedDiagnosticId(): string {
		const id = `orchestrator-diagnostic-${this._nextReportedDiagnosticId}`;
		this._nextReportedDiagnosticId += 1;
		return id;
	}

	private async _clearExtensionStatusesForAgent(
		agentId: AgentId,
	): Promise<void> {
		const snapshots = this._extensionStatuses.clearAgent(agentId);
		for (const snapshot of snapshots) {
			await this._emit(
				{
					type: "extension_status_changed",
					presentationId: this._createPresentationId(),
					agentId,
					extensionId: snapshot.extensionId,
					key: snapshot.key,
					changedAt: now(),
				},
				{ observeExtensions: false },
			);
		}
	}
}

function isBlockedExtensionDiagnostic(
	diagnostic: OrchestratorDiagnostic,
): boolean {
	return (
		diagnostic.domain === "extension" && diagnostic.disposition === "blocked"
	);
}

/**
 * Prompt guidance carried by an active tool. WIDI adapter tools
 * (`WidiAgentTool`) match this shape; plain Pi tools contribute nothing.
 */
export interface ToolPromptGuidance {
	name: string;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
}

/**
 * Compose the tool guidance section from the active tools' promptSnippet and
 * promptGuidelines. Snippets keep the active tool order; guidelines are
 * deduplicated by exact text so shared guidance appears once. Returns an
 * empty string when no active tool contributes guidance.
 */
export function formatToolGuidanceForSystemPrompt(
	activeTools: readonly ToolPromptGuidance[],
): string {
	const snippetLines: string[] = [];
	const guidelineLines: string[] = [];
	const seenGuidelines = new Set<string>();
	for (const tool of activeTools) {
		const snippet = tool.promptSnippet?.trim();
		if (snippet) {
			snippetLines.push(`- ${tool.name}: ${snippet}`);
		}
		for (const guideline of tool.promptGuidelines ?? []) {
			const normalized = guideline.trim();
			if (!normalized || seenGuidelines.has(normalized)) continue;
			seenGuidelines.add(normalized);
			guidelineLines.push(`- ${normalized}`);
		}
	}

	const parts: string[] = [];
	if (snippetLines.length > 0) {
		parts.push(`Available tools:\n${snippetLines.join("\n")}`);
	}
	if (guidelineLines.length > 0) {
		parts.push(`Tool guidelines:\n${guidelineLines.join("\n")}`);
	}
	return parts.join("\n\n");
}

/**
 * Compose the harness system prompt from the profile prompt plus the active
 * tools' prompt guidance and a model-visible skills listing (agentskills.io
 * block via pi-agent-core). The skills listing tells the model to read the
 * skill file, so it is only appended when a read tool is active; skills stay
 * reachable through the `<skill:...>` inline command either way.
 */
export function buildAgentSystemPrompt(
	basePrompt: string,
	resources: AgentHarnessResources,
	activeTools: readonly ToolPromptGuidance[],
): string {
	const sections = [basePrompt];
	const toolGuidance = formatToolGuidanceForSystemPrompt(activeTools);
	if (toolGuidance !== "") {
		sections.push(toolGuidance);
	}
	const hasReadTool = activeTools.some((tool) => tool.name === "read");
	if (hasReadTool) {
		const skillsSection = formatSkillsForSystemPrompt(resources.skills ?? []);
		if (skillsSection !== "") {
			sections.push(skillsSection);
		}
	}
	return sections.join("\n\n");
}

// Stale runners keep no contribution rights: resources contributed by a
// replaced runner drop out of the live loading pipelines.
function activeExtensionRunner(
	record: AgentRecord,
): ExtensionRunner | undefined {
	const runner = record.extensionRunner;
	return runner && !runner.isStale() ? runner : undefined;
}

function listResourcePathContributions(
	extensionRunner: ExtensionRunner | undefined,
	pathsOf: (contribution: ExtensionResourceContribution) => readonly string[],
): ExtensionResourcePathContribution[] {
	return (extensionRunner?.getResourceContributions() ?? []).flatMap(
		(contribution) => {
			const paths = pathsOf(contribution);
			return paths.length > 0
				? [{ extensionId: contribution.extensionId, paths }]
				: [];
		},
	);
}

// Every config-value channel in a provider config: the provider api key and
// the provider- and model-level request headers.
function hasCommandConfigValues(
	config: ProviderConfigInput,
	resolver: ConfigValueResolver,
): boolean {
	const values = [
		config.apiKey,
		...Object.values(config.headers ?? {}),
		...(config.models ?? []).flatMap((model) =>
			Object.values(model.headers ?? {}),
		),
	];
	return values.some(
		(value) => value !== undefined && resolver.isCommandConfigValue(value),
	);
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
