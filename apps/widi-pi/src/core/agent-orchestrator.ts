/**
 * AgentOrchestrator - Core abstraction for orchestrating multiple agents lifecycle and sessions management.
 *
 * This Class is shared between all run modes (interactive, print, rpc).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	AgentHarness,
	AgentHarnessError,
	type AgentHarnessEvent,
	type AgentHarnessResources,
	type AgentMessage,
	calculateContextTokens,
	type ExecutionEnv,
	getLastAssistantUsage,
	type JsonlSessionMetadata,
	type PromptTemplate,
	type Session,
	type SessionTreeEntry,
	type Skill,
	shouldCompact,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	getSupportedThinkingLevels,
	type ImageContent,
	type OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import { formatError } from "../utils/errors.ts";
import type {
	AgentBrief,
	AgentProfileBrief,
	AgentTaskOutcome,
	ToolAgentHost,
} from "./agent-host.ts";
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
	type WidiAgentHarness,
} from "./agent-record.ts";
import {
	type BackgroundJob,
	type BackgroundJobChange,
	type BackgroundJobOutcome,
	type BackgroundJobReportSnapshot,
	type BackgroundJobSettlement,
	type BackgroundJobSettleResult,
	type BackgroundJobSnapshot,
	BackgroundJobStore,
	backgroundJobResultHeaderPrefix,
	ExternalJobDependencyIndex,
	formatBackgroundJobResultMessageText,
	formatInterruptedBackgroundJobResultText,
	type PersistedBackgroundJob,
	snapshotBackgroundJob,
} from "./background/index.ts";
import type { OrchestratorClient } from "./client.ts";
import {
	type OrchestratorDiagnostic,
	OrchestratorError,
	toDiagnostic,
} from "./diagnostics.ts";
import {
	EXTENSION_OBSERVED_EVENT_NAMES,
	type ExtensionActionFailure,
	type ExtensionCoreActions,
	type ExtensionEventEnvelope,
	type ExtensionIdentity,
	type ExtensionInterceptorEventFor,
	type ExtensionInterceptorName,
	type ExtensionInterceptorResultFor,
	ExtensionLoader,
	type ExtensionModule,
	type ExtensionObservedEvent,
	ExtensionRunner,
	type ExtensionSessionSnapshot,
	type ExtensionSessionTree,
	freezeExtensionEventEnvelope,
	MAX_EXTENSION_EVENT_DISPATCH_DEPTH,
	validateExtensionEventName,
	validateExtensionEventPayload,
} from "./extension/index.ts";
import {
	assertExtensionNotificationText,
	assertExtensionOutputText,
	assertExtensionStatusKey,
	cloneExtensionInputPresentation,
	type ExtensionInputPresentation,
	type ExtensionMessage,
	type ExtensionStatus,
	type ExtensionStatusSnapshot,
	validateExtensionDiagnosticDraft,
	validateExtensionInputPresentation,
	validateExtensionMessage,
	validateExtensionStatus,
} from "./extension/presentation.ts";
import { ExtensionStatusRegistry } from "./extension/status-registry.ts";
import { HumanInterruptRegistry } from "./human-interrupt.ts";
import type {
	HumanRequest,
	HumanRequestDraft,
	HumanResponse,
} from "./human-request.ts";
import { HumanRequestBroker } from "./human-request.ts";
import { stripImagesFromMessages } from "./image-policy.ts";
import {
	assertMessageBody,
	backgroundResultMergeKey,
	type MessageDeliveryMethod,
	type MessageDeliveryPhase,
	MessageDeliveryQueue,
	type MessageDeliveryReceipt,
	type MessageDraft,
	type MessageSendOutcome,
	renderMessageEnvelope,
	transformMessage,
} from "./message.ts";
import {
	type ModelRegistry,
	modelReference,
	type ProviderConfigInput,
	parseModelReference,
	parseThinkingLevel,
	THINKING_LEVELS,
} from "./model-registry.js";
import type { ConfigValueResolver } from "./resolve-config-value.js";
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
	buildAgentSystemPrompt,
	type ToolPromptGuidance,
} from "./system-prompt.ts";
import {
	createAgentHarnessToolsFromResolvedTools,
	type ResolvedAgentHarnessTool,
	type ToolAdapterContext,
	ToolRegistry,
} from "./tool-registry.ts";
import type {
	AgentContextUsage,
	AgentId,
	AgentLifecycleStatus,
	AgentMaintenanceKind,
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
	AgentMaintenanceKind,
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

export interface AgentSessionResult {
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

export interface AgentThinkingLevelResult {
	readonly level: ThinkingLevel;
}

export interface AuthProviderCandidateListResult {
	readonly providers: readonly CandidateItem[];
}

export interface AuthCredentialCandidateListResult {
	readonly providers: readonly CandidateItem[];
}

export interface AuthProviderLoginResult {
	readonly providerId: string;
	readonly providerName: string;
}

export interface AuthProviderLogoutResult {
	readonly providerId: string;
	readonly removed: boolean;
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
	/**
	 * The agent whose tool initiated this spawn. Set only by the orchestrator
	 * itself when a spawn comes through an agent's collaboration toolset;
	 * user-side spawns (command, fork, new session, resume) leave it unset so
	 * the agent renders as a top-level entry.
	 */
	spawnedBy?: AgentId;
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
	harness: WidiAgentHarness;
}

interface AgentToolSet {
	tools: ResolvedAgentHarnessTool[];
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

/**
 * Session entries written before the harness persists the paired user message.
 * They are retracted when delivery never produces that message.
 */
interface ProvisionalPromptEntries {
	readonly previousLeafId: string | null;
	readonly lastEntryId: string;
}

interface ExtensionInputPresentationRecord {
	readonly extensionId: string;
	readonly presentation: ExtensionInputPresentation;
}

interface PendingExtensionInputPresentation
	extends ExtensionInputPresentationRecord {
	readonly expectedText?: string;
	method?: MessageDeliveryMethod;
	message?: AgentMessage;
}

interface AgentIdleWaiter {
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
}

type AgentIdleState =
	| { readonly kind: "idle" }
	| { readonly kind: "busy" }
	| { readonly kind: "gone"; readonly message: string };

type AcceptedMessage =
	| {
			readonly kind: "accepted";
			readonly receipt: MessageDeliveryReceipt;
			readonly provisional?: ProvisionalPromptEntries;
	  }
	| {
			readonly kind: "blocked";
			readonly inputId: string;
			readonly reason?: string;
			readonly blockedBy: string;
	  };

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
	private _unsubscribeAgentJobChanges: Map<AgentId, () => void> = new Map();
	private _unsubscribeAgentJobProgress: Map<AgentId, () => void> = new Map();
	private _unsubscribeAgentJobReports: Map<AgentId, () => void> = new Map();
	// Per-agent serialized tail for background job emissions (output, reports,
	// and lifecycle changes). These carry state (snapshots, revisions, absolute
	// counts, and ordered output increments), so they must reach listeners in the
	// order the table changed; `_emit` is not itself serialized. Routing every
	// job channel through one tail also makes `settled` a barrier: the final
	// output and report are enqueued ahead of the terminal event.
	private _backgroundJobEmits: Map<AgentId, Promise<void>> = new Map();
	// Job ids with an output increment already queued for emission on the tail,
	// per agent. Bounds coalescing: while a job's progress emit is queued, further
	// throttled ticks are no-ops and their bytes are folded into the pending drain
	// (`_emit` awaits observers, so an unbounded queue would grow without limit).
	private _progressQueued: Map<AgentId, Set<string>> = new Map();
	// Per-agent, per-job monotonic progress sequence. Keyed by agent because job
	// ids (`job-N`) are only unique within an agent's table.
	private _progressSequence: Map<AgentId, Map<string, number>> = new Map();
	// Latest report waiting on the serialized emission tail. Replacing the value
	// coalesces intermediate revisions while preserving one queued task per job.
	private _queuedJobReports: Map<
		AgentId,
		Map<
			string,
			{
				report: BackgroundJobReportSnapshot;
				operationRef: string;
			}
		>
	> = new Map();
	private _eventListeners: Set<OrchestratorEventListener> = new Set();
	private _extensionObserverDispatchDepth: Map<AgentId, number> = new Map();
	private _agentRunSignals: Map<AgentId, AbortSignal> = new Map();
	private _agentStatusRevisions: Map<AgentId, number> = new Map();
	private _agentToolSets: Map<AgentId, AgentToolSet> = new Map();
	private _autoCompactingAgents: Set<AgentId> = new Set();
	// Harness operations that do not run an agent loop (compaction, branch
	// summary). `AgentLifecycleStatus.running` cannot tell these apart from a
	// turn, but a steer, follow-up, or abort here would target the wrong phase.
	// Inserting before the first await also serves as the per-agent maintenance
	// lock, so a competing operation cannot overwrite the published kind.
	private _maintenanceOperations: Map<
		AgentId,
		{ readonly kind: AgentMaintenanceKind }
	> = new Map();
	// Waiters for a target's next agent-loop start, resolved from the harness's
	// own `agent_start`. Accepting a prompt any earlier would report success for
	// text the harness can still drop while it builds the turn.
	private _agentRunStartWaiters: Map<AgentId, Set<() => void>> = new Map();
	// Waiters for a target to go idle with both queues drained (the extension
	// `waitForIdle`). Settled from the same two facts the idle judgement reads:
	// a status commit, and the harness's own queue report.
	private _agentIdleWaiters: Map<AgentId, Set<AgentIdleWaiter>> = new Map();
	// Depth belongs to the causal async chain, not to the runtime as a whole:
	// independent concurrent emits must not consume one another's recursion
	// budget, while a handler's nested emit must inherit its parent's depth.
	private readonly _extensionEventDispatchContext =
		new AsyncLocalStorage<number>();
	// A shutdown request is a fact about the runtime, not about the extension
	// that asked, so the second request adds nothing for the host to act on.
	private _shutdownRequested = false;
	// Jobs waiting on a settler that is not their owner, keyed by that settler.
	// A `BackgroundJobTable` is per-agent and cannot see another agent's jobs, so
	// only the agent registry can answer which jobs a disposed agent still owes.
	private readonly _externalJobs = new ExternalJobDependencyIndex();
	// Human steers the agent loop has accepted but not read yet. A blocking tool
	// watches this so a barrier does not hold the turn open past the moment the
	// user tried to break in.
	private readonly _humanInterrupts = new HumanInterruptRegistry();
	// Agents inside `disposeAgent`, which runs a long teardown before it can
	// commit the `disposed` status. Without this marker the agent still looks
	// live for that whole window, and work registered against it there - a
	// message, or a job naming it as settler - would be accepted after the
	// teardown already swept for exactly that work. Cleared when a record is
	// registered, because a resumed session reuses its agent id.
	private readonly _disposingAgents = new Set<AgentId>();
	private readonly _extensionStatuses = new ExtensionStatusRegistry();
	private _clients: Map<string, OrchestratorClient<OrchestratorEvent>> =
		new Map();
	private readonly _messages: MessageDeliveryQueue;
	private readonly _humanRequests: HumanRequestBroker;
	private _nextInputId = 1;
	private _nextPresentationId = 1;
	private readonly _pendingExtensionInputPresentations = new Map<
		AgentId,
		PendingExtensionInputPresentation[]
	>();

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
		this._messages = new MessageDeliveryQueue({
			resolvePhase: (agentId) => this._resolveDeliveryPhase(agentId),
			deliver: async (request) => {
				if (request.method === "prompt") {
					return await this._startAgentPrompt(request.agentId, request.text, {
						images: request.images,
						reportFailure: !request.awaited,
					});
				}
				const harness = this._requireAgentHarness(request.agentId);
				const options = request.images
					? { images: [...request.images] }
					: undefined;
				if (request.method === "follow_up") {
					await harness.followUp(request.text, options);
				} else {
					const clearRevision = request.humanInterrupt
						? this._humanInterrupts.captureClearRevision(request.agentId)
						: undefined;
					await harness.steer(request.text, options);
					if (clearRevision !== undefined) {
						this._humanInterrupts.notifyIfUncleared(
							request.agentId,
							clearRevision,
						);
					}
				}
				return { method: request.method };
			},
		});
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
			recordAgentLifecycleFailure: async (agentId, code, message) => {
				await this._recordAgentLifecycleFailure(agentId, code, message);
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
			spawnedBy: options.spawnedBy,
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

	getAgentMaintenance(agentId: AgentId): AgentMaintenanceKind | undefined {
		this._requireAgentRecord(agentId);
		return this._maintenanceOperations.get(agentId)?.kind;
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
	): Promise<AgentSessionResult> {
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
	): Promise<AgentSessionResult> {
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
	): Promise<AgentSessionResult> {
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
		// The cached measurement names the previous model and its window, so it
		// stops describing anything the moment the model changes.
		await this._setAgentContextUsage(agentId, undefined);
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
			throw new OrchestratorError({
				severity: "error",
				code: "model.reference_invalid",
				message: `Model reference must use provider/model syntax: ${reference}`,
				agentId,
			});
		}
		const models = await this.modelRegistry.getAvailable();
		const model = models.find(
			(candidate) =>
				candidate.provider === parsed.provider &&
				candidate.id === parsed.modelId,
		);
		if (!model) {
			throw new OrchestratorError({
				severity: "error",
				code: "model.not_available",
				message: `Model is not available: ${parsed.provider}/${parsed.modelId}`,
				agentId,
			});
		}
		await this.setAgentModel(agentId, model);
		return model;
	}

	listAuthProviderCandidates(): AuthProviderCandidateListResult {
		const authStorage = this.modelRegistry.authStorage;
		return {
			providers: authStorage.getOAuthProviders().map((provider) => ({
				value: provider.id,
				label: provider.name,
				description: authStorage.getAuthStatus(provider.id).configured
					? "logged in"
					: undefined,
			})),
		};
	}

	/** Providers with a stored credential (OAuth or API key): logout targets. */
	async listAuthCredentialCandidates(): Promise<AuthCredentialCandidateListResult> {
		const authStorage = this.modelRegistry.authStorage;
		const oauthProviders = authStorage.getOAuthProviders();
		return {
			providers: (await authStorage.list()).map((info) => ({
				value: info.providerId,
				label:
					oauthProviders.find((provider) => provider.id === info.providerId)
						?.name ?? info.providerId,
			})),
		};
	}

	// The product entry for OAuth subscription login. Display-only steps
	// (authorization URL, device code, progress) broadcast as auth_login_*
	// events; interactive steps go through the human-request broker, so any
	// client that answers human requests can drive a login.
	async loginAuthProvider(
		providerId: string,
		options?: { agentId?: AgentId },
	): Promise<AuthProviderLoginResult> {
		const authStorage = this.modelRegistry.authStorage;
		const reference = providerId.trim();
		const provider = authStorage
			.getOAuthProviders()
			.find((candidate) => candidate.id === reference);
		if (!provider) {
			throw new OrchestratorError({
				severity: "error",
				code: "auth.provider_unknown",
				message: `Unknown auth provider: ${reference || "(none)"}. Available providers: ${authStorage
					.getOAuthProviders()
					.map((candidate) => candidate.id)
					.join(", ")}.`,
				agentId: options?.agentId,
			});
		}
		// Settling the flow withdraws provisional prompts, such as the manual
		// code input racing a local callback server.
		const settle = new AbortController();
		try {
			await authStorage.login(
				provider.id,
				this._createOAuthLoginCallbacks(
					provider.id,
					options?.agentId,
					settle.signal,
				),
			);
		} catch (error) {
			const diagnostic = toDiagnostic(error, {
				code: "auth.login_failed",
				message: `Login to ${provider.name} failed: ${formatError(error)}`,
				agentId: options?.agentId,
			});
			throw new OrchestratorError(diagnostic);
		} finally {
			settle.abort();
			// AuthStorage records persistence failures as diagnostics instead of
			// throwing; publish them so a login that could not write auth.json is
			// visibly degraded rather than silently in-memory.
			await this._publishDiagnostics(authStorage.drainDiagnostics());
		}
		// A fresh credential can change provider model composition (e.g. OAuth
		// providers whose models depend on the credential), so rebuild the
		// registry to make the models selectable immediately.
		try {
			await this.modelRegistry.refresh();
		} catch (error) {
			await this._publishDiagnostic({
				severity: "warning",
				code: "model.load_failed",
				message: `Model registry refresh after login failed: ${formatError(error)}`,
			});
		}
		return { providerId: provider.id, providerName: provider.name };
	}

	async logoutAuthProvider(
		providerId: string,
	): Promise<AuthProviderLogoutResult> {
		const authStorage = this.modelRegistry.authStorage;
		const reference = providerId.trim();
		if (!reference) {
			throw new OrchestratorError({
				severity: "error",
				code: "auth.provider_unknown",
				message: "Auth provider reference must not be empty.",
			});
		}
		const removed = authStorage.has(reference);
		await authStorage.logout(reference);
		await this._publishDiagnostics(authStorage.drainDiagnostics());
		return { providerId: reference, removed };
	}

	// Maps pi-ai OAuth login callbacks onto orchestrator facts. The manual
	// code input races a local callback server inside the provider flow, so
	// its human request is provisional: settling the flow withdraws it
	// without publishing a fault.
	private _createOAuthLoginCallbacks(
		providerId: string,
		agentId: AgentId | undefined,
		settleSignal: AbortSignal,
	): OAuthLoginCallbacks {
		const requestHuman = async (draft: HumanRequestDraft) =>
			await this._humanRequests.request(
				{ ...draft, source: { kind: "human" }, signal: settleSignal },
				{ agentId },
			);
		const inputValue = (response: HumanResponse) =>
			response.kind === "input" ? response.value : undefined;
		return {
			signal: settleSignal,
			onAuth: (info) => {
				void this._emit({
					type: "auth_login_url",
					providerId,
					agentId,
					url: info.url,
					instructions: info.instructions,
					createdAt: now(),
				});
			},
			onDeviceCode: (info) => {
				void this._emit({
					type: "auth_login_code",
					providerId,
					agentId,
					userCode: info.userCode,
					verificationUri: info.verificationUri,
					createdAt: now(),
				});
			},
			onProgress: (message) => {
				void this._emit({
					type: "auth_login_progress",
					providerId,
					agentId,
					message,
					createdAt: now(),
				});
			},
			onPrompt: async (prompt) => {
				const response = await requestHuman({
					kind: "input",
					title: prompt.message,
					placeholder: prompt.placeholder,
				});
				const value = inputValue(response);
				if (value !== undefined) return value;
				if (prompt.allowEmpty) return "";
				throw new Error("Login prompt was dismissed.");
			},
			onManualCodeInput: async () => {
				const response = await requestHuman({
					kind: "input",
					title:
						"Complete login in your browser, or paste the authorization code / redirect URL here:",
					provisional: true,
				});
				const value = inputValue(response);
				if (value === undefined) {
					throw new Error("Login input was dismissed.");
				}
				return value;
			},
			onSelect: async (prompt) => {
				const response = await requestHuman({
					kind: "select",
					title: prompt.message,
					options: prompt.options.map((option) => option.label),
				});
				const label = response.kind === "select" ? response.value : undefined;
				return prompt.options.find((option) => option.label === label)?.id;
			},
		};
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
			throw new OrchestratorError({
				severity: "error",
				code: "model.thinking_level_not_supported",
				message: `Thinking level ${level} is not supported by model ${record.model.provider}/${record.model.id}.`,
				agentId,
			});
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
			throw new OrchestratorError({
				severity: "error",
				code: "prompt_template.not_found",
				message: `Prompt template not found: ${name}`,
				agentId,
			});
		}
		return template;
	}

	/**
	 * Reloaded from disk on every listing rather than read back off the harness:
	 * a prompt template the user just edited should be usable without restarting
	 * the agent.
	 */
	private async _loadAgentPromptTemplates(
		agentId: AgentId,
	): Promise<PromptTemplate[]> {
		this._requireAgentRecord(agentId);
		const loaded = await this.resourceLoader.loadPromptTemplates();
		await this._publishDiagnostics(
			loaded.diagnostics.map((diagnostic) => ({
				severity: "warning" as const,
				code: `resource.prompt_template.${diagnostic.code}`,
				message: `${diagnostic.message} (${diagnostic.path})`,
				agentId,
			})),
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
			throw new OrchestratorError({
				severity: "error",
				code: "skill.not_found",
				message: `Skill not found: ${name}`,
				agentId,
			});
		}
		return skill;
	}

	/** Same freshness rule as prompt templates, narrowed by the agent's profile. */
	private async _loadAgentSkills(agentId: AgentId): Promise<Skill[]> {
		const profile = this._requireAgentResolvedProfile(agentId);
		const loaded = await this.resourceLoader.loadSkills(profile.skills);
		await this._publishDiagnostics(
			loaded.diagnostics.map((diagnostic) => ({
				severity: "warning" as const,
				code: `resource.skill.${diagnostic.code}`,
				message: `${diagnostic.message} (${diagnostic.path})`,
				agentId,
			})),
		);
		return loaded.skills.map(({ skill }) => skill);
	}

	async setAgentThinkingLevelByName(
		agentId: AgentId,
		levelName: string,
	): Promise<AgentThinkingLevelResult> {
		const level = parseThinkingLevel(levelName);
		if (!level) {
			throw new OrchestratorError({
				severity: "error",
				code: "model.thinking_level_invalid",
				message: `Invalid thinking level: ${levelName}. Supported levels: ${THINKING_LEVELS.join(", ")}.`,
				agentId,
			});
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
		return {
			severity: "error",
			code: "model.thinking_not_supported",
			message: `Model ${record.model.provider}/${record.model.id} does not support thinking levels.`,
			agentId: record.agentId,
		};
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
		const harness = this._requireAgentHarness(agentId);
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
		await harness.setTools(next.tools, [...next.activeToolNames]);
		this._setAgentToolSet(agentId, next);
	}

	getAgentActiveTools(agentId: AgentId): string[] {
		return [...this._requireAgentToolSet(agentId).activeToolNames];
	}

	async setAgentActiveTools(
		agentId: AgentId,
		toolNames: string[],
	): Promise<void> {
		const harness = this._requireAgentHarness(agentId);
		const currentState = this._requireAgentToolSet(agentId);
		// The harness owns the installed tools, so activation validates against
		// its live tool set with no await between the check and the apply. A
		// registry re-resolve here would race concurrent setTools/reload calls
		// and re-publish standing resolve diagnostics on every toggle.
		const installedNames = new Set(harness.getTools().map((tool) => tool.name));
		const { activeToolNames, diagnostics } = selectActiveToolNames(
			toolNames,
			installedNames,
			{ agentId },
		);
		await harness.setActiveTools(activeToolNames);
		// Re-read the harness after the await: it is the source of truth, and a
		// concurrent tool-set change must not be clobbered by our stale copy.
		const tools = harness.getTools();
		const nextActiveToolNames = harness
			.getActiveTools()
			.map((tool) => tool.name);
		this._setAgentToolSet(agentId, {
			tools,
			toolNames: tools.map((tool) => tool.name),
			requestedToolNames: currentState.requestedToolNames,
			activeToolNames: nextActiveToolNames,
			activeToolSelection: {
				mode: "explicit",
				toolNames: [...nextActiveToolNames],
			},
			profileId: currentState.profileId,
		});
		await this._publishDiagnostics(diagnostics);
	}

	/**
	 * Snapshot the agent's live backgrounded jobs: the jobs whose t0 handles the
	 * model currently holds. Running-phase jobs (still inside the pre-t0
	 * synchronous window) are not observable and are excluded.
	 */
	listAgentBackgroundJobs(agentId: AgentId): BackgroundJobSnapshot[] {
		return this._requireAgentRecord(agentId)
			.backgroundJobTable.list()
			.filter((job) => job.phase === "backgrounded")
			.map((job) => snapshotBackgroundJob(job));
	}

	/**
	 * Current rolling output tail of a live backgrounded job, or undefined when
	 * no such job is live (settled, unknown, or never backgrounded). Output is
	 * pull-only: surfaces poll this on demand; change events never carry output.
	 */
	readAgentBackgroundJobOutput(
		agentId: AgentId,
		jobId: string,
	): string | undefined {
		const job = this._requireAgentRecord(agentId).backgroundJobTable.get(jobId);
		return job?.phase === "backgrounded" ? job.output.read() : undefined;
	}

	/**
	 * Request that a live backgrounded job terminate, recording `reason` on its
	 * snapshot and its eventual t1. Returns false when no such job is live, which
	 * a caller holding a snapshot cannot rule out: the job may have settled since
	 * it was listed. Scoped to backgrounded jobs for the same reason the listing
	 * is - a running-phase job is still inside the pre-t0 window and was never
	 * observable, so no external caller can legitimately name it.
	 *
	 * The abort is a request, not a kill: a local job terminates only if its tool
	 * honors the signal, while an external job (nothing watches its signal) is
	 * settled as cancelled by the table itself.
	 */
	abortAgentBackgroundJob(
		agentId: AgentId,
		jobId: string,
		reason?: string,
	): boolean {
		const table = this._requireAgentRecord(agentId).backgroundJobTable;
		if (table.get(jobId)?.phase !== "backgrounded") return false;
		table.abort(jobId, reason);
		return true;
	}

	/**
	 * Write the terminal outcome of a job whose settler is not its owner - the
	 * shape delegated work takes: the job lives in the assigning agent's table
	 * and the agent doing the work reports the result. Symmetric with
	 * {@link abortAgentBackgroundJob}: it too only acts on backgrounded jobs and
	 * returns a result the caller has to handle rather than throwing.
	 *
	 * Authorization belongs to the table, not here: `settledBy` must match the
	 * settler recorded on the job, so anyone else gets `denied` and nothing
	 * changes.
	 */
	settleAgentBackgroundJob(
		agentId: AgentId,
		jobId: string,
		outcome: BackgroundJobOutcome,
		options: { settledBy: string },
	): BackgroundJobSettleResult {
		return this._requireAgentRecord(agentId).backgroundJobTable.settle(
			jobId,
			outcome,
			options,
		);
	}

	/**
	 * The single input arbitration point for every message an agent reads:
	 * human text, agent-to-agent messages, background job results, and system
	 * notices. Extension interception, source rendering, per-target ordering,
	 * and the choice between prompt, follow-up, and steer all happen here, so no
	 * caller can bypass an input policy or race another sender for an idle
	 * target.
	 *
	 * Resolves once the target harness owns the text, not when the target
	 * replies. A message that starts a fresh run leaves that run in the
	 * background; its failure surfaces as a diagnostic, not as a rejection here.
	 *
	 * A blocked message is a returned outcome, not a rejection: the caller knows
	 * how to report it, and only a delivery that could not happen at all throws.
	 */
	async sendMessage(draft: MessageDraft): Promise<MessageSendOutcome> {
		const accepted = await this._sendMessage(draft, {
			requiresIdle: false,
			awaited: false,
		});
		return accepted.kind === "blocked" ? accepted : { kind: "accepted" };
	}

	// The human text-input entry point: the same `sendMessage` pipeline, waiting
	// for the assistant message the calling surface is going to render.
	async promptAgent(
		agentId: AgentId,
		text: string,
		options?: {
			images?: ImageContent[];
			expansion?: PromptExpansion;
			presentation?: ExtensionInputPresentationRecord;
		},
	): Promise<PromptOutcome> {
		const accepted = await this._sendMessage(
			{
				source: { kind: "human", expansion: options?.expansion },
				targetAgentId: agentId,
				body: text,
				images: options?.images,
				mode: "next_turn",
			},
			{
				requiresIdle: true,
				awaited: true,
				presentation: options?.presentation,
			},
		);
		if (accepted.kind === "blocked") return accepted;
		const completed = accepted.receipt.completed;
		if (!completed) {
			throw new Error(
				`Prompt for agent ${agentId} was delivered as ${accepted.receipt.method} and produced no assistant message.`,
			);
		}
		try {
			return { kind: "completed", message: await completed };
		} catch (error) {
			await this._retractProvisionalEntries(agentId, accepted.provisional);
			throw error;
		}
	}

	/**
	 * Run one message through interception, session accounting, and the target's
	 * delivery queue.
	 *
	 * `requiresIdle` marks a caller that awaits the resulting run: it can only be
	 * a fresh prompt, so a busy target is refused up front rather than silently
	 * becoming a follow-up whose reply nobody is waiting for.
	 */
	private async _sendMessage(
		draft: MessageDraft,
		options: {
			requiresIdle: boolean;
			awaited: boolean;
			presentation?: ExtensionInputPresentationRecord;
		},
	): Promise<AcceptedMessage> {
		const agentId = draft.targetAgentId;
		const record = this._requireAgentRecord(agentId);
		assertMessageBody(draft.body);
		// Gate before interception and session writes: a prompt the harness would
		// reject as busy must not emit input events or strand expansion/transform
		// entries without a paired user message.
		if (options.requiresIdle) {
			this._requireAgentHarness(agentId);
			if (record.status !== "idle") {
				throw new OrchestratorError({
					severity: "error",
					code: "orchestrator.agent_busy",
					message: `Agent ${agentId} cannot accept a prompt while ${record.status}.`,
					agentId,
				});
			}
		}

		const outcome = await transformMessage(draft, {
			intercept: async (event) => {
				const runner = this._agents.get(agentId)?.extensionRunner;
				if (!runner || runner.isStale()) return { kind: "pass" };
				const run = await runner.interceptInput(event);
				await this._recordAndPublishExtensionDiagnostics(
					agentId,
					run.diagnostics,
				);
				// A block this source does not enforce is still a fact worth
				// recording: the extension asked for something the message contract
				// cannot grant it.
				if (run.kind === "block" && draft.source.kind === "background_job") {
					await this._publishDiagnostic({
						severity: "warning",
						code: "orchestrator.message_block_ignored",
						message: `Extension '${run.blockedBy}' blocked a background job result for agent ${agentId}; it was delivered anyway because the model is waiting for that result.`,
						agentId,
					});
				}
				return run;
			},
		});

		let inputId: string | undefined;
		let pendingInputTransform:
			| {
					inputId: string;
					originalText: string;
					text: string;
					transformedBy: readonly string[];
			  }
			| undefined;
		if (outcome.kind === "block") {
			inputId = this._createInputId();
			await this._emit({
				type: "input_blocked",
				agentId,
				inputId,
				originalText: draft.body,
				reason: outcome.reason,
				blockedBy: outcome.blockedBy,
				createdAt: now(),
			});
			return {
				kind: "blocked",
				inputId,
				reason: outcome.reason,
				blockedBy: outcome.blockedBy,
			};
		}
		if (outcome.kind === "transform") {
			inputId = this._createInputId();
			await this._emit({
				type: "input_transformed",
				agentId,
				inputId,
				originalText: draft.body,
				text: outcome.text,
				transformedBy: outcome.transformedBy,
				createdAt: now(),
			});
			pendingInputTransform = {
				inputId,
				originalText: draft.body,
				text: outcome.text,
				transformedBy: outcome.transformedBy,
			};
		}

		// Dual record: the user message carries the expanded text the model
		// actually sees; the custom entry preserves the original input and
		// expansion positions for UI replay. The entries pair with the user
		// message the harness persists at run start, so they are provisional
		// until that write happens: track a retraction point in case delivery
		// fails first. Only human input carries them - an agent message is
		// already traceable through the tool call that sent it.
		const expansion =
			draft.source.kind === "human" ? draft.source.expansion : undefined;
		const presentation = options.presentation
			? {
					...options.presentation,
					presentation: validateExtensionInputPresentation(
						options.presentation.presentation,
					),
				}
			: undefined;
		let provisional: ProvisionalPromptEntries | undefined;
		if (expansion || pendingInputTransform) {
			const previousLeafId =
				await this.sessionManager.getAgentSessionLeafId(agentId);
			let lastEntryId: string | undefined;
			if (expansion) {
				lastEntryId = await this.sessionManager.appendCommandExpansionEntry(
					agentId,
					{
						inputId: inputId ?? this._createInputId(),
						originalText: expansion.originalText,
						expansions: expansion.items,
					},
				);
			}
			if (pendingInputTransform) {
				lastEntryId = await this.sessionManager.appendInputTransformEntry(
					agentId,
					pendingInputTransform,
				);
			}
			if (lastEntryId !== undefined) {
				provisional = { previousLeafId, lastEntryId };
			}
		}

		// A job result is the one source with no caller left to hear about a
		// failure: its tool call already returned, and the model is waiting for
		// exactly one t1 that nobody else will resend. It is also the only source
		// whose messages merge, since each carries its own job header already.
		const jobSource =
			draft.source.kind === "background_job" ? draft.source : undefined;
		const renderedText = renderMessageEnvelope(draft.source, outcome.text);
		const pendingPresentation = presentation
			? {
					...presentation,
					expectedText: renderedText,
				}
			: undefined;
		try {
			const receipt = await this._messages.enqueue({
				targetAgentId: agentId,
				text: renderedText,
				images: outcome.images,
				mode: draft.mode,
				requiresIdle: options.requiresIdle,
				humanInterrupt: draft.source.kind === "human",
				mergeKey: jobSource ? backgroundResultMergeKey(draft.mode) : undefined,
				awaited: options.awaited,
				retryOnFailure: jobSource !== undefined,
				onDeferredFailure: jobSource
					? (error) => {
							void this._reportDeferredDeliveryFailure(
								agentId,
								jobSource.jobId,
								error,
							);
						}
					: undefined,
				onDeliveryStart: pendingPresentation
					? (method) => {
							this._beginExtensionInputPresentationDelivery(
								agentId,
								pendingPresentation,
								method,
							);
						}
					: undefined,
				onDeliveryFailure: pendingPresentation
					? () => {
							this._discardPendingExtensionInputPresentation(
								agentId,
								pendingPresentation,
							);
						}
					: undefined,
			});
			return { kind: "accepted", receipt, provisional };
		} catch (error) {
			await this._retractProvisionalEntries(agentId, provisional);
			throw error;
		}
	}

	private async _withExtensionInputPresentation(
		agentId: AgentId,
		extensionId: string,
		method: "steer" | "follow_up",
		presentation: ExtensionInputPresentation | undefined,
		deliver: () => Promise<void>,
	): Promise<void> {
		if (!presentation) {
			await deliver();
			return;
		}
		const pending: PendingExtensionInputPresentation = {
			extensionId,
			presentation: validateExtensionInputPresentation(presentation),
		};
		this._beginExtensionInputPresentationDelivery(agentId, pending, method);
		try {
			await deliver();
		} catch (error) {
			this._discardPendingExtensionInputPresentation(agentId, pending);
			throw error;
		}
	}

	private _beginExtensionInputPresentationDelivery(
		agentId: AgentId,
		pending: PendingExtensionInputPresentation,
		method: MessageDeliveryMethod,
	): void {
		this._discardPendingExtensionInputPresentation(agentId, pending);
		pending.method = method;
		delete pending.message;
		const presentations =
			this._pendingExtensionInputPresentations.get(agentId) ?? [];
		presentations.push(pending);
		this._pendingExtensionInputPresentations.set(agentId, presentations);
	}

	private _captureQueuedExtensionInputPresentation(
		agentId: AgentId,
		method: "steer" | "follow_up",
		messages: readonly AgentMessage[],
	): void {
		const message = messages.at(-1);
		if (!message) return;
		const pending = this._pendingExtensionInputPresentations
			.get(agentId)
			?.find(
				(candidate) =>
					candidate.method === method && candidate.message === undefined,
			);
		if (pending) pending.message = message;
	}

	private _takePendingExtensionInputPresentation(
		agentId: AgentId,
		message: AgentMessage,
	): PendingExtensionInputPresentation | undefined {
		if (message.role !== "user") return undefined;
		const presentations = this._pendingExtensionInputPresentations.get(agentId);
		if (!presentations) return undefined;
		let index = presentations.findIndex(
			(presentation) => presentation.message === message,
		);
		if (index < 0) {
			const text = userMessageText(message);
			index = presentations.findIndex(
				(presentation) =>
					presentation.method === "prompt" &&
					presentation.message === undefined &&
					presentation.expectedText === text,
			);
		}
		if (index < 0) return undefined;
		const [pending] = presentations.splice(index, 1);
		if (presentations.length === 0) {
			this._pendingExtensionInputPresentations.delete(agentId);
		}
		return pending;
	}

	private _discardPendingExtensionInputPresentation(
		agentId: AgentId,
		pending: PendingExtensionInputPresentation,
	): void {
		const presentations = this._pendingExtensionInputPresentations.get(agentId);
		if (!presentations) return;
		const index = presentations.indexOf(pending);
		if (index >= 0) presentations.splice(index, 1);
		if (presentations.length === 0) {
			this._pendingExtensionInputPresentations.delete(agentId);
		}
	}

	private _discardClearedExtensionInputPresentations(
		agentId: AgentId,
		messages: readonly AgentMessage[],
	): void {
		if (messages.length === 0) return;
		const cleared = new Set(messages);
		const presentations = this._pendingExtensionInputPresentations.get(agentId);
		if (!presentations) return;
		const remaining = presentations.filter(
			(presentation) =>
				presentation.message === undefined ||
				!cleared.has(presentation.message),
		);
		if (remaining.length === 0) {
			this._pendingExtensionInputPresentations.delete(agentId);
		} else if (remaining.length !== presentations.length) {
			this._pendingExtensionInputPresentations.set(agentId, remaining);
		}
	}

	private async _commitExtensionInputPresentation(
		agentId: AgentId,
		messageEntryId: string | null,
		pending: PendingExtensionInputPresentation,
	): Promise<void> {
		if (!messageEntryId) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.extension_input_presentation_failed",
				`Failed to persist extension input presentation for agent ${agentId}: the committed user message has no session entry.`,
			);
			return;
		}
		try {
			const entryId =
				await this.sessionManager.appendExtensionInputPresentationEntry(
					agentId,
					{
						messageEntryId,
						extensionId: pending.extensionId,
						presentation: pending.presentation,
					},
				);
			await this._emit(
				{
					type: "extension_input_presented",
					presentationId: this._createPresentationId(),
					entryId,
					messageEntryId,
					agentId,
					extensionId: pending.extensionId,
					presentation: cloneExtensionInputPresentation(pending.presentation),
					createdAt: now(),
				},
				{ observeExtensions: false },
			);
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.extension_input_presentation_failed",
				`Failed to persist extension input presentation for agent ${agentId}: ${formatError(error)}`,
			);
		}
	}

	// An unexpected delivery failure that will be retried at the target's next
	// phase change. Reported per attempt so a target that never accepts is
	// visible instead of silently accumulating messages.
	private async _reportDeferredDeliveryFailure(
		agentId: AgentId,
		jobId: string,
		error: unknown,
	): Promise<void> {
		await this._publishDiagnostic({
			severity: "warning",
			code: "orchestrator.background_job_delivery_failed",
			message: `Background job ${jobId} result delivery to agent ${agentId} failed, will retry at the next transition: ${formatError(error)}`,
			agentId,
		});
	}

	// If nothing was appended after the provisional entries, the user message
	// never landed: retract them so hydration cannot pair them with a later
	// message. If the branch moved on, the user message (or a concurrent write)
	// is in place and the entries stay.
	private async _retractProvisionalEntries(
		agentId: AgentId,
		provisional: ProvisionalPromptEntries | undefined,
	): Promise<void> {
		if (!provisional) return;
		try {
			await this.sessionManager.retractAgentSessionEntries(
				agentId,
				provisional,
			);
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.prompt_entry_retraction_failed",
				`Failed to retract provisional prompt entries for agent ${agentId}: ${formatError(error)}`,
			);
		}
	}

	/**
	 * Low-level harness primitive for a surface that has already decided how the
	 * text must land. It runs no interception and writes no session entries -
	 * `sendMessage` is the message entry point; this is the escape hatch under it.
	 */
	async steerAgent(
		agentId: AgentId,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<void> {
		const harness = this._requireAgentHarness(agentId);
		this._requireAgentOutsideMaintenance(agentId, "steer");
		await harness.steer(text, options);
	}

	/**
	 * Promote everything queued as a follow-up into steering, so it is read at
	 * the next turn boundary instead of only where the run would have stopped.
	 *
	 * This is the "I cannot wait for this" path of a message the surface already
	 * accepted: the text is in the harness, so re-sending it would deliver it
	 * twice and only the harness can take it back. Interception and session
	 * accounting already ran when the messages were sent - promotion changes when
	 * they are read, not what they are - so it deliberately bypasses
	 * `sendMessage`. Returns how many messages moved.
	 */
	async steerQueuedFollowUps(agentId: AgentId): Promise<number> {
		const harness = this._requireAgentHarness(agentId);
		this._requireAgentOutsideMaintenance(agentId, "steer queued follow-ups");
		const clearRevision = this._humanInterrupts.captureClearRevision(agentId);
		const promoted = await harness.promoteFollowUpsToSteer();
		if (promoted.length > 0) {
			this._humanInterrupts.notifyIfUncleared(agentId, clearRevision);
		}
		return promoted.length;
	}

	/** Low-level harness primitive; see the note on {@link steerAgent}. */

	async followUpAgent(
		agentId: AgentId,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<void> {
		const harness = this._requireAgentHarness(agentId);
		this._requireAgentOutsideMaintenance(agentId, "queue a follow-up");
		await harness.followUp(text, options);
	}

	async abortAgent(agentId: AgentId) {
		const harness = this._requireAgentHarness(agentId);
		this._requireAgentOutsideMaintenance(agentId, "abort");
		return await harness.abort();
	}

	/**
	 * Resolve once the agent is idle and nothing is waiting in either delivery
	 * queue - the same judgement `agentHasPendingMessages` reports, so callers
	 * and the agent cannot disagree about what idle means.
	 *
	 * Rejects instead of hanging when the agent can never reach that state: it
	 * is gone, being torn down, or already disposed.
	 */
	async waitForAgentIdle(
		agentId: AgentId,
		options: { signal?: AbortSignal } = {},
	): Promise<void> {
		const settled = this._resolveAgentIdleState(agentId);
		if (settled.kind === "idle") return;
		if (settled.kind === "gone") throw new Error(settled.message);
		options.signal?.throwIfAborted();

		const waiters = this._agentIdleWaiters.get(agentId) ?? new Set();
		this._agentIdleWaiters.set(agentId, waiters);
		let waiter!: AgentIdleWaiter;
		let onAbort: (() => void) | undefined;
		try {
			return await new Promise<void>((resolve, reject) => {
				waiter = { resolve, reject };
				waiters.add(waiter);
				const signal = options.signal;
				if (!signal) return;
				// Detached in the finally below: the caller's signal usually outlives
				// one wait (a run signal covers a whole turn), so a listener left
				// behind would pin this promise's closure for the signal's lifetime.
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
			});
		} finally {
			if (onAbort) options.signal?.removeEventListener("abort", onAbort);
			waiters.delete(waiter);
			if (waiters.size === 0) this._agentIdleWaiters.delete(agentId);
		}
	}

	/**
	 * Publish an extension's request to shut the runtime down. Core does not act
	 * on it: the process and the terminal belong to the host, whose own teardown
	 * (terminal restoration included) would be skipped if the orchestrator tore
	 * the agents down from underneath it. An embedder without a host calls
	 * `disposeAll` instead.
	 */
	async requestShutdown(request: {
		requestedBy: string;
		requestedByAgentId: AgentId;
		reason?: string;
	}): Promise<void> {
		if (this._shutdownRequested) return;
		this._shutdownRequested = true;
		const event: Extract<
			OrchestratorEvent,
			{ type: "runtime_shutdown_requested" }
		> = Object.freeze({
			type: "runtime_shutdown_requested",
			requestedBy: request.requestedBy,
			requestedByAgentId: request.requestedByAgentId,
			reason: request.reason,
			createdAt: now(),
		});
		// This event is the one ordering exception: a host listener may start
		// disposeAll immediately, so extension observers must finish their final
		// persistence work before the host is allowed to see the request.
		await this._emitToExtensionObservers(event);
		await this._emit(event, { observeExtensions: false });
	}

	async disposeAgent(agentId: AgentId, reason?: string): Promise<void> {
		const record = this._requireAgentRecord(agentId);
		// Stop accepting work for this agent before the sweeps below run. The
		// `disposed` status is only committed at the end of a teardown full of
		// awaits, so status alone would keep reporting a live agent long after
		// its outstanding work was already cancelled.
		this._disposingAgents.add(agentId);

		// Detach the result router and cancel live background work first, before
		// the harness is torn down. Otherwise harness.abort() below can drive a
		// settlement (a not-yet-backgrounded call rejecting) into a t1 delivery
		// against a dying harness.
		const unsubscribeJobChanges = this._unsubscribeAgentJobChanges.get(agentId);
		if (unsubscribeJobChanges) {
			try {
				unsubscribeJobChanges();
			} catch (error) {
				await this._recordAgentLifecycleFailure(
					agentId,
					"orchestrator.agent_dispose_failed",
					`Failed to unsubscribe agent ${agentId} background job listener: ${formatError(error)}`,
				);
			}
			this._unsubscribeAgentJobChanges.delete(agentId);
		}
		const unsubscribeJobProgress =
			this._unsubscribeAgentJobProgress.get(agentId);
		if (unsubscribeJobProgress) {
			try {
				unsubscribeJobProgress();
			} catch (error) {
				await this._recordAgentLifecycleFailure(
					agentId,
					"orchestrator.agent_dispose_failed",
					`Failed to unsubscribe agent ${agentId} background job progress listener: ${formatError(error)}`,
				);
			}
			this._unsubscribeAgentJobProgress.delete(agentId);
		}
		const unsubscribeJobReports = this._unsubscribeAgentJobReports.get(agentId);
		if (unsubscribeJobReports) {
			try {
				unsubscribeJobReports();
			} catch (error) {
				await this._recordAgentLifecycleFailure(
					agentId,
					"orchestrator.agent_dispose_failed",
					`Failed to unsubscribe agent ${agentId} background job report listener: ${formatError(error)}`,
				);
			}
			this._unsubscribeAgentJobReports.delete(agentId);
		}
		this._messages.cancel(
			agentId,
			reason ??
				`Agent ${agentId} was disposed before the message was delivered.`,
		);
		for (const job of record.backgroundJobTable.list()) {
			record.backgroundJobTable.abort(job.id, "Agent disposed");
		}
		// Work this agent owed to other agents cannot be settled now. Aborting the
		// owner's job settles it as cancelled and reports that through the owner's
		// normal t1 path; the owner itself stays live.
		for (const dependency of this._externalJobs.takeDependentsOf(agentId)) {
			this._agents
				.get(dependency.ownerId)
				?.backgroundJobTable.abort(
					dependency.jobId,
					reason ?? `Settler agent ${agentId} was disposed.`,
				);
		}
		// Jobs this agent owned are aborted above, but their `settled` changes no
		// longer reach the untracking listener - it was detached first, on
		// purpose. Drop the index entries explicitly: a resumed agent reuses this
		// id with a fresh table numbering from job-1, and a stale entry would
		// later cancel an unrelated job that happens to share the id.
		this._externalJobs.forgetOwner(agentId);
		this._humanInterrupts.forget(agentId);
		this._maintenanceOperations.delete(agentId);
		this._resolveAgentRunStartWaiters(agentId);
		this._rejectAgentIdleWaiters(
			agentId,
			reason ?? `Agent ${agentId} was disposed while waiting for it to idle.`,
		);
		this._backgroundJobEmits.delete(agentId);
		this._progressQueued.delete(agentId);
		this._progressSequence.delete(agentId);
		this._queuedJobReports.delete(agentId);
		this._pendingExtensionInputPresentations.delete(agentId);

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
				);
			}
			this._unsubscribeAgentExtensionInterceptors.delete(agentId);
		}

		await this._disposeExtensionRunner(
			agentId,
			record.extensionRunner,
			"Agent has been disposed.",
		);
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
			await this._publishDiagnostic({
				severity: "warning",
				code: "orchestrator.dispose_all_failed",
				message: `Failed to cleanup execution environment: ${formatError(error)}`,
			});
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

	/**
	 * Compose the agent's system prompt from the record and the runner.
	 *
	 * Read through rather than captured: an extension reload replaces the
	 * runner, and its appended sections must follow. The role's own append text
	 * comes first, then the settings, then extension sections.
	 */
	private _buildAgentSystemPrompt(
		agentId: AgentId,
		basePrompt: string,
		resources: AgentHarnessResources,
		activeTools: readonly ToolPromptGuidance[],
	): string {
		const record = this._agents.get(agentId);
		return buildAgentSystemPrompt({
			basePrompt,
			resources,
			activeTools,
			agentId,
			appendSections: [
				...(record?.systemPrompt?.appendSections ?? []),
				...(record?.extensionRunner?.getSystemPromptAppends() ?? []),
			],
			contextFiles: record?.systemPrompt?.contextFiles,
			cwd: record?.systemPrompt?.cwd,
		});
	}

	/**
	 * The system prompt the agent's next turn would be built with, composed
	 * from the harness's live resources and active tools. Read-only: the write
	 * paths stay `appendSystemPrompt` at activation and the `before_agent_start`
	 * interceptor, which can still replace this text for one turn.
	 */
	async getAgentSystemPrompt(agentId: AgentId): Promise<string> {
		const record = this._requireAgentRecord(agentId);
		const harness = this._requireAgentHarness(agentId);
		const basePrompt = record.resolvedProfile?.systemPrompt;
		if (basePrompt === undefined) {
			throw new OrchestratorError({
				severity: "error",
				code: "orchestrator.system_prompt_unavailable",
				message: `Agent ${agentId} has no resolved profile to build a system prompt from.`,
				agentId,
			});
		}
		return this._buildAgentSystemPrompt(
			agentId,
			basePrompt,
			harness.getResources(),
			harness.getActiveTools(),
		);
	}

	async compactAgent(agentId: AgentId, customInstructions?: string) {
		const result = await this._runMaintenanceOperation(
			agentId,
			"compaction",
			async (harness) => {
				return await harness.compact(customInstructions);
			},
		);
		// Compaction replaces the branch the cached measurement described, and
		// the retained tail carries the pre-compaction assistant usage, so
		// re-measuring here would report the old number as if it were current.
		// Drop it instead: the next settled measures the new branch.
		await this._setAgentContextUsage(agentId, undefined);
		return result;
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
		const previousLeafId =
			await this.sessionManager.getAgentSessionLeafId(agentId);
		try {
			return await this._runMaintenanceOperation(
				agentId,
				"tree-navigation",
				async (harness) => {
					return await harness.navigateTree(targetId, options);
				},
			);
		} finally {
			// A post-move observer can fail after the harness changed the leaf.
			// Compare in `finally` so that path still invalidates the old gauge,
			// while cancellation and no-op navigation leave it intact.
			if (
				(await this.sessionManager.getAgentSessionLeafId(agentId)) !==
				previousLeafId
			) {
				await this._setAgentContextUsage(agentId, undefined);
			}
		}
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
			throw new OrchestratorError({
				severity: "error",
				code: "profile.resolution_failed",
				message: `Cannot resume agent ${agentId}: session metadata does not contain a profile reference.`,
				agentId,
			});
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
			const diagnostic: OrchestratorDiagnostic = {
				severity: "error",
				code: "profile.resolution_failed",
				message: `Cannot resolve profile ${profileId}: ${result.reason}.`,
				agentId,
			};
			await this._publishDiagnostic(diagnostic);
			throw new OrchestratorError(diagnostic);
		}

		if (!this._isProfileEnabled(result.profile.id)) {
			const diagnostic: OrchestratorDiagnostic = {
				severity: "error",
				code: "profile.disabled",
				message: `Profile is disabled by runtime policy: ${result.profile.id}`,
				agentId,
			};
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
			const diagnostic: OrchestratorDiagnostic = {
				severity: "error",
				code: "profile.override_invalid",
				message: `Profile override cannot change profile id: ${profile.id}.`,
			};
			await this._publishDiagnostic(diagnostic);
			throw new OrchestratorError(diagnostic);
		}

		const merged: AgentProfile = {
			...profile,
			...override,
		};
		if (merged.persist && changesRecoverableProfileFields(override)) {
			const diagnostic: OrchestratorDiagnostic = {
				severity: "error",
				code: "profile.override_not_persistable",
				message: `Profile '${profile.id}' override changes recoverable profile fields and cannot create a persistent session.`,
			};
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
		options: { thinkingLevel?: ThinkingLevel; spawnedBy?: AgentId } = {},
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
				spawnedBy: options.spawnedBy,
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
			await this._emit({
				type: "agent_spawned",
				agentId,
				profile,
				model,
				spawnedBy: options.spawnedBy,
			});
			return { agentId, harness };
		} catch (error) {
			const diagnostic = toDiagnostic(error, {
				code: "orchestrator.agent_unavailable",
				message: `Cannot create agent ${agentId}: ${formatError(error)}`,
				agentId,
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
			const context =
				await this.sessionManager.buildAgentSessionContext(agentId);
			model = this._resolveResumeModel(options, context.model);
			// Resume deliberately drops `spawnedBy`: parent-child spawn
			// relationships are runtime facts and do not survive a restart, so a
			// resumed agent renders as top-level again.
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
			// Before the agent is reachable: an unanswered t0 handle is part of the
			// context the model resumes with, not a message that arrives after it.
			await this._reconcileBackgroundJobs(agentId);

			await this._transitionAgentStatus(agentId, "idle");
			await this._emit({ type: "agent_resumed", agentId, profile, model });
			return { agentId, harness };
		} catch (error) {
			const diagnostic = toDiagnostic(error, {
				code: "orchestrator.agent_unavailable",
				message: `Cannot resume agent ${agentId}: ${formatError(error)}`,
				agentId,
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
	}): Promise<WidiAgentHarness> {
		const {
			agentId,
			resolvedProfile: { profile },
			session,
			model,
		} = options;
		const extensionRunner = await this._createExtensionRunner(
			agentId,
			profile.id,
		);
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
		await this._applyExtensionProviderContributions(agentId, extensionRunner);

		const promptSettings = this.settingManager.getSystemPromptSettings();
		const includeProjectContext =
			profile.projectContext ?? promptSettings.projectContext;
		const loaded = await this.resourceLoader.loadAgentResources(profile, {
			includeProjectContext,
		});
		const resourceDiagnostics: OrchestratorDiagnostic[] =
			loaded.diagnostics.map((diagnostic) => ({ ...diagnostic, agentId }));
		await this._publishDiagnostics(resourceDiagnostics);
		this._addAgentDiagnostics(agentId, { resourceDiagnostics });

		const resources: AgentHarnessResources = {
			skills: loaded.skills.map(({ skill }) => skill),
			promptTemplates: loaded.promptTemplates.map(
				({ promptTemplate }) => promptTemplate,
			),
		};
		this._requireAgentRecord(agentId).resources = {
			skills: loaded.skills.map(({ skill, source }) => ({
				name: skill.name,
				source,
			})),
			promptTemplates: loaded.promptTemplates.map(
				({ promptTemplate, source }) => ({
					name: promptTemplate.name,
					source,
				}),
			),
		};
		// The role's own append text comes first: it is the most specific
		// statement about this agent, and the settings speak for the whole
		// installation. Extension sections follow, read per turn from the runner.
		this._requireAgentRecord(agentId).systemPrompt = {
			appendSections: [
				...(profile.appendSystemPrompt ? [profile.appendSystemPrompt] : []),
				...promptSettings.append,
			],
			contextFiles: loaded.contextFiles,
			// The resource loader's cwd, not the execution env's: it is the project
			// directory the file tools resolve their relative paths against, and
			// the prompt has to name the same one.
			cwd:
				(profile.includeCwd ?? promptSettings.includeCwd)
					? this.resourceLoader.getCwd()
					: undefined,
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

		const harness: WidiAgentHarness = new AgentHarness({
			session: session,
			models: this.modelRegistry.getRuntime(),
			toolContext: () => this._createToolAdapterContext(agentId, profile.id),
			streamOptions: this.settingManager.getProviderRetrySettings(),
			retry: this.settingManager.getRetrySettings(),
			resources: resources,
			tools: agentToolSet.tools,
			// Callback instead of a string so the skills listing tracks the
			// harness's current resources and active tools at each turn start.
			// The record is read here rather than captured: an extension reload
			// replaces the runner, and its appended sections must follow.
			systemPrompt: ({ resources: current, activeTools }) =>
				this._buildAgentSystemPrompt(
					agentId,
					profile.systemPrompt,
					current,
					activeTools,
				),
			model: model,
			thinkingLevel: options.thinkingLevel,
			activeToolNames: [...agentToolSet.activeToolNames],
		});
		const record = this._requireAgentRecord(agentId);
		record.harness = harness;
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
		record.backgroundJobStore = await this._openBackgroundJobStore(agentId);
		const jobTable = record.backgroundJobTable;
		const unsubscribeJobChanges = jobTable.onChange((change) => {
			const store = this._agents.get(agentId)?.backgroundJobStore;
			if (change.transition === "backgrounded") {
				this._externalJobs.track(agentId, change.job);
				void store?.recordBackgrounded(snapshotBackgroundJob(change.job));
			}
			if (change.transition === "aborting") {
				void store?.recordAborting(snapshotBackgroundJob(change.job));
			}
			if (change.transition === "settled") {
				// Barrier: flush the job's final output increment ahead of its
				// terminal event (same tail).
				this._enqueueBackgroundEmit(agentId, async () => {
					await this._emitJobProgress(agentId, change.job);
					this._progressSequence.get(agentId)?.delete(change.job.id);
				});
				this._externalJobs.untrack(agentId, change.job);
				// A delegated task settles through this same path: its t1 is the one
				// and only completion message the owner reads.
				void this._recordAndDeliverBackgroundJobResult(agentId, change);
			}
			this._emitBackgroundJobChange(agentId, change);
		});
		this._unsubscribeAgentJobChanges.set(agentId, unsubscribeJobChanges);
		const unsubscribeJobProgress = jobTable.onProgress((job) => {
			this._onJobProgress(agentId, job.id);
		});
		this._unsubscribeAgentJobProgress.set(agentId, unsubscribeJobProgress);
		const unsubscribeJobReports = jobTable.onReport((job, report) => {
			this._onJobReport(agentId, job, report);
		});
		this._unsubscribeAgentJobReports.set(agentId, unsubscribeJobReports);
		this._unsubscribeAgentExtensionInterceptors.set(agentId, () => {
			for (const unsubscribe of unsubscribeInterceptors) {
				unsubscribe();
			}
		});
		return harness;
	}

	/**
	 * Which extensions an agent gets is an installation-wide decision, not a
	 * property of its role: settings name them, or - naming none - every
	 * extension this runtime found is enabled. A named list can misspell an
	 * extension, so that case is worth a warning; a derived list cannot.
	 */
	private async _createExtensionRunner(
		agentId: AgentId,
		profileId: string,
	): Promise<ExtensionRunner> {
		const enabledExtensionIds = this.settingManager.getEnabledExtensions();
		const loadedExtensionScope = await this.extensionLoader.loadForAgent({
			agentId,
			profileId,
			extensionIds:
				enabledExtensionIds ?? this.extensionLoader.listAvailableExtensionIds(),
			missingExtensionSeverity: enabledExtensionIds ? "warning" : "ignore",
			divisionSelections: {
				settings: this.settingManager.getExtensionDivisionSelections(),
			},
		});
		return new ExtensionRunner({
			loadedScope: loadedExtensionScope,
		});
	}

	private async _applyExtensionProviderContributions(
		agentId: AgentId,
		extensionRunner: ExtensionRunner,
	): Promise<void> {
		const contributions = extensionRunner.getProviderContributions();
		if (contributions.length === 0) return;
		const diagnostics: OrchestratorDiagnostic[] = [];
		const projectTrusted = this.settingManager.isProjectTrusted();
		for (const contribution of contributions) {
			const diagnosticBase = {
				agentId,
				extensionId: contribution.extensionId,
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
				diagnostics.push({
					...diagnosticBase,
					severity: "error",
					code: "extension.provider_trust_denied",
					message: `Extension '${contribution.extensionId}' provider '${contribution.providerName}' uses command config values and was denied because the project is not trusted.`,
				});
				continue;
			}
			const result = this.modelRegistry.registerExtensionProvider(
				contribution.providerName,
				contribution.config,
				{ extensionId: contribution.extensionId, agentId },
			);
			if (result.ok) continue;
			if (result.reason === "conflict") {
				diagnostics.push({
					...diagnosticBase,
					severity: "warning",
					code: "extension.provider_conflict",
					message: `Extension '${contribution.extensionId}' provider '${contribution.providerName}' conflicts with a ${result.conflictWith} provider and was skipped.`,
				});
				continue;
			}
			diagnostics.push({
				...diagnosticBase,
				severity: "error",
				code: "extension.provider_invalid",
				message: `Extension '${contribution.extensionId}' provider '${contribution.providerName}' was rejected: ${result.message}`,
			});
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
				// This agent's own session needs no extra gate: the extension is
				// already running inside it and sees its messages through the
				// interceptors regardless.
				getSnapshot: async () =>
					this._toExtensionSessionSnapshot(
						await this.sessionManager.getAgentSessionSnapshot(agentId),
					),
				getTree: async () =>
					this._toExtensionSessionTree(
						await this.sessionManager.getAgentSessionTree(agentId),
					),
				getLeafId: async () =>
					await this.sessionManager.getAgentSessionLeafId(agentId),
				// The cross-session readers do widen what an extension can see -
				// every conversation recorded for this project, including ones it
				// never took part in - so they carry the same trust bar as exec.
				listSessions: async (extensionId) => {
					this._requireProjectTrustForExtension(
						agentId,
						extensionId,
						"list the project's sessions",
					);
					const candidates =
						await this.sessionManager.listAgentSessionCandidates();
					return candidates.map((candidate) => ({
						ref: this.sessionManager.toSessionHandle(candidate.path),
						id: candidate.id,
						createdAt: candidate.createdAt,
						profile: candidate.profile ? { ...candidate.profile } : undefined,
						name: candidate.name,
						firstUserMessage: candidate.firstUserMessage,
						parentRef: candidate.parentSessionPath
							? this.sessionManager.toSessionHandle(candidate.parentSessionPath)
							: undefined,
					}));
				},
				readSession: async (extensionId, ref) => {
					this._requireProjectTrustForExtension(
						agentId,
						extensionId,
						"read another session",
					);
					const tree = await this.sessionManager.readSessionSnapshot(
						this.sessionManager.resolveSessionHandle(ref),
					);
					return this._toExtensionSessionTree(tree);
				},
			},
		});
	}

	private _registerExtensionInterceptors(
		agentId: AgentId,
		harness: WidiAgentHarness,
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
			})),
		);
		const agentTools = createAgentHarnessToolsFromResolvedTools(
			resolvedTools.tools,
		);
		return {
			tools: agentTools,
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

	private _createToolAdapterContext(
		agentId: AgentId,
		profileId: string,
	): ToolAdapterContext {
		const record = this._requireAgentRecord(agentId);
		const extensionRunner = record.extensionRunner;
		return {
			backgroundJobTable: record.backgroundJobTable,
			human: {
				request: async (request) =>
					await this.requestHuman({
						...request,
						source: { kind: "agent", agentId },
					}),
			},
			agents: this._createToolAgentHost(agentId),
			humanInterrupts: this._humanInterrupts.watch(agentId),
			// The runner is captured for this turn snapshot. Calls that continue
			// in the background keep this runner and observe its stale boundary
			// after reload instead of silently switching to the replacement.
			createExtensionContext: (source) => {
				if (source.kind !== "extension" || !extensionRunner) {
					return undefined;
				}
				return {
					extensionId: source.id,
					host: {
						agentId,
						profileId,
						actions: extensionRunner.createContext(source.id).actions,
					},
				};
			},
		};
	}

	/**
	 * The collaboration port for one agent's tools. The caller's identity is
	 * captured here, never taken from tool arguments, so an agent cannot forge
	 * the sender of a message or the settler of a task. Everything else is read
	 * straight off private state, which is why the whole feature needs exactly
	 * one new public method ({@link settleAgentBackgroundJob}).
	 */
	private _createToolAgentHost(agentId: AgentId): ToolAgentHost {
		return {
			agentId,
			listProfiles: async () => {
				const result = await this.profileRegistry.listProfiles();
				await this._publishDiagnostics(result.diagnostics);
				return result.profiles
					.filter((profile) => this._isProfileEnabled(profile.id))
					.map(
						(profile): AgentProfileBrief => ({
							id: profile.id,
							label: profile.label,
							description: profile.description,
							whenToUse: profile.whenToUse,
							persist: profile.persist,
						}),
					);
			},
			// A disposed agent is not listed at all, but an unavailable one is:
			// hiding it reads as "it never existed" and invites the model to keep
			// looking for it, where the unaddressable marker ends the search.
			listAgents: () =>
				Array.from(this._agents.values())
					.filter((record) => record.status !== "disposed")
					.map((record) => this._describeAgentForTools(record)),
			describe: (targetAgentId) => {
				const record = this._agents.get(targetAgentId);
				return record ? this._describeAgentForTools(record) : undefined;
			},
			// Agent-initiated spawns carry the caller as `spawnedBy` so surfaces
			// can render the child under its parent; user-side spawns stay
			// top-level.
			spawn: async (profileId) =>
				await this.spawnAgent({ profileId, spawnedBy: agentId }),
			send: async (targetAgentId, body) =>
				await this.sendMessage({
					source: { kind: "agent", agentId },
					targetAgentId,
					body,
					// Agent messages never preempt a turn already in flight: the
					// target decides when to read them.
					mode: "next_turn",
				}),
			dispose: async (targetAgentId, reason) => {
				await this.disposeAgent(targetAgentId, reason);
			},
			settleTask: (ownerAgentId, taskId, outcome) => {
				if (!this._agents.has(ownerAgentId)) return "ignored";
				return this.settleAgentBackgroundJob(
					ownerAgentId,
					taskId,
					toBackgroundJobOutcome(outcome),
					{ settledBy: agentId },
				);
			},
		};
	}

	private _describeAgentForTools(record: AgentRecord): AgentBrief {
		return {
			agentId: record.agentId,
			profileId: record.profile.reference.id,
			label: record.profile.reference.label,
			status: record.status,
			// The same predicate the delivery queue uses, so "addressable" and
			// "will still be swept by dispose" flip at one instant rather than two.
			addressable: this._resolveDeliveryPhase(record.agentId) !== "gone",
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
			listAgentBackgroundJobs: (agentId) =>
				this.listAgentBackgroundJobs(agentId),
			readAgentBackgroundJobOutput: (agentId, jobId) =>
				this.readAgentBackgroundJobOutput(agentId, jobId),
			abortAgentBackgroundJob: (agentId, jobId, reason) =>
				this.abortAgentBackgroundJob(agentId, jobId, reason),
			setAgentTools: async (agentId, toolNames, activeToolNames) => {
				await this.setAgentTools(agentId, toolNames, activeToolNames);
			},
			setAgentActiveTools: async (agentId, toolNames) => {
				await this.setAgentActiveTools(agentId, toolNames);
			},
			requestHuman: async (agentId, extensionId, request) => {
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
				this._requireAgentRecord(agentId);
				const validatedDraft = validateExtensionDiagnosticDraft(draft);
				const diagnostic: OrchestratorDiagnostic = {
					code: `extension.${extensionId}.${validatedDraft.code}`,
					severity: validatedDraft.severity,
					message: validatedDraft.message,
					agentId,
					extensionId,
				};
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
				const entryData = Object.freeze({
					extensionId,
					message: validatedMessage,
				});
				// Session write comes first: the entry id is the stable identity
				// the event and the action result both carry.
				const entryId = await this.sessionManager.appendExtensionMessageEntry(
					agentId,
					entryData,
				);
				const event: Extract<
					OrchestratorEvent,
					{ type: "extension_message_published" }
				> = Object.freeze({
					type: "extension_message_published",
					presentationId: this._createPresentationId(),
					entryId,
					agentId,
					extensionId,
					message: validatedMessage,
					createdAt: now(),
				});
				await this._emit(event, { observeExtensions: false });
				return { entryId };
			},
			// Prompt carries its presentation through the message pipeline, where a
			// block returns before any session write: a presentation is never
			// recorded for a message an interceptor refused.
			promptAgent: async (agentId, extensionId, text, options) => {
				await this.promptAgent(agentId, text, {
					images: options?.images,
					presentation: options?.presentation
						? { extensionId, presentation: options.presentation }
						: undefined,
				});
			},
			steerAgent: async (agentId, extensionId, text, options) => {
				await this._withExtensionInputPresentation(
					agentId,
					extensionId,
					"steer",
					options?.presentation,
					async () => {
						await this.steerAgent(agentId, text, { images: options?.images });
					},
				);
			},
			followUpAgent: async (agentId, extensionId, text, options) => {
				await this._withExtensionInputPresentation(
					agentId,
					extensionId,
					"follow_up",
					options?.presentation,
					async () => {
						await this.followUpAgent(agentId, text, {
							images: options?.images,
						});
					},
				);
			},
			getAgentContextUsage: (agentId) => {
				const usage = this._requireAgentRecord(agentId).contextUsage;
				return usage ? { ...usage } : undefined;
			},
			isProjectTrusted: () => this.settingManager.isProjectTrusted(),
			getAgentSystemPrompt: async (agentId) =>
				await this.getAgentSystemPrompt(agentId),
			// Both queues count: the orchestrator's, holding messages not yet
			// handed over, and the harness's, holding messages handed over but not
			// yet read. Checking only the first reported "nothing pending" for text
			// an extension had just queued through steer/followUp.
			agentHasPendingMessages: (agentId) => {
				const record = this._requireAgentRecord(agentId);
				return (
					this._messages.hasPending(agentId) ||
					(record.harnessQueuedMessageCount ?? 0) > 0
				);
			},
			waitForAgentIdle: async (agentId, options) => {
				await this.waitForAgentIdle(agentId, options);
			},
			emitExtensionEvent: async (agentId, extensionId, name, payload) => {
				this._requireAgentRecord(agentId);
				await this._emitExtensionEvent({
					name: validateExtensionEventName(name),
					payload: validateExtensionEventPayload(payload),
					sourceExtensionId: extensionId,
					sourceAgentId: agentId,
					emittedAt: now(),
				});
			},
			requestRuntimeShutdown: async (agentId, extensionId, reason) => {
				this._requireAgentRecord(agentId);
				await this.requestShutdown({
					requestedBy: extensionId,
					requestedByAgentId: agentId,
					reason,
				});
			},
			disposeRuntime: async (agentId, extensionId, reason) => {
				this._requireAgentRecord(agentId);
				await this.disposeAll(
					reason ??
						`Extension '${extensionId}' disposed the runtime from agent ${agentId}.`,
				);
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
					throw new OrchestratorError({
						severity: "error",
						code: "extension.exec_denied",
						message: `Extension '${extensionId}' exec is denied because the project is not trusted.`,
						agentId,
						extensionId,
					});
				}
				return await this.executionEnv.exec(command, options);
			},
		};
	}

	// Project the internal snapshot onto the extension-facing shape: identity
	// and conversation, no filesystem layout. An ephemeral session has no
	// persisted file and therefore no ref.
	private _toExtensionSessionSnapshot(
		snapshot: AgentSessionSnapshot,
	): ExtensionSessionSnapshot {
		const metadata = snapshot.metadata;
		const path =
			"path" in metadata && typeof metadata.path === "string"
				? metadata.path
				: undefined;
		return {
			ref: path ? this.sessionManager.toSessionHandle(path) : undefined,
			id: metadata.id,
			name: snapshot.name,
			leafId: snapshot.leafId,
			pathToRoot: cloneSessionEntries(snapshot.pathToRoot),
		};
	}

	private _toExtensionSessionTree(
		snapshot: AgentSessionTreeSnapshot,
	): ExtensionSessionTree {
		return {
			...this._toExtensionSessionSnapshot(snapshot),
			entries: cloneSessionEntries(snapshot.entries),
		};
	}

	// Trust gate for extension actions that reach beyond the agent's own
	// session. `action` completes "... is denied because the project is not
	// trusted", so phrase it as the thing being attempted.
	private _requireProjectTrustForExtension(
		agentId: AgentId,
		extensionId: string,
		action: string,
	): void {
		if (this.settingManager.isProjectTrusted()) return;
		throw new OrchestratorError({
			severity: "error",
			code: "extension.session_read_denied",
			message: `Extension '${extensionId}' may not ${action} because the project is not trusted.`,
			agentId,
			extensionId,
		});
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
			diagnostic.extensionId !== undefined &&
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

	/**
	 * The profile an agent was built from. Refuses rather than falling back for a
	 * record that never got one - a session registered as unavailable has only a
	 * stored profile reference, and answering its resource questions from an
	 * unnarrowed default would hand it resources its role never granted.
	 */
	private _requireAgentResolvedProfile(agentId: AgentId): AgentProfile {
		const record = this._requireAgentRecord(agentId);
		if (!record.resolvedProfile) {
			throw new OrchestratorError({
				severity: "error",
				code: "profile.unresolved",
				message: `Agent ${agentId} has no resolved profile: its profile '${record.profile.reference.id}' never loaded.`,
				agentId,
			});
		}
		return record.resolvedProfile;
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
	): Promise<void> {
		const diagnostic: OrchestratorDiagnostic = {
			severity: "warning",
			code,
			message,
			agentId,
		};
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
		failure: ExtensionActionFailure;
	}): OrchestratorDiagnostic {
		const { failure } = options;
		return {
			code: failure.code,
			severity: "warning",
			message: `Extension '${failure.extensionId}' action '${failure.action}' failed: ${formatError(failure.error)}`,
			agentId: options.agentId,
			extensionId: failure.extensionId,
		};
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

		let candidateRunner: ExtensionRunner | undefined;
		let candidateInstalled = false;
		try {
			const harness = this._requireAgentHarness(agentId);
			const currentToolSet = this._requireAgentToolSet(agentId);
			const oldRunner = record.extensionRunner;
			const profileId = record.profile.reference.id;
			const nextRunner = await this._createExtensionRunner(agentId, profileId);
			candidateRunner = nextRunner;
			const nextToolSet = await this._resolveAgentTools({
				agentId,
				profileId,
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
			// Install the replacement before the awaited harness write: a turn
			// starting mid-reload snapshots record.extensionRunner into its tool
			// context, and must capture the new runner rather than pin the old
			// one across its own disposal below.
			record.extensionRunner = nextRunner;
			this._setAgentToolSet(agentId, nextToolSet);
			try {
				await harness.setTools(nextToolSet.tools, [
					...nextToolSet.activeToolNames,
				]);
			} catch (error) {
				record.extensionRunner = oldRunner;
				this._setAgentToolSet(agentId, currentToolSet);
				throw error;
			}
			candidateInstalled = true;

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
			record.extensionDiagnostics = [...nextRunner.diagnostics];
			record.diagnostics.push(...nextRunner.diagnostics);
			// Provider contributions follow the runner lifecycle: the stale
			// runner's registrations are withdrawn before the reloaded runner
			// re-registers its own.
			await this._withdrawExtensionProviderContributions(agentId);
			await this._applyExtensionProviderContributions(agentId, nextRunner);
			await this._disposeExtensionRunner(
				agentId,
				oldRunner,
				"Extension runtime has been reloaded.",
			);
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
			if (candidateRunner && !candidateInstalled) {
				await this._disposeExtensionRunner(
					agentId,
					candidateRunner,
					"Extension reload failed before installation.",
				);
			}
			const diagnostic = this._createExtensionReloadDiagnostic({
				code: "extension.reload_agent_failed",
				severity: "error",
				message: `Failed to reload extensions for agent ${agentId}: ${formatError(error)}`,
				agentId,
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
	}): OrchestratorDiagnostic {
		return {
			severity: options.severity,
			code: options.code,
			message: options.message,
			agentId: options.agentId,
		};
	}

	private async _registerAgentRecord(record: AgentRecord): Promise<void> {
		const previousStatus = this._agents.get(record.agentId)?.status;
		this._disposingAgents.delete(record.agentId);
		this._agents.set(record.agentId, record);
		await this._commitAgentStatus(record, record.status, previousStatus);
	}

	private async _transitionAgentStatus(
		agentId: AgentId,
		status: AgentLifecycleStatus,
		options: { force?: boolean; maintenance?: AgentMaintenanceKind } = {},
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
		return await this._commitAgentStatus(
			record,
			status,
			previousStatus,
			options.maintenance,
		);
	}

	private async _commitAgentStatus(
		record: AgentRecord,
		status: AgentLifecycleStatus,
		previousStatus: AgentLifecycleStatus | undefined,
		maintenance?: AgentMaintenanceKind,
	): Promise<boolean> {
		if (previousStatus === status) return false;
		record.status = status;
		this._agentStatusRevisions.set(
			record.agentId,
			(this._agentStatusRevisions.get(record.agentId) ?? 0) + 1,
		);
		await this._emit({
			type: "agent_status_changed",
			agentId: record.agentId,
			previousStatus,
			status,
			maintenance,
			changedAt: now(),
		});
		this._messages.wake(record.agentId);
		this._settleAgentIdleWaiters(record.agentId);
		return true;
	}

	private async _disposeAgentHarness(
		agentId: AgentId,
		harness: WidiAgentHarness,
	): Promise<void> {
		try {
			await harness.abort();
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.agent_dispose_failed",
				`Failed to abort agent ${agentId} during dispose: ${formatError(error)}`,
			);
		}
		try {
			await harness.waitForIdle();
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.agent_dispose_failed",
				`Failed waiting for agent ${agentId} to become idle during dispose: ${formatError(error)}`,
			);
		}
	}

	private async _disposeExtensionRunner(
		agentId: AgentId,
		extensionRunner: ExtensionRunner | undefined,
		message: string,
	): Promise<void> {
		if (!extensionRunner) return;
		try {
			await extensionRunner.dispose(message);
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.agent_dispose_failed",
				`Failed to dispose extension runtime for agent ${agentId}: ${formatError(error)}`,
			);
		}
	}

	/**
	 * Hand a settled background job (t1) to the message pipeline. It is an
	 * ordinary message from then on: queued behind whatever the target already
	 * has, merged with adjacent results into one user message, and delivered as
	 * a steer or a fresh prompt depending on the target's phase.
	 *
	 * Persist first, deliver second. The two must not race: a crash between them
	 * has to leave a recorded job whose result the next resume can still deliver,
	 * never a delivered result whose job left no trace.
	 */
	private async _recordAndDeliverBackgroundJobResult(
		agentId: AgentId,
		settlement: BackgroundJobSettlement,
	): Promise<void> {
		const messageText = formatBackgroundJobResultMessageText(settlement);
		await this._agents.get(agentId)?.backgroundJobStore?.recordSettled(
			snapshotBackgroundJob(settlement.job, {
				status: settlement.outcome.status,
			}),
			{ messageText, outputTail: settlement.job.output.read() },
		);
		await this._deliverBackgroundJobResult(
			agentId,
			settlement.job.id,
			messageText,
		);
	}

	/**
	 * Hand a settled job's text to its owner.
	 *
	 * `interrupt`, so a running owner reads it at the next turn boundary instead
	 * of only when its run would have ended. Neither mode preempts a turn already
	 * in flight - `steer` is a turn-boundary injection, not a stream abort - but
	 * `next_turn` degrades to a follow-up, which the agent loop drains only where
	 * it would otherwise stop: a job that settles early in a long tool chain
	 * would sit unread for the rest of the run. A result the model was told to
	 * expect should reach it at the first point it can act on it.
	 */
	private async _deliverBackgroundJobResult(
		agentId: AgentId,
		jobId: string,
		body: string,
	): Promise<void> {
		try {
			await this.sendMessage({
				source: { kind: "background_job", ownerAgentId: agentId, jobId },
				targetAgentId: agentId,
				body,
				mode: "interrupt",
			});
		} catch (error) {
			// Retryable failures keep the result queued, so reaching here means the
			// owner can never take it: the model will not see this job's outcome.
			await this._publishDiagnostic({
				severity: "warning",
				code: "orchestrator.background_job_dropped",
				message: `Dropping the result of background job ${jobId} for agent ${agentId}: ${formatError(error)}`,
				agentId,
			});
		}
	}

	/**
	 * Open the agent's durable job log. An ephemeral session owns no directory,
	 * and a store that cannot be opened is a degraded surface rather than a
	 * reason to fail the agent: jobs keep running, they just stop being
	 * recoverable across a restart.
	 */
	private async _openBackgroundJobStore(
		agentId: AgentId,
	): Promise<BackgroundJobStore | undefined> {
		let sessionDir: string | undefined;
		try {
			sessionDir = await this.sessionManager.getAgentSessionDir(agentId);
		} catch {
			sessionDir = undefined;
		}
		if (sessionDir === undefined) return undefined;
		try {
			return await BackgroundJobStore.open({
				fs: this.executionEnv,
				sessionDir,
				onWriteFailure: (error) => {
					void this._publishDiagnostic({
						severity: "warning",
						code: "orchestrator.background_job_store_write_failed",
						message: `Background jobs for agent ${agentId} are no longer being recorded; results of jobs still running will not survive a restart: ${formatError(error)}`,
						agentId,
					});
				},
			});
		} catch (error) {
			await this._publishDiagnostic({
				severity: "warning",
				code: "orchestrator.background_job_store_unavailable",
				message: `Cannot record background jobs for agent ${agentId}: ${formatError(error)}`,
				agentId,
			});
			return undefined;
		}
	}

	/**
	 * Answer every t0 handle a previous runtime left open on this session.
	 *
	 * The jobs themselves are gone - a local job is a promise in a process that
	 * exited - so this recovers the conversation, not the work: each unanswered
	 * handle gets exactly one closing message, either the outcome that was
	 * recorded before the exit or a cancellation explaining the restart.
	 *
	 * The session history, not the job log, decides what is unanswered: a
	 * message queued into a harness is not persisted, so acceptance is not
	 * evidence the model ever read it. Appending straight into the branch rather
	 * than delivering through the message pipeline keeps that decision honest -
	 * the text is in the session the moment this returns, so a second interrupted
	 * resume finds it and stays idempotent - and keeps a resume from starting a
	 * model run nobody asked for over results that are already stale.
	 */
	private async _reconcileBackgroundJobs(agentId: AgentId): Promise<void> {
		const store = this._agents.get(agentId)?.backgroundJobStore;
		const carriedOver = store?.carriedOverJobs() ?? [];
		if (carriedOver.length === 0) return;
		const harness = this._agents.get(agentId)?.harness;
		if (!harness) return;
		const snapshot = await this.sessionManager.getAgentSessionSnapshot(agentId);
		const branchText = collectUserMessageText(snapshot.pathToRoot);
		const unanswered = carriedOver.filter(
			(job) =>
				!branchText.some((text) =>
					text.includes(
						backgroundJobResultHeaderPrefix(job.jobId, job.toolCallId),
					),
				),
		);
		if (unanswered.length === 0) return;
		await harness.appendMessage({
			role: "user",
			content: [
				{
					type: "text",
					text: unanswered.map(toCarriedOverJobResultText).join("\n\n"),
				},
			],
			timestamp: Date.now(),
		});
		await this._publishDiagnostic({
			severity: "warning",
			code: "orchestrator.background_jobs_interrupted",
			message: `Agent ${agentId} resumed with ${unanswered.length} background job result(s) left unanswered by a previous run; they were closed in the session.`,
			agentId,
		});
	}

	/**
	 * Every background job recorded in this agent's session, across runs. Unlike
	 * {@link listAgentBackgroundJobs}, which sees only the live table, this is
	 * the history: settled jobs, and jobs a previous runtime never settled.
	 */
	backgroundJobHistory(agentId: AgentId): PersistedBackgroundJob[] {
		return (
			this._requireAgentRecord(agentId).backgroundJobStore?.history() ?? []
		);
	}

	/**
	 * Chain a background emission (progress or lifecycle change) onto the agent's
	 * serialized tail so emissions reach listeners in the order the table changed,
	 * regardless of per-emit `_emit` duration. Failures are swallowed so one bad
	 * emit cannot break the chain for later ones.
	 */
	private _enqueueBackgroundEmit(
		agentId: AgentId,
		task: () => Promise<void>,
	): void {
		const prior = this._backgroundJobEmits.get(agentId) ?? Promise.resolve();
		const next = prior.then(task).catch(() => {});
		this._backgroundJobEmits.set(agentId, next);
	}

	/**
	 * Publish a table change as an `agent_background_job_changed` event so
	 * surfaces can track the agent's outstanding pseudo-async work per job. A
	 * settled job is already removed from the table, so the live count reflects
	 * the change.
	 */
	private _emitBackgroundJobChange(
		agentId: AgentId,
		change: BackgroundJobChange,
	): void {
		const record = this._agents.get(agentId);
		if (!record) return;
		// Snapshot the job, count, and timestamp now, at the moment of the change,
		// then chain the emit onto this agent's tail so events reach listeners in
		// the order the table changed rather than in async completion order.
		const job = snapshotBackgroundJob(
			change.job,
			change.transition === "settled"
				? { status: change.outcome.status }
				: undefined,
		);
		const liveCount = record.backgroundJobTable
			.list()
			.filter((live) => live.phase === "backgrounded").length;
		const changedAt = now();
		this._enqueueBackgroundEmit(agentId, () =>
			this._emit({
				type: "agent_background_job_changed",
				agentId,
				job,
				transition: change.transition,
				liveCount,
				changedAt,
			}),
		);
	}

	/**
	 * Coalesce a latest-value structured report while preserving its position on
	 * the per-agent background emission tail. A later revision replaces the
	 * pending value instead of growing an unbounded event queue.
	 */
	private _onJobReport(
		agentId: AgentId,
		job: BackgroundJob,
		report: BackgroundJobReportSnapshot,
	): void {
		const queued = this._queuedJobReports.get(agentId) ?? new Map();
		const alreadyQueued = queued.has(job.id);
		queued.set(job.id, { report, operationRef: job.toolCallId });
		this._queuedJobReports.set(agentId, queued);
		if (alreadyQueued) return;
		this._enqueueBackgroundEmit(agentId, async () => {
			const latest = queued.get(job.id);
			queued.delete(job.id);
			if (queued.size === 0) this._queuedJobReports.delete(agentId);
			if (!latest) return;
			// Persist the coalesced value, not every revision: the store keeps a
			// latest-value register, so intermediate revisions would only cost
			// writes.
			void this._agents
				.get(agentId)
				?.backgroundJobStore?.recordReport(job.id, latest.report);
			await this._emit({
				type: "agent_background_job_report_updated",
				agentId,
				jobId: job.id,
				report: latest.report,
				changedAt: new Date(latest.report.updatedAt).toISOString(),
				operationRef: latest.operationRef,
			});
		});
	}

	/**
	 * React to a throttled output-progress tick: queue a single coalesced emit for
	 * the job on the agent's tail. While one is queued, further ticks are no-ops —
	 * their bytes accumulate in the job's increment buffer and are drained
	 * together when the queued task runs.
	 */
	private _onJobProgress(agentId: AgentId, jobId: string): void {
		const queued = this._progressQueued.get(agentId) ?? new Set<string>();
		if (queued.has(jobId)) return;
		queued.add(jobId);
		this._progressQueued.set(agentId, queued);
		this._enqueueBackgroundEmit(agentId, async () => {
			queued.delete(jobId);
			const job = this._agents.get(agentId)?.backgroundJobTable.get(jobId);
			// A settled job is gone from the table; its final increment is flushed by
			// the `settled` barrier instead.
			if (job) await this._emitJobProgress(agentId, job);
		});
	}

	/**
	 * Drain the job's pending output increment and, when non-empty, emit it as an
	 * `agent_background_job_progress` event. No-op when nothing new was appended
	 * since the previous drain.
	 */
	private async _emitJobProgress(
		agentId: AgentId,
		job: BackgroundJob,
	): Promise<void> {
		const increment = job.output.drainIncrement();
		if (!increment) return;
		const sequences =
			this._progressSequence.get(agentId) ?? new Map<string, number>();
		const sequence = sequences.get(job.id) ?? 0;
		sequences.set(job.id, sequence + 1);
		this._progressSequence.set(agentId, sequences);
		await this._emit({
			type: "agent_background_job_progress",
			agentId,
			jobId: job.id,
			sequence,
			chunk: increment.chunk,
			startByte: increment.startByte,
			endByte: increment.endByte,
			totalBytesSeen: increment.totalBytesSeen,
			progressDroppedBytes: increment.progressDroppedBytes,
			observedAt: now(),
			operationRef: job.toolCallId,
		});
	}

	/**
	 * Start a fresh run for a delivered message and return once the harness has
	 * genuinely taken the text, leaving the model run itself in the background.
	 *
	 * Acceptance waits for the harness's own `agent_start`. Everything the
	 * harness does before that - building the turn context, session metadata,
	 * the tool context, the `before_agent_start` hook - is asynchronous and can
	 * fail, and a failure there means the user message was never persisted. If
	 * acceptance resolved earlier, the queue would have dropped a message the
	 * target never received, and a background job result would be lost for good.
	 *
	 * `reportFailure` belongs to callers that do not await the run themselves:
	 * their failure has no other way to surface. When the enqueuing caller awaits
	 * `receipt.completed`, the error reaches it directly and a second diagnostic
	 * would only duplicate it.
	 */
	private async _startAgentPrompt(
		agentId: AgentId,
		text: string,
		options: {
			images?: readonly ImageContent[];
			reportFailure: boolean;
		},
	): Promise<MessageDeliveryReceipt> {
		const record = this._requireAgentRecord(agentId);
		const harness = this._requireAgentHarness(agentId);
		if (record.status !== "idle") {
			throw new AgentHarnessError(
				"busy",
				`Agent ${agentId} cannot accept a prompt while ${record.status}.`,
			);
		}

		await this._transitionAgentStatus(agentId, "running");
		const statusRevision = this._agentStatusRevisions.get(agentId) ?? 0;
		const started = this._awaitAgentRunStart(agentId);
		const run = harness.prompt(text, {
			images: options.images ? [...options.images] : undefined,
		});
		// A run that settles without ever starting a loop is still resolved here:
		// the alternative is waiting forever for a signal that is not coming.
		const start = await Promise.race([
			started.reached,
			run.then(
				() => ({ kind: "started" }) as const,
				(error: unknown) => ({ kind: "rejected", error }) as const,
			),
		]);
		started.cancel();
		if (start.kind === "rejected") {
			// A busy rejection means another harness operation won the race. Keep
			// the runtime status running so the queue retries as a follow-up.
			if (
				!(
					start.error instanceof AgentHarnessError &&
					start.error.code === "busy"
				) &&
				this._agentStatusRevisions.get(agentId) === statusRevision &&
				this._agents.get(agentId)?.status === "running"
			) {
				await this._transitionAgentStatus(agentId, "idle");
			}
			throw start.error;
		}

		void this._finishAgentPrompt(agentId, run, statusRevision, options).catch(
			() => {},
		);
		return { method: "prompt", completed: run };
	}

	/**
	 * A pending observation of the target's next agent-loop start. The waiter is
	 * registered before the prompt call so a fast `agent_start` cannot be missed.
	 */
	private _awaitAgentRunStart(agentId: AgentId): {
		readonly reached: Promise<{ readonly kind: "started" }>;
		readonly cancel: () => void;
	} {
		const waiters = this._agentRunStartWaiters.get(agentId) ?? new Set();
		this._agentRunStartWaiters.set(agentId, waiters);
		let waiter!: () => void;
		const reached = new Promise<{ readonly kind: "started" }>((resolve) => {
			waiter = () => resolve({ kind: "started" });
			waiters.add(waiter);
		});
		return {
			reached,
			cancel: () => {
				waiters.delete(waiter);
				if (waiters.size === 0) this._agentRunStartWaiters.delete(agentId);
			},
		};
	}

	private _resolveAgentRunStartWaiters(agentId: AgentId): void {
		const waiters = this._agentRunStartWaiters.get(agentId);
		if (!waiters) return;
		this._agentRunStartWaiters.delete(agentId);
		for (const waiter of waiters) waiter();
	}

	/**
	 * Whether the agent is idle now, will never be, or is simply still busy.
	 * `creating` counts as busy: the agent is on its way to a first idle.
	 */
	private _resolveAgentIdleState(agentId: AgentId): AgentIdleState {
		const record = this._agents.get(agentId);
		if (!record || this._disposingAgents.has(agentId)) {
			return { kind: "gone", message: `Agent ${agentId} is gone.` };
		}
		if (record.status === "disposed" || record.status === "unavailable") {
			return {
				kind: "gone",
				message: `Agent ${agentId} is ${record.status}.`,
			};
		}
		if (record.status !== "idle") return { kind: "busy" };
		const pending =
			this._messages.hasPending(agentId) ||
			(record.harnessQueuedMessageCount ?? 0) > 0;
		return pending ? { kind: "busy" } : { kind: "idle" };
	}

	private _settleAgentIdleWaiters(agentId: AgentId): void {
		const waiters = this._agentIdleWaiters.get(agentId);
		if (!waiters || waiters.size === 0) return;
		const state = this._resolveAgentIdleState(agentId);
		if (state.kind === "busy") return;
		// The waiter's own finally removes it from the set; snapshot first so
		// settling one cannot skip the next.
		for (const waiter of [...waiters]) {
			if (state.kind === "idle") waiter.resolve();
			else waiter.reject(new Error(state.message));
		}
	}

	private _rejectAgentIdleWaiters(agentId: AgentId, message: string): void {
		const waiters = this._agentIdleWaiters.get(agentId);
		if (!waiters) return;
		for (const waiter of [...waiters]) waiter.reject(new Error(message));
		this._agentIdleWaiters.delete(agentId);
	}

	/**
	 * Relay one extension event to every live extension runtime.
	 *
	 * Runtime-level by construction: the runners are the subscriber set, so a
	 * reload swaps subscriptions with the runner it replaced and disposal drops
	 * them, with no second lifecycle to keep in step. A stale runner is skipped
	 * for the same reason observers skip it - its context actions can only fail.
	 */
	private async _emitExtensionEvent(
		envelope: ExtensionEventEnvelope,
	): Promise<void> {
		const immutableEnvelope = freezeExtensionEventEnvelope(envelope);
		const dispatchDepth = this._extensionEventDispatchContext.getStore() ?? 0;
		if (dispatchDepth >= MAX_EXTENSION_EVENT_DISPATCH_DEPTH) {
			await this._publishDiagnostic(
				{
					severity: "warning",
					code: "extension.event_recursion_dropped",
					message: `Extension event '${immutableEnvelope.name}' from '${immutableEnvelope.sourceExtensionId}' was dropped after ${MAX_EXTENSION_EVENT_DISPATCH_DEPTH} nested dispatches.`,
					agentId: immutableEnvelope.sourceAgentId,
					extensionId: immutableEnvelope.sourceExtensionId,
				},
				{ observeExtensions: false },
			);
			return;
		}
		await this._extensionEventDispatchContext.run(
			dispatchDepth + 1,
			async () => {
				for (const [agentId, record] of [...this._agents]) {
					const extensionRunner = record.extensionRunner;
					if (!extensionRunner || extensionRunner.isStale()) continue;
					const diagnostics =
						await extensionRunner.emitExtensionEvent(immutableEnvelope);
					await this._recordAndPublishExtensionDiagnostics(
						agentId,
						diagnostics,
					);
				}
			},
		);
	}

	private async _finishAgentPrompt(
		agentId: AgentId,
		run: Promise<unknown>,
		statusRevision: number,
		options: { reportFailure: boolean },
	): Promise<void> {
		try {
			await run;
		} catch (error) {
			if (options.reportFailure) {
				await this._recordAgentLifecycleFailure(
					agentId,
					"orchestrator.agent_message_prompt_failed",
					`Prompt for agent ${agentId} failed after delivery: ${formatError(error)}`,
				);
			}
		} finally {
			const record = this._agents.get(agentId);
			if (
				record?.status === "running" &&
				this._agentStatusRevisions.get(agentId) === statusRevision
			) {
				await this._transitionAgentStatus(agentId, "idle");
			}
			this._messages.wake(agentId);
			// A prompt that failed before the run started changes no status, so
			// there is no transition for the waiters to settle from.
			this._settleAgentIdleWaiters(agentId);
		}
	}

	/**
	 * Run a harness operation that does not drive an agent loop (compaction,
	 * branch summary). The agent is marked `running` for the duration, but
	 * messages must not be steered or followed up into it: nothing would consume
	 * them until a real turn starts, so the delivery queue defers them.
	 */
	private async _runMaintenanceOperation<T>(
		agentId: AgentId,
		kind: AgentMaintenanceKind,
		operation: (harness: WidiAgentHarness) => Promise<T>,
	): Promise<T> {
		const record = this._requireAgentRecord(agentId);
		const harness = this._requireAgentHarness(agentId);
		const activeMaintenance = this._maintenanceOperations.get(agentId)?.kind;
		if (record.status !== "idle" || activeMaintenance) {
			throw new AgentHarnessError(
				"busy",
				`Agent ${agentId} cannot start ${maintenanceDescription(kind)} while ${
					activeMaintenance
						? maintenanceDescription(activeMaintenance)
						: record.status
				}.`,
			);
		}

		// Reserve synchronously, before status emission yields to observers. This
		// makes the status event and the operation kind one atomic decision.
		const reservation = { kind };
		this._maintenanceOperations.set(agentId, reservation);
		try {
			await this._transitionAgentStatus(agentId, "running", {
				maintenance: kind,
			});
			return await operation(harness);
		} finally {
			// Disposal can clear this reservation, and a resumed session may reuse
			// the agent id. A stale operation must never release its successor.
			if (this._maintenanceOperations.get(agentId) === reservation) {
				this._maintenanceOperations.delete(agentId);
				if (this._agents.get(agentId)?.status === "running") {
					await this._transitionAgentStatus(agentId, "idle");
				}
				// Leaving maintenance is a delivery-phase change even when another
				// lifecycle transition prevented the idle commit.
				this._messages.wake(agentId);
			}
		}
	}

	private _requireAgentOutsideMaintenance(
		agentId: AgentId,
		action: string,
	): void {
		const maintenance = this._maintenanceOperations.get(agentId)?.kind;
		if (!maintenance) return;
		throw new AgentHarnessError(
			"busy",
			`Agent ${agentId} cannot ${action} during ${maintenanceDescription(maintenance)}.`,
		);
	}

	/**
	 * Delivery-relevant phase of a target, re-read immediately before every
	 * attempt. `AgentLifecycleStatus.running` covers both a live agent loop and
	 * maintenance work, so the maintenance set is what tells them apart.
	 */
	private _resolveDeliveryPhase(agentId: AgentId): MessageDeliveryPhase {
		const record = this._agents.get(agentId);
		if (!record) return "gone";
		// A message enqueued during teardown must fail now rather than wait for
		// the status commit: the queue it would sit in has already been cancelled.
		if (this._disposingAgents.has(agentId)) return "gone";
		switch (record.status) {
			case "creating":
				return "creating";
			case "unavailable":
			case "disposed":
				return "gone";
			case "idle":
				return record.harness ? "idle" : "gone";
			case "running":
				if (!record.harness) return "gone";
				return this._maintenanceOperations.has(agentId)
					? "maintenance"
					: "turn";
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

	private _requireAgentHarness(agentId: AgentId): WidiAgentHarness {
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
		const presentedMessage =
			event.type === "message_end" ? event.message : undefined;
		const pendingPresentation = presentedMessage
			? this._takePendingExtensionInputPresentation(agentId, presentedMessage)
			: undefined;
		const presentationMessageEntryId =
			pendingPresentation && presentedMessage
				? await this.sessionManager.findAgentMessageEntryId(
						agentId,
						presentedMessage,
					)
				: null;
		// The agent loop is running, so the prompt's user message is committed to
		// this run: a pending delivery may now be reported as accepted. Resolved
		// before the awaits below so acceptance never waits on observers.
		if (event.type === "agent_start") {
			this._resolveAgentRunStartWaiters(agentId);
		}
		// The loop reports its queues after every drain, so an empty steering queue
		// is the only honest evidence that the human's interrupt was read (an abort
		// clears the queue through the same event).
		if (event.type === "queue_update") {
			if (event.steer.length === 0) {
				this._humanInterrupts.clear(agentId);
			}
			// The harness keeps its queues private and reports them only here, so
			// this is the one place the orchestrator can learn that text it already
			// handed over has not been read yet. `hasPendingMessages` needs it:
			// scoped steer/followUp go straight to the harness and never touch the
			// orchestrator's own delivery queue.
			const record = this._agents.get(agentId);
			if (record) {
				record.harnessQueuedMessageCount =
					event.steer.length + event.followUp.length + event.nextTurn.length;
				// The queue draining is the other half of the idle judgement; a
				// status commit alone would report idle with text still unread.
				this._settleAgentIdleWaiters(agentId);
			}
			this._captureQueuedExtensionInputPresentation(
				agentId,
				"steer",
				event.steer,
			);
			this._captureQueuedExtensionInputPresentation(
				agentId,
				"follow_up",
				event.followUp,
			);
		}
		if (event.type === "abort") {
			this._discardClearedExtensionInputPresentations(agentId, [
				...event.clearedSteer,
				...event.clearedFollowUp,
			]);
		}
		await this._updateAgentStatusFromHarnessEvent(agentId, event);
		await this._emit({ type: "agent_harness_event", agentId, event });
		if (pendingPresentation) {
			await this._commitExtensionInputPresentation(
				agentId,
				presentationMessageEntryId,
				pendingPresentation,
			);
		}
		// Every harness event can change the delivery phase, so re-examine the
		// queue: this is what resumes a message deferred during maintenance or
		// retried after a busy race.
		this._messages.wake(agentId);
		// Auto-compaction rides the settled fact: the harness is idle and its
		// pending session writes are flushed, so the branch and the last
		// assistant usage are durable. A settled with queued next turns is
		// skipped - the next run starts immediately and compaction would race
		// its busy check.
		if (event.type === "settled" && event.nextTurnCount === 0) {
			const contextTokens = await this._refreshAgentContextUsage(agentId);
			await this._maybeAutoCompactAgent(agentId, contextTokens);
		}
	}

	/**
	 * Measure how much of the model's context window the agent's active branch
	 * occupies, cache it, and publish the change.
	 *
	 * The measurement walks the branch, so it runs once per settled and its
	 * result is handed to the compaction trigger rather than read twice. The
	 * facts are the ones the upstream harness compacts on: last assistant usage
	 * versus the model context window. A branch with no assistant usage yet has
	 * no measurement - not a zero.
	 */
	private async _refreshAgentContextUsage(
		agentId: AgentId,
	): Promise<number | undefined> {
		const record = this._agents.get(agentId);
		if (!record) return undefined;
		let usage: AgentContextUsage;
		try {
			const snapshot =
				await this.sessionManager.getAgentSessionSnapshot(agentId);
			const lastUsage = getLastAssistantUsage([...snapshot.pathToRoot]);
			if (!lastUsage) {
				// A branch with nothing to measure must clear any earlier
				// measurement, not silently keep describing a branch this agent
				// has since moved off.
				await this._setAgentContextUsage(agentId, undefined);
				return undefined;
			}
			const tokens = calculateContextTokens(lastUsage);
			const contextWindow = record.model.contextWindow;
			usage = {
				tokens,
				contextWindow,
				percent: contextWindow > 0 ? (tokens / contextWindow) * 100 : 0,
				model: modelReference(record.model),
			};
		} catch (error) {
			// A failed refresh cannot certify that the previous branch measurement
			// is still current. Clear it, report the failure, and let the next
			// settled try again.
			await this._setAgentContextUsage(agentId, undefined);
			await this._publishDiagnostic({
				severity: "warning",
				code: "orchestrator.context_usage_failed",
				message: `Failed to measure context usage for agent ${agentId}: ${formatError(error)}`,
				agentId,
			});
			return undefined;
		}
		await this._setAgentContextUsage(agentId, usage);
		return usage.tokens;
	}

	// Publish only on change: a settled that measures the same branch as the
	// last one is not news for a gauge.
	private async _setAgentContextUsage(
		agentId: AgentId,
		usage: AgentContextUsage | undefined,
	): Promise<void> {
		const record = this._agents.get(agentId);
		if (!record) return;
		const previous = record.contextUsage;
		if (
			previous?.tokens === usage?.tokens &&
			previous?.contextWindow === usage?.contextWindow &&
			previous?.model === usage?.model
		) {
			return;
		}
		record.contextUsage = usage ? { ...usage } : undefined;
		await this._emit({
			type: "agent_context_usage_changed",
			agentId,
			usage: usage ? { ...usage } : undefined,
			changedAt: now(),
		});
	}

	// Threshold trigger for automatic compaction (settings compaction.enabled /
	// reserveTokens). Failure is a warning diagnostic, never a thrown error -
	// an uncompactable over-threshold session keeps running until the provider
	// rejects it, which is the same behavior as before this trigger existed.
	private async _maybeAutoCompactAgent(
		agentId: AgentId,
		contextTokens: number | undefined,
	): Promise<void> {
		if (contextTokens === undefined) return;
		const settings = this.settingManager.getCompactionSettings();
		if (!settings.enabled) return;
		if (this._autoCompactingAgents.has(agentId)) return;
		const record = this._agents.get(agentId);
		if (!record || record.status !== "idle" || !record.harness) return;
		if (!shouldCompact(contextTokens, record.model.contextWindow, settings)) {
			return;
		}
		this._autoCompactingAgents.add(agentId);
		try {
			await this.compactAgent(agentId);
		} catch (error) {
			await this._publishDiagnostic({
				severity: "warning",
				code: "compaction.auto_failed",
				message: `Automatic compaction failed for agent ${agentId}: ${formatError(error)}`,
				agentId,
			});
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
		return Object.hasOwn(EXTENSION_OBSERVED_EVENT_NAMES, event.type);
	}

	/**
	 * The agent an observed event belongs to, or undefined when it is about the
	 * runtime rather than one agent. A runtime-scoped fact is broadcast; a
	 * diagnostic without an agent has no observer to reach.
	 */
	private _extensionObservedAgentId(
		event: ExtensionObservedEvent,
	): AgentId | undefined {
		if (event.type === "diagnostic") return event.diagnostic.agentId;
		if (event.type === "runtime_shutdown_requested") return undefined;
		return event.agentId;
	}

	private async _emitToExtensionObservers(
		event: ExtensionObservedEvent,
	): Promise<void> {
		const agentId = this._extensionObservedAgentId(event);
		if (!agentId) {
			// Runtime-scoped: every live runtime is a subject, so a shutdown
			// request reaches the agents that need to wind their work down, not
			// only the one whose extension asked.
			if (event.type !== "runtime_shutdown_requested") return;
			for (const observedAgentId of [...this._agents.keys()]) {
				await this._emitToExtensionObserversForAgent(observedAgentId, event);
			}
			return;
		}
		await this._emitToExtensionObserversForAgent(agentId, event);
	}

	private async _emitToExtensionObserversForAgent(
		agentId: AgentId,
		event: ExtensionObservedEvent,
	): Promise<void> {
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
					listenerFailures.push({
						severity: "warning",
						code: "orchestrator.listener_failed",
						message: `Listener failed for event ${event.type}: ${formatError(error)}`,
						agentId: "agentId" in event ? event.agentId : undefined,
					});
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
						{
							severity: "warning",
							code: "orchestrator.client_failed",
							message: `Client failed for event ${event.type}: ${formatError(error)}`,
							agentId: "agentId" in event ? event.agentId : undefined,
						},
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
		for (const diagnostic of diagnostics) {
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
	return diagnostic.severity === "error";
}

/**
 * Project a task report onto a job outcome. The report text always travels in
 * `result`, including for a failure: the result message formatter reads
 * `result` first, while the `error` channel would render the worker's
 * explanation as an exception string. `status` only decides the header and the
 * snapshot field.
 */
function toBackgroundJobOutcome(
	outcome: AgentTaskOutcome,
): BackgroundJobOutcome {
	return {
		status: outcome.status,
		result: {
			content: [{ type: "text", text: outcome.text }],
			details: undefined,
		},
	};
}

/**
 * Normalize an active-tool selection against the agent's installed tool
 * names: trims entries, drops empty names, duplicates, and unknown names,
 * and reports each dropped entry as a diagnostic.
 */
function selectActiveToolNames(
	toolNames: readonly string[],
	installedNames: ReadonlySet<string>,
	context: { agentId: AgentId },
): { activeToolNames: string[]; diagnostics: OrchestratorDiagnostic[] } {
	const activeToolNames: string[] = [];
	const seen = new Set<string>();
	const diagnostics: OrchestratorDiagnostic[] = [];
	const report = (diagnostic: OrchestratorDiagnostic) => {
		diagnostics.push(diagnostic);
	};
	for (const rawName of toolNames) {
		const name = rawName.trim();
		if (!name) {
			report({
				severity: "error",
				code: "tool.invalid_name",
				message: "Tool name list contains an empty name.",
				agentId: context.agentId,
			});
			continue;
		}
		if (seen.has(name)) {
			report({
				severity: "warning",
				code: "tool.active_duplicate",
				message: `Tool name '${name}' is listed more than once; keeping the first occurrence.`,
				agentId: context.agentId,
			});
			continue;
		}
		seen.add(name);
		if (!installedNames.has(name)) {
			report({
				severity: "warning",
				code: "tool.active_missing",
				message: `Active tool '${name}' is not in the agent's installed tool set.`,
				agentId: context.agentId,
			});
			continue;
		}
		activeToolNames.push(name);
	}
	return { activeToolNames, diagnostics };
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
		override.projectContext !== undefined ||
		override.includeCwd !== undefined ||
		override.appendSystemPrompt !== undefined ||
		override.persist !== undefined
	);
}

function maintenanceDescription(kind: AgentMaintenanceKind): string {
	return kind === "compaction" ? "compaction" : "tree navigation";
}

function userMessageText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function cloneSessionEntries(
	entries: readonly SessionTreeEntry[],
): readonly SessionTreeEntry[] {
	return structuredClone(entries);
}

/** Text of every user message on a branch, for "was the model ever told X?". */
function collectUserMessageText(
	entries: readonly SessionTreeEntry[],
): string[] {
	const texts: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		if (typeof content === "string") {
			texts.push(content);
			continue;
		}
		for (const part of content) {
			if (part.type === "text") texts.push(part.text);
		}
	}
	return texts;
}

/**
 * Closing text for a job a previous run left unanswered: the outcome it settled
 * into when one was recorded, otherwise a cancellation for work the exit ended.
 */
function toCarriedOverJobResultText(job: PersistedBackgroundJob): string {
	return (
		job.messageText ??
		formatInterruptedBackgroundJobResultText({
			jobId: job.jobId,
			toolCallId: job.toolCallId,
			toolName: job.toolName,
			stopReason: job.stopReason,
		})
	);
}

function now(): string {
	return new Date().toISOString();
}
