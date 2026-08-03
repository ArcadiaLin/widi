/**
 * AgentOrchestrator - the multi-agent runtime.
 *
 * One criterion shapes this file: a fact about a single agent is read from that
 * agent's `AgentHarness`; the orchestrator only decides what needs more than one
 * agent to answer - AgentId allocation, spawn-tree ownership, cross-agent
 * routing, who is waiting on whom to go idle, and the persistence of those
 * facts. The exceptions are enumerated in `docs/agent-harness-ownership-plan.md`.
 *
 * A collaborator earns its own class only when it owns state whose invariant it
 * can maintain without consulting `_live`. Four qualify: `BackgroundJobRuntime`,
 * `OrchestratorEventBus`, `AgentContextMonitor`, `AuthRuntimeController`.
 * Everything whose central judgement is a join across `_live`, harness phase,
 * the spawn tree, or background jobs stays here.
 *
 * Design: `docs/orchestrator.pseudo.ts`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { type AssistantMessage, getSupportedThinkingLevels, type ImageContent } from "@earendil-works/pi-ai";
import {
	type AbortResult,
	AgentHarness,
	AgentHarnessError,
	type AgentHarnessEvent,
	type AgentHarnessPhase,
	type CompactResult,
	type ExecutionEnv,
	type JsonlSessionMetadata,
	type NavigateTreeResult,
	type PendingSessionWrite,
	type PromptTemplate,
	type Session,
	type SessionTreeEntry,
	type Skill,
	shouldCompact,
	type ThinkingLevel,
} from "@widi/agent-core";
import { formatError } from "../../utils/errors.ts";
import type { AgentProfile, AgentProfileOverride, AgentProfileRegistry, AgentProfileSource } from "../agent-profile.js";
import { parseAgentProfileReference } from "../agent-profile.js";
import {
	type BackgroundJobDelivery,
	type BackgroundJobDeliveryReceipt,
	type BackgroundJobEvent,
	BackgroundJobRuntime,
	type BackgroundJobSnapshot,
	backgroundJobResultHeaderPrefix,
	formatInterruptedBackgroundJobResultText,
	type JobHistoryEntry,
	type OwnerAttachment,
} from "../background/index.ts";
import type { OrchestratorClient } from "../client.ts";
import { type OrchestratorDiagnostic, OrchestratorError } from "../diagnostics.ts";
import type { ExtensionEventEnvelope } from "../extension/events.ts";
import type { ExtensionContextActions, ExtensionCoreActions, ExtensionIdentity } from "../extension/index.ts";
import {
	EXTENSION_OBSERVED_EVENT_NAMES,
	ExtensionLoader,
	ExtensionRunner,
	freezeExtensionEventEnvelope,
	MAX_EXTENSION_EVENT_DISPATCH_DEPTH,
	validateExtensionEventName,
	validateExtensionEventPayload,
} from "../extension/index.ts";
import {
	assertExtensionNotificationText,
	assertExtensionOutputText,
	assertExtensionStatusKey,
	cloneExtensionInputPresentation,
	type ExtensionInputPresentation,
	type ExtensionStatusSnapshot,
	validateExtensionDiagnosticDraft,
	validateExtensionInputPresentation,
	validateExtensionMessage,
	validateExtensionStatus,
} from "../extension/presentation.ts";
import { ExtensionStatusRegistry } from "../extension/status-registry.ts";
import type {
	ExtensionInterceptorEventFor,
	ExtensionInterceptorName,
	ExtensionInterceptorResultFor,
	ExtensionModule,
	ExtensionObservedEvent,
	ExtensionSessionSnapshot,
	ExtensionSessionTree,
} from "../extension/types.ts";
import { HumanInterruptRegistry } from "../human-interrupt.ts";
import type { HumanRequest, HumanResponse } from "../human-request.ts";
import { HumanRequestBroker } from "../human-request.ts";
import { stripImagesFromMessages } from "../image-policy.ts";
import {
	assertMessageBody,
	backgroundResultMergeKey,
	type MessageDeliveryMethod,
	type MessageDeliveryPhase,
	MessageDeliveryQueue,
	type MessageDeliveryReceipt,
	type MessageDeliveryRequest,
	type MessageDraft,
	type MessageInterceptEvent,
	type MessageInterceptRun,
	type MessageSendOutcome,
	type MessageSource,
	renderMessageEnvelope,
	transformMessage,
} from "../message.ts";
import {
	type ModelRegistry,
	modelReference,
	parseModelReference,
	parseThinkingLevel,
	THINKING_LEVELS,
} from "../model-registry.js";
import type { ProviderConfigInput } from "../model-registry.ts";
import type { ConfigValueResolver } from "../resolve-config-value.js";
import type { ResourceLoader } from "../resource-loader.js";
import type {
	AgentSessionCandidate,
	AgentSessionMetadata,
	AgentSessionSnapshot,
	AgentSessionTreeSnapshot,
	SessionManager,
} from "../session-manager.ts";
import {
	EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE,
	EXTENSION_MESSAGE_CUSTOM_TYPE,
	type ExtensionInputPresentationEntryData,
	type ExtensionMessageEntryData,
	INPUT_TRANSFORM_CUSTOM_TYPE,
	type InputTransformEntryData,
	sessionDirNameFromPath,
	toExtensionCustomType,
} from "../session-manager.ts";
import type { AgentParentPointer, AgentTreeRecord, AgentTreeSpawnRecord } from "../session-tree.ts";
import type { SettingManager } from "../setting-manager.js";
import { buildAgentSystemPrompt, type ToolPromptGuidance } from "../system-prompt.ts";
import {
	createAgentHarnessToolsFromResolvedTools,
	type ResolvedAgentHarnessTool,
	type ToolAdapterContext,
	ToolRegistry,
} from "../tool-registry.ts";
import type {
	AgentActivitySnapshot,
	AgentId,
	AgentIdleReason,
	AgentMaintenanceKind,
	AgentToolsSnapshot,
	CandidateItem,
	OrchestratorEvent,
	OrchestratorEventListener,
	PromptOutcome,
	RuntimeModel,
	RuntimeShutdownRequest,
} from "../types.ts";
import type {
	AuthCredentialCandidateListResult,
	AuthProviderCandidateListResult,
	AuthProviderLoginResult,
	AuthProviderLogoutResult,
} from "./auth-controller.ts";
import { AuthRuntimeController } from "./auth-controller.ts";
import { AgentContextMonitor } from "./context-monitor.ts";
import type { EventPublishOptions } from "./event-bus.ts";
import { OrchestratorEventBus } from "./event-bus.ts";
import type { AgentBrief, AgentDisposeScope, AgentProfileBrief, ToolAgentHost } from "./host.ts";
import type {
	AgentResourcesSnapshot,
	AgentSettings,
	AgentSnapshot,
	AgentSystemPromptFacts,
	AgentToolPolicy,
	ExtensionRunnerBindings,
	LiveAgent,
	WidiAgentHarness,
} from "./types.ts";
import { createAgentProfileRecordReference } from "./types.ts";

export type {
	AuthCredentialCandidateListResult,
	AuthProviderCandidateListResult,
	AuthProviderLoginResult,
	AuthProviderLogoutResult,
} from "./auth-controller.ts";
export type { AgentSnapshot, LiveAgent } from "./types.ts";

export interface AgentOrchestratorConfig {
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

export interface AgentSessionListResult {
	readonly sessions: readonly AgentSessionCandidate[];
}

export interface AgentListResult {
	readonly agents: readonly AgentSnapshot[];
}

export interface AgentModelCandidateListResult {
	readonly models: readonly CandidateItem[];
}

export interface AgentThinkingLevelCandidateListResult {
	readonly levels: readonly CandidateItem[];
}

export interface AgentThinkingLevelResult {
	readonly level: ThinkingLevel;
}

export interface AgentPromptTemplateCandidateListResult {
	readonly templates: readonly CandidateItem[];
}

export interface AgentSkillCandidateListResult {
	readonly skills: readonly CandidateItem[];
}

export type ExtensionReloadAgentStatus = "reloaded" | "skipped" | "failed";

/** `running` covers every non-idle phase: a replacement would swap the interceptors an operation is midway through. */
export type ExtensionReloadAgentSkipReason = "creating" | "running" | "gone";

export interface ExtensionReloadAgentResult {
	readonly agentId: AgentId;
	readonly status: ExtensionReloadAgentStatus;
	readonly reason?: ExtensionReloadAgentSkipReason;
	readonly diagnostics: readonly OrchestratorDiagnostic[];
}

export interface ExtensionReloadResult {
	readonly catalog: {
		readonly loaded: readonly ExtensionIdentity[];
		readonly diagnostics: readonly OrchestratorDiagnostic[];
	};
	readonly agents: readonly ExtensionReloadAgentResult[];
}

/** What one tree restoration produced, for the root's reconciliation message. */
interface AgentTreeResumeOutcome {
	readonly rootAgentId: AgentId;
	readonly resumed: readonly AgentId[];
	readonly failed: readonly AgentId[];
	readonly remapped: ReadonlyArray<{ readonly from: AgentId; readonly to: AgentId }>;
}

/**
 * Where an agent's context comes from. Orthogonal to `parent`, which decides
 * spawn-tree ownership.
 */
export type SpawnAgentOrigin =
	| { readonly kind: "new"; readonly profileId?: string; readonly profileOverride?: AgentProfileOverride }
	| { readonly kind: "resume"; readonly reference: string | JsonlSessionMetadata }
	| { readonly kind: "fork"; readonly sourceAgentId: AgentId; readonly entryId?: string };

export interface SpawnAgentOptions {
	readonly origin: SpawnAgentOrigin;
	/** Absent means top-level; present records `spawnedBy` and the tree edge. */
	readonly parent?: AgentId;
	readonly model?: RuntimeModel;
	readonly thinkingLevel?: ThinkingLevel;
}

/**
 * `removed` writes a durable tombstone into the tree log. `runtime_shutdown`
 * writes nothing: without the distinction a normal exit would mark every agent
 * removed and tree restoration would never restore anything.
 */
export type AgentDisposeIntent = "removed" | "runtime_shutdown";

export interface DisposeAgentOptions {
	readonly intent: AgentDisposeIntent;
	readonly reason?: string;
	/** Default: dispose only the named agent. */
	readonly scope?: AgentDisposeScope;
}

/**
 * A creation in flight. Not a coalescing optimization: it exists so a second
 * resume of the same session reuses the first result, and so a build caught by
 * `disposeAll` can be cancelled instead of orphaned after the sweep.
 */
interface AgentCreationReservation {
	readonly agentId: AgentId;
	readonly completion: Promise<AgentId>;
	cancelled: boolean;
	readonly cancel: () => void;
}

/** Merges duplicate dispose requests. Never decides routability. */
interface AgentDisposalReservation {
	readonly agentId: AgentId;
	readonly completion: Promise<void>;
}

/** The four cases exhaust what an AgentId can mean; each comes from one table. */
type AgentLookup =
	| { readonly kind: "live"; readonly liveAgent: LiveAgent }
	| { readonly kind: "gone" }
	| { readonly kind: "creating"; readonly reservation: AgentCreationReservation }
	| { readonly kind: "unknown" };

/**
 * `phase` is read from the harness at lookup time rather than projected: the
 * delivery method is chosen from it, and harness errors do not cover every phase
 * (`followUp` on an idle target yields only a retryable `invalid_state`, which
 * would defer the message forever).
 */
interface DeliveryTarget {
	readonly agentId: AgentId;
	readonly generation: number;
	readonly harness: WidiAgentHarness;
	readonly phase: AgentHarnessPhase;
}

/** A prompt run this orchestrator started and still owes an outcome for. */
interface AgentPromptRun {
	idleReason?: AgentIdleReason;
}

interface AgentIdleWaiter {
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
}

type AgentIdleState =
	| { readonly kind: "idle" }
	| { readonly kind: "busy" }
	| { readonly kind: "gone"; readonly message: string };

interface ExtensionInputPresentationRecord {
	readonly extensionId: string;
	readonly presentation: ExtensionInputPresentation;
}

/**
 * An input presentation waiting to be paired with its user message on the
 * harness `session_write` event.
 *
 * `method` is recorded because an abort clears the steer and follow-up queues
 * wholesale - everything delivered that way will never be written - while a
 * `prompt` delivery has already committed its user message.
 */
interface PendingExtensionInputPresentation extends ExtensionInputPresentationRecord {
	method?: MessageDeliveryMethod;
}

/**
 * A message accepted into the target's delivery queue, or one an extension
 * ended before it got there. There is no third case for "written but
 * undelivered": accounting entries go through the harness's own write tail.
 */
type AcceptedMessage =
	| { readonly kind: "accepted"; readonly receipt: MessageDeliveryReceipt }
	| { readonly kind: "blocked"; readonly inputId: string; readonly reason?: string; readonly blockedBy: string };

interface RouteMessageOptions {
	/** The caller awaits this run's assistant message, so it must be a prompt. */
	readonly requiresIdle: boolean;
	/** The enqueuing caller awaits `receipt.completed` itself. */
	readonly awaited: boolean;
	readonly presentation?: ExtensionInputPresentationRecord;
}

interface ResolvedAgentProfile {
	readonly profile: AgentProfile;
	readonly source: AgentProfileSource;
	readonly entryId: string;
}

/**
 * Everything `_buildLiveAgent` needs, resolved before any live resource is
 * touched. Producing it can fail freely: nothing is registered yet.
 */
interface AgentBuildRequest {
	readonly agentId: AgentId;
	readonly origin: SpawnAgentOrigin["kind"];
	readonly resolvedProfile: ResolvedAgentProfile;
	readonly session: Session<AgentSessionMetadata>;
	readonly sessionMetadata?: AgentSessionMetadata;
	readonly model: RuntimeModel;
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly settings: AgentSettings;
	readonly toolPolicy: AgentToolPolicy;
	readonly parent: AgentId | undefined;
}

/** A finished build, not yet published to `_live`. */
interface LiveAgentBuild {
	readonly liveAgent: LiveAgent;
	/** Written after install when there is a parent and a persistable root. */
	readonly treeRecord?: AgentTreeSpawnRecord;
}

/**
 * `liveAgent` may be absent: the target can already be a tombstone, or still be
 * building - in which case the reservation's `cancelled` flag makes the builder
 * run its own failure cleanup.
 */
interface DisposedLiveAgent {
	readonly agentId: AgentId;
	readonly liveAgent?: LiveAgent;
}

export class AgentOrchestrator {
	// -- Injected services ---------------------------------------------------

	readonly executionEnv: ExecutionEnv;
	readonly resourceLoader: ResourceLoader;
	/** Also owns the spawn-tree directory layout and its IO primitives. */
	readonly sessionManager: SessionManager;
	readonly settingManager: SettingManager;
	readonly modelRegistry: ModelRegistry;
	readonly profileRegistry: AgentProfileRegistry;
	readonly toolRegistry: ToolRegistry;
	readonly extensionLoader: ExtensionLoader;

	// -- Independent runtimes ------------------------------------------------

	/**
	 * A sibling runtime: attach/detach, hand capabilities to scoped hosts, read
	 * `liveJobCount` and `carriedOverJobs`, receive t1 deliveries. Job state is
	 * never read from here, and an unsettled job never makes its owner busy.
	 */
	private readonly _backgroundJobs: BackgroundJobRuntime;

	/** Clients, listeners, and listener failure isolation. */
	private readonly _events: OrchestratorEventBus;

	/** Session-derived context usage, with its own generation checks. */
	private readonly _context: AgentContextMonitor;

	/** OAuth, credential mutation, and the human prompts a login needs. */
	private readonly _auth: AuthRuntimeController;

	/** Registration and cancellation semantics for every human request. */
	private readonly _humanRequests: HumanRequestBroker;

	/** Whether a human steer is still unread by the harness. */
	private readonly _humanInterrupts = new HumanInterruptRegistry();

	// -- Message delivery ----------------------------------------------------

	/** Per-target FIFO with merge and failure requeue. No knowledge of the agent registry. */
	private readonly _messages: MessageDeliveryQueue;

	/**
	 * Prompt runs this orchestrator started. The harness reports that it is in a
	 * turn; it cannot report who started it, who awaits its result, or whether it
	 * ended by abort or settlement. Staleness is decided by object identity: a run
	 * only settles the idle edge while it is still the value in this map.
	 */
	private readonly _agentPromptRuns = new Map<AgentId, AgentPromptRun>();

	/**
	 * Waiters for the target's next `agent_start`, registered before `prompt()`.
	 * Everything the harness does before that event is asynchronous and can fail,
	 * and a failure there means the user message was never persisted. Phase cannot
	 * substitute: it flips to `turn` on the first line of `prompt()`.
	 */
	private readonly _agentRunStartWaiters = new Map<AgentId, Set<() => void>>();

	/** The current run's abort signal, captured from the harness subscription. */
	private readonly _agentRunSignals = new Map<AgentId, AbortSignal>();

	/**
	 * The idle edge: who waits for it, why the last one happened, whether it was
	 * published. All three read `_resolveAgentIdleState`, so a `waitForAgentIdle`
	 * caller and an `agent_idle` subscriber can never disagree.
	 */
	private readonly _agentIdleWaiters = new Map<AgentId, Set<AgentIdleWaiter>>();
	private readonly _agentIdleReasons = new Map<AgentId, AgentIdleReason>();
	private readonly _publishedAgentIdles = new Set<AgentId>();

	/**
	 * The activity last published for each agent. Not a mirror of the harness -
	 * every reader takes `getPhase()` - but `agent_status_changed` is
	 * edge-triggered, and an edge cannot be detected from a value alone.
	 */
	private readonly _publishedAgentActivities = new Map<AgentId, AgentActivitySnapshot>();

	private _nextInputId = 1;
	private _nextPresentationId = 1;

	// -- Extension data plane ------------------------------------------------

	/**
	 * Presentations delivered but not yet paired with a user message, in delivery
	 * order per target. Pairing pops the head on `session_write`.
	 */
	private readonly _pendingExtensionInputPresentations = new Map<AgentId, PendingExtensionInputPresentation[]>();

	/** Per-agent, per-generation extension load results. */
	private readonly _extensionStatuses = new ExtensionStatusRegistry();

	/**
	 * Recursion depth for extension events. It belongs to the causal async chain,
	 * not the runtime: concurrent emits must not consume one another's budget,
	 * while a handler's nested emit inherits its parent's.
	 */
	private readonly _extensionEventDispatchContext = new AsyncLocalStorage<number>();

	/** Observed-event fan-out depth, which keeps diagnostics from self-feeding. */
	private readonly _extensionObserverDispatchDepth = new Map<AgentId, number>();

	/** One table shared by every runner; agentId and extensionId are explicit arguments, so no closure set is rebuilt per agent. */
	private readonly _extensionCoreActions: ExtensionCoreActions;

	// -- Agent registry ------------------------------------------------------

	/**
	 * The only routable set, current generation only. Written by install, removed
	 * synchronously by the dispose cutover. A hit means alive.
	 */
	private readonly _live = new Map<AgentId, LiveAgent>();

	/**
	 * AgentIds that existed and are gone, kept solely so a dead id is not reused:
	 * an in-flight message aimed at a recycled id would reach a different agent.
	 * Intent, time and reason live in `agent_disposed` and `agents/tree.jsonl`.
	 */
	private readonly _tombstones = new Set<AgentId>();

	/**
	 * Spawn-tree edges, child to parent, and the in-memory mirror of
	 * `agents/tree.jsonl`. **Not deleted on dispose:** a single dispose does not
	 * take the subtree with it, so a vanished intermediate node must still let an
	 * ancestor's subtree dispose reach its surviving descendants. `_pruneSpawnEdges`
	 * is what keeps that from becoming a leak.
	 */
	private readonly _spawnParent = new Map<AgentId, AgentId>();

	/** Next generation per AgentId, monotonic across resume of the same id. */
	private readonly _agentGenerations = new Map<AgentId, number>();

	/** Resume de-duplication and build cancellation. Not an activity state. */
	private readonly _agentCreations = new Map<AgentId, AgentCreationReservation>();

	/** Merges concurrent dispose requests only. */
	private readonly _agentDisposals = new Map<AgentId, AgentDisposalReservation>();

	/** Diagnostics history per agent, read by `AgentSnapshot`. Separate from `LiveAgent`, which is thrown away wholesale on dispose. */
	private readonly _agentDiagnostics = new Map<AgentId, OrchestratorDiagnostic[]>();

	/**
	 * Agents scheduled for automatic compaction but not yet started. Phase cannot
	 * replace this: the decision spans an await, so phase only rejects at the
	 * second `compact()` call and that rejection surfaces as a user-visible
	 * `compaction.auto_failed` warning. This is scheduling intent, not a phase.
	 */
	private readonly _autoCompactingAgents = new Set<AgentId>();

	/** Serialized write tail per root tree file, so `spawned` and `removed` keep event order. */
	private readonly _treeWrites = new Map<AgentId, Promise<void>>();

	// -- Runtime defaults ----------------------------------------------------

	private _defaultModel: RuntimeModel;
	private _defaultThinkingLevel: ThinkingLevel | undefined;
	private _defaultProfileId: string;
	private _enabledProfileIds: readonly string[] | undefined;

	private _shutdownRequested = false;

	constructor(config: AgentOrchestratorConfig) {
		this.executionEnv = config.executionEnv;
		this.resourceLoader = config.resourceLoader;
		this.sessionManager = config.sessionManager;
		this.settingManager = config.settingManager;
		this.modelRegistry = config.modelRegistry;
		this.profileRegistry = config.profileRegistry;
		this.toolRegistry = config.toolRegistry ?? new ToolRegistry();
		this.extensionLoader = config.extensionLoader ?? new ExtensionLoader();
		this._defaultProfileId = config.defaultProfileId;
		this._enabledProfileIds = config.enabledProfileIds ? [...config.enabledProfileIds] : undefined;
		this._defaultModel = config.defaultModel;
		this._defaultThinkingLevel = config.defaultThinkingLevel;

		this.modelRegistry.setDiagnosticPublisher(async (diagnostics) => await this._publishDiagnostics(diagnostics));

		// Every port below points back at a private method of this class, so the
		// dependency edge stays one-way: a runtime knows its callbacks and nothing
		// about the orchestrator.
		this._events = new OrchestratorEventBus({
			diagnose: async (diagnostic, options) => await this._publishDiagnostic(diagnostic, options),
		});
		this._context = new AgentContextMonitor({
			sessionManager: this.sessionManager,
			resolve: (agentId) => {
				const liveAgent = this._live.get(agentId);
				return liveAgent ? { generation: liveAgent.generation, model: liveAgent.harness.getModel() } : undefined;
			},
			publish: async (event) => await this._emit(event),
			diagnose: async (diagnostic) => await this._publishDiagnostic(diagnostic),
		});
		this._humanRequests = new HumanRequestBroker({
			findHumanRequestHandler: () => this._events.findHumanRequestHandler(),
			emit: async (event) => await this._emit(event),
			publishDiagnostic: async (diagnostic) => await this._publishDiagnostic(diagnostic),
			recordAgentLifecycleFailure: async (agentId, code, message) =>
				await this._recordAgentLifecycleFailure(agentId, code, message),
		});
		this._auth = new AuthRuntimeController({
			models: this.modelRegistry,
			humanRequests: this._humanRequests,
			publish: async (event) => await this._emit(event),
			diagnose: async (diagnostic) => await this._publishDiagnostic(diagnostic),
			diagnoseMany: async (diagnostics) => await this._publishDiagnostics(diagnostics),
		});
		this._backgroundJobs = new BackgroundJobRuntime({
			// Recording a job means putting a persistence ref on the branch, and the
			// capability that does that is the orchestrator extension point described
			// in `docs/ZH/orchestrator-refactor.md`. Until it exists every owner is
			// ephemeral: jobs run, they just leave no history.
			openOwnerStore: async () => undefined,
			deliverResult: async (delivery) => await this._deliverBackgroundResult(delivery),
			// Translated here so the runtime's vocabulary stays free of agents.
			publish: async (event) => await this._emit(toOrchestratorBackgroundEvent(event)),
			diagnose: async (diagnostic) => await this._publishDiagnostic(diagnostic),
		});
		this._messages = new MessageDeliveryQueue({
			resolvePhase: (agentId) => this._resolveDeliveryPhase(agentId),
			deliver: async (request) => await this._deliverQueuedMessage(request),
		});
		this._extensionCoreActions = this._createExtensionCoreActions();
	}

	// -----------------------------------------------------------------------
	// Runtime defaults
	//
	// Not any agent's state - a single agent's values are read from its harness -
	// so every setter affects later spawns only.
	// -----------------------------------------------------------------------

	getDefaultModel(): RuntimeModel {
		return this._defaultModel;
	}

	setDefaultModel(model: RuntimeModel): void {
		this._defaultModel = model;
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this._defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevel | undefined): void {
		this._defaultThinkingLevel = level;
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

	/**
	 * Separate from the constructor: at construction no client has subscribed
	 * yet, so anything emitted there reaches nobody.
	 */
	async emitStartupDiagnostics(): Promise<void> {
		await this._publishDiagnostics(this._drainCoreDiagnostics());
	}

	// -----------------------------------------------------------------------
	// Registry lookup and projection
	// -----------------------------------------------------------------------

	/**
	 * The single lookup entry point, giving the complete gate answer at once.
	 * There is no second cross-table join afterwards: the hit itself carries the
	 * harness, profile, settings, and runner.
	 */
	private _resolveAgent(agentId: AgentId): AgentLookup {
		const liveAgent = this._live.get(agentId);
		if (liveAgent) return { kind: "live", liveAgent };
		if (this._tombstones.has(agentId)) return { kind: "gone" };
		const reservation = this._agentCreations.get(agentId);
		if (reservation) return { kind: "creating", reservation };
		return { kind: "unknown" };
	}

	/** The live branch of `_resolveAgent`; the other three all throw. */
	private _requireLiveAgent(agentId: AgentId): LiveAgent {
		const lookup = this._resolveAgent(agentId);
		if (lookup.kind === "live") return lookup.liveAgent;
		throw new OrchestratorError({
			severity: "error",
			code:
				lookup.kind === "gone"
					? "orchestrator.agent_gone"
					: lookup.kind === "creating"
						? "orchestrator.agent_creating"
						: "orchestrator.agent_unknown",
			message:
				lookup.kind === "gone"
					? `Agent ${agentId} is gone.`
					: lookup.kind === "creating"
						? `Agent ${agentId} is still being created.`
						: `Unknown agent: ${agentId}`,
			agentId,
		});
	}

	/**
	 * Take the harness, rejecting `compaction` and `branch_summary` - the phases
	 * that would accept text nothing reads.
	 *
	 * Idle is deliberately not rejected here: the harness already throws
	 * `invalid_state` for steer and follow-up, and abort while idle is meaningful
	 * (it drains the queues). Blocking only maintenance is what lets all four
	 * entry points share this helper.
	 */
	private _requireHarnessOutsideMaintenance(agentId: AgentId, action: string): WidiAgentHarness {
		const harness = this._requireLiveAgent(agentId).harness;
		const maintenance = toMaintenanceKind(harness.getPhase());
		if (maintenance) {
			throw new AgentHarnessError(
				"busy",
				`Agent ${agentId} cannot ${action} during ${maintenanceDescription(maintenance)}.`,
			);
		}
		return harness;
	}

	/**
	 * Mapped straight from the harness phase. The mapping only holds for a live
	 * agent: a shut-down harness also reports idle, and the `_live` miss rejects
	 * it before this point.
	 */
	getAgentActivity(agentId: AgentId): AgentActivitySnapshot {
		return toActivitySnapshot(this._requireLiveAgent(agentId).harness.getPhase());
	}

	private _snapshotAgent(liveAgent: LiveAgent): AgentSnapshot {
		const { agentId, harness } = liveAgent;
		const spawnedBy = this._spawnParent.get(agentId);
		const contextUsage = this._context.get(agentId);
		return {
			agentId,
			generation: liveAgent.generation,
			profile: liveAgent.profile,
			...(spawnedBy === undefined ? undefined : { spawnedBy }),
			...(liveAgent.sessionMetadata === undefined ? undefined : { sessionMetadata: liveAgent.sessionMetadata }),
			model: harness.getModel(),
			thinkingLevel: harness.getThinkingLevel(),
			tools: this._snapshotAgentTools(liveAgent),
			activity: toActivitySnapshot(harness.getPhase()),
			extensions: liveAgent.extensionRunner.inspect(),
			diagnostics: [...(this._agentDiagnostics.get(agentId) ?? [])],
			...(contextUsage === undefined ? undefined : { contextUsage }),
		};
	}

	inspectAgent(agentId: AgentId): AgentSnapshot {
		return this._snapshotAgent(this._requireLiveAgent(agentId));
	}

	/** Live agents only; surfaces drop a row on `agent_disposed`. */
	listAgents(): AgentListResult {
		return { agents: Array.from(this._live.values(), (liveAgent) => this._snapshotAgent(liveAgent)) };
	}

	/**
	 * `_live` and `_tombstones` are disjoint, and every parent in `_spawnParent`
	 * is live or a tombstone. For lifecycle boundaries and tests; never part of a
	 * business branch.
	 */
	private _assertRegistryInvariant(agentId?: AgentId): void {
		for (const id of agentId ? [agentId] : this._live.keys()) {
			if (this._live.has(id) && this._tombstones.has(id)) {
				throw new Error(`Agent ${id} is both live and a tombstone.`);
			}
		}
		for (const [child, parent] of this._spawnParent) {
			if (!this._live.has(parent) && !this._tombstones.has(parent)) {
				throw new Error(`Spawn edge ${child} -> ${parent} points at an unknown agent.`);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Spawn tree traversal
	// -----------------------------------------------------------------------

	/** Walk `_spawnParent` to the root, cycle-safe. */
	private _resolveAgentTreeRoot(agentId: AgentId): AgentId {
		const seen = new Set<AgentId>([agentId]);
		let current = agentId;
		for (;;) {
			const parent = this._spawnParent.get(current);
			if (parent === undefined || seen.has(parent)) return current;
			seen.add(parent);
			current = parent;
		}
	}

	private _agentsShareTree(firstAgentId: AgentId, secondAgentId: AgentId): boolean {
		return this._resolveAgentTreeRoot(firstAgentId) === this._resolveAgentTreeRoot(secondAgentId);
	}

	/** Cycle-safe subtree snapshot in a deterministic leaf-to-root order. */
	private _collectAgentSubtreePostOrder(agentId: AgentId): readonly AgentId[] {
		const children = new Map<AgentId, AgentId[]>();
		for (const [child, parent] of this._spawnParent) {
			const siblings = children.get(parent);
			if (siblings) siblings.push(child);
			else children.set(parent, [child]);
		}
		const ordered: AgentId[] = [];
		const visited = new Set<AgentId>();
		const visit = (current: AgentId): void => {
			if (visited.has(current)) return;
			visited.add(current);
			for (const child of children.get(current) ?? []) visit(child);
			ordered.push(current);
		};
		visit(agentId);
		return ordered;
	}

	/**
	 * Drop this agent's edge once it has no surviving descendants, then walk up
	 * dropping every ancestor tombstone edge that likewise has none. Without it a
	 * session that spawns and disposes in a loop accumulates one dead edge per
	 * spawn.
	 */
	private _pruneSpawnEdges(agentId: AgentId): void {
		let current: AgentId | undefined = agentId;
		while (current !== undefined && !this._live.has(current)) {
			let hasDescendant = false;
			for (const parent of this._spawnParent.values()) {
				if (parent === current) {
					hasDescendant = true;
					break;
				}
			}
			if (hasDescendant) return;
			const next = this._spawnParent.get(current);
			this._spawnParent.delete(current);
			current = next;
		}
	}

	// -----------------------------------------------------------------------
	// Spawn
	// -----------------------------------------------------------------------

	/**
	 * The only creation entry point. It returns an AgentId and nothing else: the
	 * harness never crosses this boundary.
	 */
	async spawnAgent(options: SpawnAgentOptions): Promise<AgentId> {
		await this.emitStartupDiagnostics();
		if (this._shutdownRequested) {
			throw new OrchestratorError({
				severity: "error",
				code: "orchestrator.shutdown",
				message: "The runtime is shutting down and cannot spawn agents.",
			});
		}
		if (options.parent !== undefined) this._assertAgentCanParent(options.parent);
		// A child resumed by hand is redirected to its root, so the tree comes back
		// whole instead of as an orphan whose root would later open the same session
		// twice. A member restored under `_resumeAgentTree` is already inside one.
		if (options.origin.kind === "resume" && options.parent === undefined) {
			const redirected = await this._redirectChildResumeToRoot(options.origin.reference);
			if (redirected !== undefined) return redirected;
		}

		const request = await this._resolveAgentBuild(options);
		// A resume that names a session another caller is already resuming waits for
		// that build instead of opening the same session twice.
		const existing = this._agentCreations.get(request.agentId);
		if (existing) return await existing.completion;
		if (this._live.has(request.agentId)) return request.agentId;

		const reservation = this._createAgentCreationReservation(request.agentId);
		try {
			const build = await this._buildLiveAgent(request, reservation);
			if (reservation.cancelled) {
				await this._releaseFailedBuild(
					request.agentId,
					build,
					new Error(`Creation of agent ${request.agentId} was cancelled.`),
				);
				throw new OrchestratorError({
					severity: "error",
					code: "orchestrator.agent_creation_cancelled",
					message: `Creation of agent ${request.agentId} was cancelled.`,
					agentId: request.agentId,
				});
			}
			const agentId = this._installLiveAgent(build);
			// Released before the lifecycle event so a listener may synchronously
			// dispose the agent it was just told about.
			this._finishAgentCreation(agentId, reservation, agentId);
			await this._recordAgentSpawnedInTree(build);
			if (request.origin === "resume") {
				// Before the agent is routable: an unanswered t0 handle is part of the
				// context the model resumes with, not a message arriving after it.
				await this._reconcileCarriedOverJobs(agentId);
			}
			if (this._live.has(agentId)) {
				await this._emit({
					type: request.origin === "resume" ? "agent_resumed" : "agent_spawned",
					agentId,
					profile: request.resolvedProfile.profile,
					model: build.liveAgent.harness.getModel(),
					...(request.parent === undefined ? undefined : { spawnedBy: request.parent }),
				});
			}
			// After the root is routable and announced: a child whose parent is not
			// yet live has nowhere to attach.
			if (request.origin === "resume" && request.parent === undefined) {
				await this._restoreSpawnTree(agentId);
			}
			return agentId;
		} catch (error) {
			this._finishAgentCreation(request.agentId, reservation, undefined, error);
			throw error;
		}
	}

	/**
	 * Resolve an origin into a build request. `new` allocates a readable AgentId
	 * and creates the session, `resume` reuses the id the session recorded, `fork`
	 * takes the new session's id. Nothing live is registered here.
	 */
	private async _resolveAgentBuild(options: SpawnAgentOptions): Promise<AgentBuildRequest> {
		const settings = this._captureAgentSettings();
		if (options.origin.kind === "resume") {
			const metadata =
				typeof options.origin.reference === "string"
					? await this.sessionManager.resolveAgentSessionReference(options.origin.reference)
					: options.origin.reference;
			const agentId = metadata.id;
			const resolvedProfile = await this._resolveResumeProfile(agentId, metadata);
			const session = await this.sessionManager.resumeAgentSession({ agentId, metadata });
			const context = await this.sessionManager.buildAgentSessionContext(agentId);
			return {
				agentId,
				origin: "resume",
				resolvedProfile,
				session,
				sessionMetadata: await session.getMetadata(),
				model: options.model ?? this._resolveResumeModel(context.model),
				thinkingLevel:
					options.thinkingLevel ?? resolveThinkingLevel(context.thinkingLevel) ?? this._defaultThinkingLevel,
				settings,
				toolPolicy: {
					requestedToolNames: resolvedProfile.profile.tools,
					activeToolSelection:
						context.activeToolNames == null
							? { mode: "default_all" }
							: { mode: "explicit", toolNames: [...context.activeToolNames] },
				},
				parent: options.parent,
			};
		}

		if (options.origin.kind === "fork") {
			const source = this._requireLiveAgent(options.origin.sourceAgentId);
			if (!source.resolvedProfile.persist) {
				throw new OrchestratorError({
					severity: "error",
					code: "orchestrator.agent_not_forkable",
					message: `Agent ${source.agentId} has no persistent session to fork.`,
					agentId: source.agentId,
				});
			}
			const metadata = await this.sessionManager.forkAgentSession(
				source.agentId,
				options.origin.entryId === undefined ? undefined : { entryId: options.origin.entryId },
			);
			await this._emit({
				type: "agent_session_forked",
				agentId: source.agentId,
				forkedSessionId: metadata.id,
				...(options.origin.entryId === undefined ? undefined : { entryId: options.origin.entryId }),
				createdAt: now(),
			});
			const agentId = metadata.id;
			const session = await this.sessionManager.resumeAgentSession({ agentId, metadata });
			return {
				agentId,
				origin: "fork",
				// The source's exact profile, overrides included: re-resolving could
				// hand the fork a profile the branch it inherits was never written under.
				resolvedProfile: {
					profile: source.resolvedProfile,
					source: source.profile.source,
					entryId: source.profile.entryId,
				},
				session,
				sessionMetadata: await session.getMetadata(),
				model: options.model ?? source.harness.getModel(),
				thinkingLevel: options.thinkingLevel ?? source.harness.getThinkingLevel(),
				settings,
				toolPolicy: source.toolPolicy,
				parent: options.parent,
			};
		}

		const resolvedProfile = await this._resolveCreateProfile(options.origin);
		const agentId = this._allocateAgentId(resolvedProfile.profile);
		const session = await this.sessionManager.createAgentSession({ agentId, agentProfile: resolvedProfile.profile });
		return {
			agentId,
			origin: "new",
			resolvedProfile,
			session,
			sessionMetadata: await session.getMetadata(),
			model: options.model ?? this._defaultModel,
			thinkingLevel: options.thinkingLevel ?? this._defaultThinkingLevel,
			settings,
			toolPolicy: { requestedToolNames: resolvedProfile.profile.tools, activeToolSelection: { mode: "default_all" } },
			parent: options.parent,
		};
	}

	/**
	 * Build everything in local variables; the live registry is not touched until
	 * this succeeds.
	 *
	 * Order matters: attach background, activate the runner, apply provider
	 * contributions, resolve scoped tools against those contributions, create the
	 * harness, then bind. The reservation is re-checked after every await, and any
	 * failure releases in reverse order.
	 */
	private async _buildLiveAgent(
		request: AgentBuildRequest,
		reservation: AgentCreationReservation,
	): Promise<LiveAgentBuild> {
		const { agentId, resolvedProfile } = request;
		const { profile } = resolvedProfile;
		const generation = (this._agentGenerations.get(agentId) ?? 0) + 1;
		const partial: {
			backgroundAttachment?: OwnerAttachment;
			extensionRunner?: ExtensionRunner;
			extensionBindings?: ExtensionRunnerBindings;
			harness?: WidiAgentHarness;
			releaseHarnessBindings?: () => Promise<void>;
		} = {};

		try {
			const sessionId = (await request.session.getMetadata()).id;
			partial.backgroundAttachment = await this._backgroundJobs.attachAgent({ agentId, sessionId });
			this._assertBuildNotCancelled(agentId, reservation);

			const extensionRunner = await this._createExtensionRunner(agentId, profile.id);
			partial.extensionRunner = extensionRunner;
			await this._publishDiagnostics(extensionRunner.diagnostics);
			this._addAgentDiagnostics(agentId, extensionRunner.diagnostics);
			const blocked = extensionRunner.diagnostics.find(isBlockedExtensionDiagnostic);
			if (blocked) throw new OrchestratorError(blocked);
			// Before the harness exists, so contributed models are selectable from the
			// first turn. This spawn's own model resolution already happened.
			await this._applyExtensionProviderContributions(agentId, extensionRunner);
			this._assertBuildNotCancelled(agentId, reservation);

			const loaded = await this.resourceLoader.loadAgentResources(profile);
			const resourceDiagnostics = loaded.diagnostics.map((diagnostic) => ({ ...diagnostic, agentId }));
			await this._publishDiagnostics(resourceDiagnostics);
			this._addAgentDiagnostics(agentId, resourceDiagnostics);
			this._assertBuildNotCancelled(agentId, reservation);

			const resources: AgentResourcesSnapshot = {
				skills: loaded.skills.map(({ skill, source }) => ({ name: skill.name, source })),
				promptTemplates: loaded.promptTemplates.map(({ promptTemplate, source }) => ({
					name: promptTemplate.name,
					source,
				})),
			};
			const systemPrompt: AgentSystemPromptFacts = {
				basePrompt: profile.systemPrompt,
				skills: loaded.skills.map(({ skill }) => skill),
				// The role's own append text is the most specific statement about this
				// agent, so it comes first; extension sections follow, read per turn.
				appendSections: profile.appendSystemPrompt ? [profile.appendSystemPrompt] : [],
				contextFiles: loaded.contextFiles,
				...(profile.skillsListing === undefined ? undefined : { includeSkills: profile.skillsListing }),
				// The resource loader's cwd, not the execution env's: the file tools
				// resolve relative paths against it, and the prompt must name the same one.
				...((profile.includeCwd ?? true) ? { cwd: this.resourceLoader.getCwd() } : undefined),
			};

			const resolvedTools = await this._resolveAgentToolsForBuild(agentId, request.toolPolicy, extensionRunner);
			this._assertBuildNotCancelled(agentId, reservation);

			const harness: WidiAgentHarness = new AgentHarness({
				session: request.session,
				models: this.modelRegistry.getRuntime(),
				toolContext: () => this._createToolAdapterContext(agentId, profile.id),
				streamOptions: request.settings.providerRetry,
				retry: request.settings.retry,
				tools: resolvedTools.tools,
				// A callback, so the listing tracks the harness's active tools at each
				// turn start and follows a reload that replaced the runner.
				systemPrompt: ({ activeTools }) => this._composeAgentSystemPrompt(agentId, activeTools),
				model: request.model,
				thinkingLevel: request.thinkingLevel,
				activeToolNames: [...resolvedTools.activeToolNames],
				steeringMode: this.settingManager.getSteeringMode(),
				followUpMode: this.settingManager.getFollowUpMode(),
			});
			partial.harness = harness;

			const liveAgent: LiveAgent = {
				agentId,
				generation,
				profile: createAgentProfileRecordReference(resolvedProfile),
				resolvedProfile: profile,
				...(request.sessionMetadata === undefined ? undefined : { sessionMetadata: request.sessionMetadata }),
				resources,
				systemPrompt,
				harness,
				settings: request.settings,
				backgroundAttachment: partial.backgroundAttachment,
				extensionRunner,
				extensionBindings: { release: async () => {} },
				toolPolicy: resolvedTools.policy,
				releaseHarnessBindings: async () => {},
			};

			const extensionBindings = await this._bindExtensionRunner(agentId, generation, harness, extensionRunner);
			partial.extensionBindings = extensionBindings;
			liveAgent.extensionBindings = extensionBindings;

			const releaseHarnessBindings = await this._bindHarness(agentId, generation, harness);
			partial.releaseHarnessBindings = releaseHarnessBindings;
			Object.assign(liveAgent, { releaseHarnessBindings });
			this._assertBuildNotCancelled(agentId, reservation);

			const treeRecord = await this._createTreeSpawnRecord(request);
			return treeRecord ? { liveAgent, treeRecord } : { liveAgent };
		} catch (error) {
			await this._releaseFailedBuild(agentId, partial, error);
			throw error;
		}
	}

	/**
	 * Spawn's only routing cutover, with no await in between. Appearing in `_live`
	 * is what makes an agent routable; there is no intermediate "registered but
	 * harness pending" state for anything to observe.
	 */
	private _installLiveAgent(build: LiveAgentBuild): AgentId {
		const { liveAgent } = build;
		const { agentId } = liveAgent;
		this._agentGenerations.set(agentId, liveAgent.generation);
		// A resumed session legitimately reuses an id this runtime buried earlier.
		this._tombstones.delete(agentId);
		this._live.set(agentId, liveAgent);
		// The first idle has no turn behind it; every later one is stamped by
		// whoever ended the work.
		this._agentIdleReasons.set(agentId, "ready");
		if (build.treeRecord) {
			this._spawnParent.set(agentId, build.treeRecord.spawnedBy);
		}
		this._context.attach(agentId, liveAgent.generation);
		this._assertRegistryInvariant(agentId);
		return agentId;
	}

	/**
	 * Release a build that failed or was cancelled.
	 *
	 * `shutdown()` rather than `abort()`: this harness was never routable, but the
	 * build may already have bound interceptors or written to its session, so
	 * sealing it is closer to the truth than leaving it usable.
	 *
	 * **No tombstone is written**: the agent never existed, so its AgentId stays
	 * available to a later spawn. The failure reaches the caller as the throw.
	 */
	private async _releaseFailedBuild(
		agentId: AgentId,
		build: {
			backgroundAttachment?: OwnerAttachment;
			extensionRunner?: ExtensionRunner;
			extensionBindings?: ExtensionRunnerBindings;
			harness?: WidiAgentHarness;
			releaseHarnessBindings?: () => Promise<void>;
			liveAgent?: LiveAgent;
		},
		error: unknown,
	): Promise<void> {
		const liveAgent = build.liveAgent;
		const harness = build.harness ?? liveAgent?.harness;
		const runner = build.extensionRunner ?? liveAgent?.extensionRunner;
		const bindings = build.extensionBindings ?? liveAgent?.extensionBindings;
		const releaseHarnessBindings = build.releaseHarnessBindings ?? liveAgent?.releaseHarnessBindings;

		await this._tryTeardown(agentId, "release harness bindings", async () => {
			await releaseHarnessBindings?.();
		});
		if (harness) {
			await this._tryTeardown(agentId, "shut down harness", async () => {
				await harness.shutdown();
			});
		}
		if (runner) {
			await this._tryTeardown(agentId, "dispose extension runner", async () => {
				await this._disposeExtensionRunner(agentId, runner, bindings, "Agent creation failed.");
			});
		}
		await this._tryTeardown(agentId, "withdraw providers", async () => {
			await this._withdrawExtensionProviderContributions(agentId);
		});
		this._backgroundJobs.detachAgent(agentId);
		await this._clearExtensionStatusesForAgent(agentId);
		this._agentDiagnostics.delete(agentId);
		await this._publishDiagnostic({
			severity: "error",
			code: "orchestrator.agent_creation_failed",
			message: `Cannot create agent ${agentId}: ${formatError(error)}`,
			agentId,
		});
	}

	/**
	 * Answer every t0 handle a previous runtime left open on this session. The
	 * jobs are gone, so this recovers the conversation rather than the work: each
	 * unanswered handle gets one closing message.
	 *
	 * The session history, not the job log, decides what is unanswered: a message
	 * queued into a harness is never persisted, so acceptance is no evidence the
	 * model read it.
	 *
	 * **Session write.** `harness.appendMessage` puts this on the branch, because
	 * the text must be in the session the moment this returns - a second
	 * interrupted resume has to find it and stay idempotent. Called before the
	 * agent becomes routable: a stale result arriving after that is a message,
	 * not context.
	 */
	private async _reconcileCarriedOverJobs(agentId: AgentId): Promise<void> {
		const carried = this._backgroundJobs.carriedOverJobs(agentId);
		if (carried.length === 0) return;
		const liveAgent = this._live.get(agentId);
		if (!liveAgent) return;
		const snapshot = await this.sessionManager.getAgentSessionSnapshot(agentId);
		const branchText = collectUserMessageText(snapshot.pathToRoot);
		const unanswered = carried.filter(
			(job) => !branchText.some((text) => text.includes(backgroundJobResultHeaderPrefix(job.jobId, job.toolCallId))),
		);
		if (unanswered.length === 0) return;
		try {
			await liveAgent.harness.appendMessage({
				role: "user",
				content: [{ type: "text", text: unanswered.map(toCarriedOverJobResultText).join("\n\n") }],
				timestamp: Date.now(),
			});
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.background_jobs_interrupted",
				`Failed to close carried-over background jobs for agent ${agentId}: ${formatError(error)}`,
			);
			return;
		}
		await this._publishDiagnostic({
			severity: "warning",
			code: "orchestrator.background_jobs_interrupted",
			message: `Agent ${agentId} resumed with ${unanswered.length} background job result(s) left unanswered by a previous run; they were closed in the session.`,
			agentId,
		});
	}

	/** A readable AgentId that collides with no live agent and no tombstone. */
	private _allocateAgentId(profile: AgentProfile): AgentId {
		const base =
			profile.label
				.trim()
				.toLocaleLowerCase()
				.replace(/[^a-z0-9-]+/g, "-")
				.replace(/^-+|-+$/g, "") || "agent";
		let agentId: AgentId = base;
		let suffix = 2;
		while (this._resolveAgent(agentId).kind !== "unknown") {
			agentId = `${base}-${suffix}`;
			suffix += 1;
		}
		return agentId;
	}

	private _assertAgentCanParent(parentAgentId: AgentId): void {
		this._requireLiveAgent(parentAgentId);
	}

	private _createAgentCreationReservation(agentId: AgentId): AgentCreationReservation {
		let settle!: (agentId: AgentId) => void;
		let fail!: (error: unknown) => void;
		const completion = new Promise<AgentId>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		const reservation: AgentCreationReservation = {
			agentId,
			completion,
			cancelled: false,
			cancel: () => {
				reservation.cancelled = true;
			},
		};
		// A rejection with no awaiter is an unhandled rejection.
		completion.catch(() => {});
		Object.assign(reservation, { _settle: settle, _fail: fail });
		this._agentCreations.set(agentId, reservation);
		return reservation;
	}

	private _finishAgentCreation(
		agentId: AgentId,
		reservation: AgentCreationReservation,
		result: AgentId | undefined,
		error?: unknown,
	): void {
		if (this._agentCreations.get(agentId) === reservation) {
			this._agentCreations.delete(agentId);
		}
		const settlers = reservation as unknown as { _settle: (agentId: AgentId) => void; _fail: (error: unknown) => void };
		if (result === undefined) settlers._fail(error);
		else settlers._settle(result);
	}

	private _assertBuildNotCancelled(agentId: AgentId, reservation: AgentCreationReservation): void {
		if (!reservation.cancelled) return;
		throw new OrchestratorError({
			severity: "error",
			code: "orchestrator.agent_creation_cancelled",
			message: `Creation of agent ${agentId} was cancelled.`,
			agentId,
		});
	}

	// -----------------------------------------------------------------------
	// Dispose
	// -----------------------------------------------------------------------

	/**
	 * Dispose one agent or a whole subtree. Every target completes its `_live`
	 * removal, tombstone write and background detach before the first await, so
	 * "is it routable" collapses to `_live.has(agentId)` and no second `disposing`
	 * set is needed.
	 */
	async disposeAgent(agentId: AgentId, options: DisposeAgentOptions): Promise<readonly AgentId[]> {
		const targets = options.scope === "subtree" ? this._collectAgentSubtreePostOrder(agentId) : [agentId];
		// Duplicate requests share one teardown. A subtree dispose must wait for a
		// descendant somebody else is tearing down before it removes the ancestor,
		// which is what makes this a lookup rather than a skip.
		const pending = targets
			.map((target) => this._agentDisposals.get(target))
			.filter((reservation) => reservation !== undefined);
		if (pending.length > 0) {
			await Promise.allSettled(pending.map((entry) => entry.completion));
		}

		const disposed = this._cutOverDisposed(targets, options);
		if (disposed.length === 0) return [];

		const failures: unknown[] = [];
		for (const target of disposed) {
			let settle!: () => void;
			const completion = new Promise<void>((resolve) => {
				settle = resolve;
			});
			this._agentDisposals.set(target.agentId, { agentId: target.agentId, completion });
			try {
				await this._disposeLiveAgent(target, options);
			} catch (error) {
				failures.push(error);
			} finally {
				const reservation = this._agentDisposals.get(target.agentId);
				if (reservation?.completion === completion) {
					this._agentDisposals.delete(target.agentId);
				}
				settle();
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, `Failed to dispose ${failures.length} agents in subtree ${agentId}.`);
		}
		return disposed.map((target) => target.agentId);
	}

	/**
	 * Complete the cutover with no await. `_spawnParent` is not deleted here: the
	 * edge belongs to surviving descendants.
	 *
	 * Two orderings are contractual. The background detach must come after the
	 * agent is marked as going away and before any other teardown. Cancelling the
	 * queue must precede the harness teardown: a cancelled queue swaps its array,
	 * which is how requeue logic decides an undeliverable message is
	 * `target_unavailable` instead of taking an extra lap through a shutdown code.
	 */
	private _cutOverDisposed(targets: readonly AgentId[], options: DisposeAgentOptions): readonly DisposedLiveAgent[] {
		const disposed: DisposedLiveAgent[] = [];
		for (const agentId of targets) {
			const liveAgent = this._live.get(agentId);
			const creation = this._agentCreations.get(agentId);
			if (!liveAgent && !creation) continue;
			// Cancelled rather than waited on: the build's own failure path releases
			// everything it had allocated.
			creation?.cancel();
			this._live.delete(agentId);
			if (options.intent === "removed") this._tombstones.add(agentId);
			this._messages.cancel(
				agentId,
				options.reason ?? `Agent ${agentId} was disposed before the message was delivered.`,
			);
			this._backgroundJobs.detachAgent(agentId);
			disposed.push(liveAgent ? { agentId, liveAgent } : { agentId });
		}
		return disposed;
	}

	/**
	 * Release the harness, runner, bindings and surrounding workflows through the
	 * references captured before the cutover. Failures record a diagnostic and
	 * never restore live routing.
	 *
	 * **abort() first, then shutdown().** `abort()` lets the interrupted turn run
	 * its `finally` and flush the session writes it buffered; `shutdown()`
	 * **discards** pending writes and so can never stand in for it. Both are
	 * idempotent.
	 *
	 * **shutdown() may only be disposal's tail.** `abort()` is not a tracked task,
	 * so a concurrent shutdown can clear the subscriber table before abort emits
	 * its last event. That is harmless only because this disposal is the sole
	 * source of concurrency; a future "seal the harness but keep the agent" use
	 * requires making `abort()` a harness lifecycle task first.
	 *
	 * `shutdown()` waits unbounded - it depends on every awaited tool honouring
	 * the abort signal, and `ask_human` inside a tool call is a counter-example -
	 * so the timeout is required. On expiry the teardown continues without
	 * restoring routing; the harness has already sealed further writes.
	 */
	private async _disposeLiveAgent(disposed: DisposedLiveAgent, options: DisposeAgentOptions): Promise<void> {
		const { agentId, liveAgent } = disposed;
		const reason = options.reason ?? `Agent disposed: ${agentId}`;

		this._humanInterrupts.forget(agentId);
		this._resolveAgentRunStartWaiters(agentId);
		this._rejectAgentIdleWaiters(agentId, `Agent ${agentId} was disposed while waiting for it to idle.`);
		// A resumed session reuses this id; all of these describe the occupant that
		// just left.
		this._agentIdleReasons.delete(agentId);
		this._publishedAgentIdles.delete(agentId);
		this._agentPromptRuns.delete(agentId);
		this._agentRunSignals.delete(agentId);
		this._autoCompactingAgents.delete(agentId);
		this._publishedAgentActivities.delete(agentId);
		this._pendingExtensionInputPresentations.delete(agentId);
		this._extensionObserverDispatchDepth.delete(agentId);

		if (liveAgent) {
			await this._tryTeardown(agentId, "abort", async () => {
				await liveAgent.harness.abort();
			});
			await this._tryTeardown(agentId, "release harness bindings", async () => {
				await liveAgent.releaseHarnessBindings();
			});
			await this._tryTeardown(agentId, "dispose extension runner", async () => {
				await this._disposeExtensionRunner(
					agentId,
					liveAgent.extensionRunner,
					liveAgent.extensionBindings,
					"Agent has been disposed.",
				);
			});
			await this._tryTeardown(agentId, "withdraw providers", async () => {
				await this._withdrawExtensionProviderContributions(agentId);
			});
			await this._tryTeardown(agentId, "shut down harness", async () => {
				await withTimeout(
					liveAgent.harness.shutdown(),
					AGENT_SHUTDOWN_TIMEOUT_MS,
					`Timed out waiting for agent ${agentId} to shut down.`,
				);
			});
			this._context.detach(agentId, liveAgent.generation);
		}

		await this._clearExtensionStatusesForAgent(agentId);
		await this._humanRequests.cancelForAgent(agentId, reason);
		await this._recordAgentRemovedFromTree(agentId, options.intent);
		this._pruneSpawnEdges(agentId);
		await this._emit({
			type: "agent_disposed",
			agentId,
			intent: options.intent,
			...(options.reason === undefined ? undefined : { reason: options.reason }),
			disposedAt: now(),
		});
	}

	/**
	 * Sever every live route, then release all runtime resources. Not
	 * `requestShutdown()`, which only broadcasts a request to extensions.
	 *
	 * `_shutdownRequested` first, then in-flight reservations cancelled and
	 * awaited, then the sweep with intent `runtime_shutdown` so nothing durable is
	 * written. Any other order lets an agent finish installing after the sweep
	 * passed it. When this returns every harness is sealed and its writes landed.
	 */
	async disposeAll(reason?: string): Promise<void> {
		this._shutdownRequested = true;
		for (const reservation of [...this._agentCreations.values()]) {
			reservation.cancel();
		}
		await Promise.allSettled([...this._agentCreations.values()].map((reservation) => reservation.completion));
		for (const agentId of [...this._live.keys()]) {
			try {
				await this.disposeAgent(agentId, {
					intent: "runtime_shutdown",
					...(reason === undefined ? undefined : { reason }),
				});
			} catch (error) {
				await this._publishDiagnostic({
					severity: "warning",
					code: "orchestrator.dispose_all_failed",
					message: `Failed to dispose agent ${agentId}: ${formatError(error)}`,
					agentId,
				});
			}
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

	/** Run one teardown step; a failure is recorded and never re-thrown. */
	private async _tryTeardown(agentId: AgentId, step: string, run: () => Promise<void>): Promise<void> {
		try {
			await run();
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.agent_dispose_failed",
				`Failed to ${step} for agent ${agentId}: ${formatError(error)}`,
			);
		}
	}

	// -----------------------------------------------------------------------
	// Input and message dispatch
	// -----------------------------------------------------------------------

	/**
	 * The unified entry point, for the trusted shell (TUI, RPC) which may
	 * construct a `human` or `system` source. Agent identity is synthesized by the
	 * agent-facing path instead.
	 */
	async sendMessage(draft: MessageDraft): Promise<MessageSendOutcome> {
		const accepted = await this._routeMessage(draft, { requiresIdle: false, awaited: false });
		return accepted.kind === "blocked" ? accepted : { kind: "accepted" };
	}

	/** The same pipeline, waiting for the assistant message the surface will render. */
	async promptAgent(
		agentId: AgentId,
		text: string,
		options?: { readonly images?: readonly ImageContent[]; readonly presentation?: ExtensionInputPresentationRecord },
	): Promise<PromptOutcome> {
		const accepted = await this._routeMessage(
			{
				source: { kind: "human" },
				targetAgentId: agentId,
				body: text,
				...(options?.images === undefined ? undefined : { images: options.images }),
				mode: "next_turn",
			},
			{
				requiresIdle: true,
				awaited: true,
				...(options?.presentation === undefined ? undefined : { presentation: options.presentation }),
			},
		);
		if (accepted.kind === "blocked") return accepted;
		const completed = accepted.receipt.completed;
		if (!completed) {
			throw new Error(
				`Prompt for agent ${agentId} was delivered as ${accepted.receipt.method} and produced no assistant message.`,
			);
		}
		return { kind: "completed", message: await completed };
	}

	/**
	 * Run one message through interception, session accounting, and the target's
	 * delivery queue. It stays in this class because every step's dependency is
	 * here: interception needs the target's runner, accounting its harness, the
	 * input events the bus.
	 *
	 * `requiresIdle` means only that the caller must receive this run's assistant
	 * result, so a busy target is refused up front rather than silently becoming a
	 * follow-up whose reply nobody awaits.
	 */
	private async _routeMessage(draft: MessageDraft, options: RouteMessageOptions): Promise<AcceptedMessage> {
		const agentId = draft.targetAgentId;
		assertMessageBody(draft.body);
		// Gate before interception and any session write: a prompt the harness would
		// reject must not emit input events or leave unpaired accounting entries.
		const target = this._resolveDeliveryTarget(agentId);
		if (options.requiresIdle && (target.phase !== "idle" || this._agentPromptRuns.has(agentId))) {
			throw new OrchestratorError({
				severity: "error",
				code: "orchestrator.agent_busy",
				message: `Agent ${agentId} cannot accept a prompt while ${target.phase}.`,
				agentId,
			});
		}

		const outcome = await transformMessage(draft, {
			intercept: async (event) => await this._interceptExtensionInput(agentId, draft.source, event),
		});

		if (outcome.kind === "block") {
			const inputId = this._createInputId();
			await this._emit({
				type: "input_blocked",
				agentId,
				inputId,
				originalText: draft.body,
				...(outcome.reason === undefined ? undefined : { reason: outcome.reason }),
				blockedBy: outcome.blockedBy,
				createdAt: now(),
			});
			return {
				kind: "blocked",
				inputId,
				...(outcome.reason === undefined ? undefined : { reason: outcome.reason }),
				blockedBy: outcome.blockedBy,
			};
		}

		if (outcome.kind === "transform") {
			const inputId = this._createInputId();
			await this._emit({
				type: "input_transformed",
				agentId,
				inputId,
				originalText: draft.body,
				text: outcome.text,
				transformedBy: outcome.transformedBy,
				createdAt: now(),
			});
			await this._writeInputTransformEntry(target, {
				inputId,
				originalText: draft.body,
				text: outcome.text,
				transformedBy: outcome.transformedBy,
			});
		}

		// A job result is the one source with no caller left to hear about a failure:
		// its tool call already returned, and the model waits for exactly one t1 that
		// nobody else will resend. It is also the only source whose messages merge,
		// each already carrying its own job header.
		const jobSource = draft.source.kind === "background_job" ? draft.source : undefined;
		const pending: PendingExtensionInputPresentation | undefined = options.presentation
			? {
					extensionId: options.presentation.extensionId,
					presentation: validateExtensionInputPresentation(options.presentation.presentation),
				}
			: undefined;
		const receipt = await this._messages.enqueue({
			targetAgentId: agentId,
			text: renderMessageEnvelope(draft.source, outcome.text),
			...(outcome.images === undefined ? undefined : { images: outcome.images }),
			mode: draft.mode,
			requiresIdle: options.requiresIdle,
			humanInterrupt: draft.source.kind === "human",
			...(jobSource === undefined
				? undefined
				: {
						mergeKey: backgroundResultMergeKey(draft.mode),
						onDeferredFailure: (error: unknown) => {
							void this._reportDeferredDeliveryFailure(agentId, jobSource.jobId, error);
						},
					}),
			awaited: options.awaited,
			retryOnFailure: jobSource !== undefined,
			...(pending === undefined
				? undefined
				: {
						onDeliveryStart: (method: MessageDeliveryMethod) => {
							this._beginExtensionInputPresentationDelivery(agentId, pending, method);
						},
						onDeliveryFailure: () => {
							this._discardPendingExtensionInputPresentation(agentId, pending);
						},
					}),
		});
		return { kind: "accepted", receipt };
	}

	/**
	 * Record that an extension rewrote this message before the model saw it.
	 *
	 * **Session write.** `harness.appendCustomEntry` puts it on the branch because
	 * it is the durable half of a dual record: the user message carries the text
	 * the model read, and only this entry can still answer what was submitted
	 * after a resume. Blocked input writes nothing.
	 *
	 * The entry names its `inputId` rather than relying on adjacency, so a write
	 * buffered behind a running turn landing after the message it describes is a
	 * display-order wrinkle, not a lost pair. There is no retraction path.
	 */
	private async _writeInputTransformEntry(
		target: DeliveryTarget,
		transform: {
			readonly inputId: string;
			readonly originalText: string;
			readonly text: string;
			readonly transformedBy: readonly string[];
		},
	): Promise<void> {
		await target.harness.appendCustomEntry(INPUT_TRANSFORM_CUSTOM_TYPE, {
			inputId: transform.inputId,
			originalText: transform.originalText,
			text: transform.text,
			transformedBy: transform.transformedBy,
		} satisfies InputTransformEntryData);
	}

	/** The first availability gate: harness, generation, and the phase read on the spot. */
	private _resolveDeliveryTarget(agentId: AgentId): DeliveryTarget {
		const liveAgent = this._requireLiveAgent(agentId);
		return {
			agentId,
			generation: liveAgent.generation,
			harness: liveAgent.harness,
			phase: liveAgent.harness.getPhase(),
		};
	}

	/** The queue's `resolvePhase` port, re-read before every attempt. `undefined` means unroutable. */
	private _resolveDeliveryPhase(agentId: AgentId): MessageDeliveryPhase {
		return this._live.get(agentId)?.harness.getPhase();
	}

	/**
	 * The queue's `deliver` port. The method was chosen from the phase the queue
	 * re-read; the race between reading and calling is arbitrated by the typed
	 * harness errors, which the queue retries on the next phase change.
	 */
	private async _deliverQueuedMessage(request: MessageDeliveryRequest): Promise<MessageDeliveryReceipt> {
		const { agentId } = request;
		const liveAgent = this._live.get(agentId);
		if (!liveAgent) {
			// Terminal for the queue: no phase change brings a routing entry back, so
			// a `retryOnFailure` message must not sit here waiting for one.
			throw new AgentHarnessError("shutdown", `Agent ${agentId} is no longer routable.`);
		}
		const { harness } = liveAgent;
		const options = request.images ? { images: [...request.images] } : undefined;
		if (request.method === "prompt") {
			return await this._startPrompt(
				{ agentId, generation: liveAgent.generation, harness, phase: harness.getPhase() },
				request,
			);
		}
		if (request.method === "follow_up") {
			await harness.followUp(request.text, options);
			return { method: "follow_up" };
		}
		// A human steer counts as read only once the harness reports an empty
		// steering queue, so the interrupt is registered around the hand-over.
		const clearRevision = request.humanInterrupt ? this._humanInterrupts.captureClearRevision(agentId) : undefined;
		await harness.steer(request.text, options);
		if (clearRevision !== undefined) {
			this._humanInterrupts.notifyIfUncleared(agentId, clearRevision);
		}
		return { method: "steer" };
	}

	/**
	 * The only delivery that must produce an assistant result.
	 *
	 * Acceptance waits for the harness's own `agent_start`, racing the run
	 * promise's rejection: a failure before that event means the user message was
	 * never persisted, and resolving early would let the queue drop a background
	 * job t1 the model is waiting for.
	 */
	private async _startPrompt(target: DeliveryTarget, request: MessageDeliveryRequest): Promise<MessageDeliveryReceipt> {
		const { agentId, harness } = target;
		if (target.phase !== "idle" || this._agentPromptRuns.has(agentId)) {
			throw new AgentHarnessError("busy", `Agent ${agentId} cannot accept a prompt while ${target.phase}.`);
		}

		// Registered before the call, so a fast `agent_start` cannot be missed.
		const started = this._awaitAgentRunStart(agentId);
		const promptRun: AgentPromptRun = {};
		this._agentPromptRuns.set(agentId, promptRun);
		const run = harness.prompt(request.text, {
			...(request.images === undefined ? undefined : { images: [...request.images] }),
		});
		// A run that settles without ever starting a loop still resolves here.
		const start = await Promise.race([
			started.reached,
			run.then(
				() => ({ kind: "started" }) as const,
				(error: unknown) => ({ kind: "rejected", error }) as const,
			),
		]);
		started.cancel();
		if (start.kind === "rejected") {
			if (this._agentPromptRuns.get(agentId) === promptRun) {
				this._agentPromptRuns.delete(agentId);
				// Nothing else will publish this edge: the run that would have has
				// already failed. `_settleAgentIdle` re-reads the live phase, so a
				// `busy` rejection just finds the agent still working and re-arms.
				await this._settleAgentIdle(agentId);
			}
			throw start.error;
		}

		void this._finishPrompt(agentId, run, promptRun, { reportFailure: !request.awaited }).catch(() => {});
		return { method: "prompt", completed: run };
	}

	/**
	 * Close out a prompt run and publish the idle edge it produced. Staleness is
	 * by object identity: a completion whose run was replaced while its promise
	 * settled must not stamp the successor's idle reason.
	 */
	private async _finishPrompt(
		agentId: AgentId,
		run: Promise<AssistantMessage>,
		promptRun: AgentPromptRun,
		options: { readonly reportFailure: boolean },
	): Promise<void> {
		try {
			const message = await run;
			if (message.stopReason === "aborted") promptRun.idleReason = "aborted";
		} catch (error) {
			if (options.reportFailure) {
				await this._recordAgentLifecycleFailure(
					agentId,
					"orchestrator.agent_message_prompt_failed",
					`Prompt for agent ${agentId} failed after delivery: ${formatError(error)}`,
				);
			}
		} finally {
			if (this._agentPromptRuns.get(agentId) === promptRun) {
				this._agentPromptRuns.delete(agentId);
				this._agentIdleReasons.set(agentId, promptRun.idleReason ?? "settled");
				this._messages.wake(agentId);
				// The phase is already idle; clearing this run is the last fact the
				// waiters and the observable edge were missing.
				await this._settleAgentIdle(agentId);
			}
		}
	}

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
	 * Reported per attempt, so a target that never accepts is visible instead of
	 * silently accumulating messages.
	 */
	private async _reportDeferredDeliveryFailure(agentId: AgentId, jobId: string, error: unknown): Promise<void> {
		await this._publishDiagnostic({
			severity: "warning",
			code: "orchestrator.background_job_delivery_failed",
			message: `Background job ${jobId} result delivery to agent ${agentId} failed, will retry at the next transition: ${formatError(error)}`,
			agentId,
		});
	}

	/**
	 * The background runtime's t1 delivery port: hands the text to the ordinary
	 * message entry point, reading no job record and deciding no lifecycle.
	 */
	private async _deliverBackgroundResult(delivery: BackgroundJobDelivery): Promise<BackgroundJobDeliveryReceipt> {
		const agentId = delivery.ownerAgentId;
		try {
			await this.sendMessage({
				source: { kind: "background_job", ownerAgentId: agentId, jobId: delivery.jobId },
				targetAgentId: agentId,
				body: delivery.body,
				mode: "interrupt",
			});
		} catch (error) {
			// Retryable failures keep the result queued, so reaching here means the
			// owner can never take it.
			await this._publishDiagnostic({
				severity: "warning",
				code: "orchestrator.background_job_dropped",
				message: `Dropping the result of background job ${delivery.jobId} for agent ${agentId}: ${formatError(error)}`,
				agentId,
			});
		}
		return {};
	}

	// -----------------------------------------------------------------------
	// Low-level harness input
	//
	// Entry points for a caller that has already decided how the text must land.
	// They run the AgentId gate, the phase gate and the human-interrupt
	// coordination, but not `sendMessage`'s interception or session accounting.
	// -----------------------------------------------------------------------

	async steerAgent(
		agentId: AgentId,
		text: string,
		options?: { readonly images?: readonly ImageContent[] },
	): Promise<void> {
		const harness = this._requireHarnessOutsideMaintenance(agentId, "steer");
		await harness.steer(text, toHarnessMessageOptions(options));
	}

	async followUpAgent(
		agentId: AgentId,
		text: string,
		options?: { readonly images?: readonly ImageContent[] },
	): Promise<void> {
		const harness = this._requireHarnessOutsideMaintenance(agentId, "queue a follow-up");
		await harness.followUp(text, toHarnessMessageOptions(options));
	}

	/**
	 * Promote queued follow-ups into steering, so they are read at the next turn
	 * boundary. Wrapped rather than exposed as a bare `promoteFollowUpsToSteer`
	 * because it adds the human-interrupt coordination. Returns how many moved.
	 */
	async steerQueuedFollowUps(agentId: AgentId): Promise<number> {
		const harness = this._requireHarnessOutsideMaintenance(agentId, "steer queued follow-ups");
		const clearRevision = this._humanInterrupts.captureClearRevision(agentId);
		const promoted = await harness.promoteFollowUpsToSteer();
		if (promoted.length > 0) {
			this._humanInterrupts.notifyIfUncleared(agentId, clearRevision);
		}
		return promoted.length;
	}

	/**
	 * End the current harness operation. The result comes straight from the
	 * harness; there is no aborted/running mirror. The harness can also cancel
	 * compaction and branch summary, but `_requireHarnessOutsideMaintenance`
	 * refuses those phases here - disposal is what uses that capability.
	 */
	async abortAgent(agentId: AgentId): Promise<AbortResult> {
		const harness = this._requireHarnessOutsideMaintenance(agentId, "abort");
		const promptRun = this._agentPromptRuns.get(agentId);
		if (promptRun) promptRun.idleReason = "aborted";
		return await harness.abort();
	}

	// -----------------------------------------------------------------------
	// Activity and the idle edge
	// -----------------------------------------------------------------------

	/** Whether the delivery queue or either harness queue still holds unread text. */
	agentHasPendingMessages(agentId: AgentId): boolean {
		if (this._messages.hasPending(agentId)) return true;
		const liveAgent = this._live.get(agentId);
		return liveAgent ? queuedMessageCount(liveAgent.harness) > 0 : false;
	}

	/**
	 * A join across four sources: the phase is idle, both harness queues are
	 * empty, `_messages` has nothing pending, and no prompt run started by this
	 * class is in flight. The last cannot be dropped - the phase goes idle inside
	 * `agent_end` while `prompt()` still has a flush to do in its `finally`.
	 *
	 * Not a synonym for `harness.waitForIdle()`, which looks at no queue at all,
	 * so a harness holding a steer reads as idle there.
	 */
	isAgentIdle(agentId: AgentId): boolean {
		return this._resolveAgentIdleState(agentId).kind === "idle";
	}

	/** Rejects rather than hanging when the agent can never reach that condition. */
	async waitForAgentIdle(agentId: AgentId, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
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
				// Detached in the finally below: the caller's signal usually outlives one
				// wait, so a listener left behind pins this closure for its lifetime.
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
			});
		} finally {
			if (onAbort) options.signal?.removeEventListener("abort", onAbort);
			waiters.delete(waiter);
			if (waiters.size === 0) this._agentIdleWaiters.delete(agentId);
		}
	}

	/** Idle now, never going to be, or still busy. A creating agent counts as busy. */
	private _resolveAgentIdleState(agentId: AgentId): AgentIdleState {
		const lookup = this._resolveAgent(agentId);
		if (lookup.kind === "creating") return { kind: "busy" };
		if (lookup.kind !== "live") {
			return { kind: "gone", message: `Agent ${agentId} is gone.` };
		}
		const { harness } = lookup.liveAgent;
		if (harness.getPhase() !== "idle") return { kind: "busy" };
		if (this._agentPromptRuns.has(agentId)) return { kind: "busy" };
		if (queuedMessageCount(harness) > 0) return { kind: "busy" };
		return this._messages.hasPending(agentId) ? { kind: "busy" } : { kind: "idle" };
	}

	/**
	 * Waiters first, then the event: waiters resolve synchronously while a
	 * listener may take as long as it likes.
	 *
	 * `liveJobCount` is a query, not a term in the judgement: an unsettled job
	 * never makes its owner busy, it only tells a consumer that this idle is an
	 * agent waiting rather than an agent done.
	 */
	private async _settleAgentIdle(agentId: AgentId): Promise<void> {
		this._settleAgentIdleWaiters(agentId);
		const state = this._resolveAgentIdleState(agentId);
		if (state.kind !== "idle") {
			// Busy or gone re-arms the edge. A gone agent never publishes: being torn
			// down is not becoming idle in any useful sense.
			this._publishedAgentIdles.delete(agentId);
			return;
		}
		if (this._publishedAgentIdles.has(agentId)) return;
		this._publishedAgentIdles.add(agentId);
		await this._emit({
			type: "agent_idle",
			agentId,
			reason: this._agentIdleReasons.get(agentId) ?? "settled",
			liveJobCount: this._backgroundJobs.liveJobCount(agentId),
			idleAt: now(),
		});
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
	 * Edge detection driven by harness events. The activity value comes from the
	 * harness; the event supplies only the timing and the causality an
	 * `AgentIdleReason` needs, which no phase carries.
	 */
	private async _observeHarnessActivity(agentId: AgentId, generation: number, event: AgentHarnessEvent): Promise<void> {
		const liveAgent = this._live.get(agentId);
		if (!liveAgent || liveAgent.generation !== generation) return;

		if (event.type === "agent_start") {
			// The prompt's user message is now committed to this run. Resolved before
			// anything is awaited, so acceptance never waits on observers.
			this._resolveAgentRunStartWaiters(agentId);
		}
		// A turn may be followed by tool execution and another turn, so it is not
		// an idle boundary. It can still say that the eventual idle was an abort.
		if (event.type === "turn_end" && event.message.role === "assistant" && event.message.stopReason === "aborted") {
			const promptRun = this._agentPromptRuns.get(agentId);
			if (promptRun) promptRun.idleReason = "aborted";
		}
		if (event.type === "abort") {
			const promptRun = this._agentPromptRuns.get(agentId);
			if (promptRun) promptRun.idleReason = "aborted";
			else this._agentIdleReasons.set(agentId, "aborted");
			// Everything the abort cleared is text the harness will never write.
			this._discardQueuedExtensionInputPresentations(agentId);
		}
		// An empty steering queue is the only honest evidence that the human's
		// interrupt was read; an abort clears the queue through the same event.
		if (event.type === "queue_update" && event.steer.length === 0) {
			this._humanInterrupts.clear(agentId);
		}

		await this._publishAgentActivityEdge(agentId, liveAgent.harness.getPhase());
		// Every harness event can change the delivery phase: this is what resumes a
		// message deferred during maintenance or retried after a busy race.
		this._messages.wake(agentId);
		await this._settleAgentIdle(agentId);

		// Auto-compaction rides the settled fact: the harness is idle and its writes
		// are flushed, so the branch and the last assistant usage are durable. A
		// settled with queued next turns is skipped - the next run starts
		// immediately and compaction would race its own idle check.
		if (event.type === "settled" && event.nextTurnCount === 0) {
			// The measurement walks the branch, so it runs once and is handed on.
			const contextTokens = await this._context.refresh(agentId);
			await this._maybeAutoCompact(agentId, contextTokens);
		}
	}

	private async _publishAgentActivityEdge(agentId: AgentId, phase: AgentHarnessPhase): Promise<void> {
		const activity = toActivitySnapshot(phase);
		const previous = this._publishedAgentActivities.get(agentId);
		if (previous?.activity === activity.activity && previous.maintenance === activity.maintenance) {
			return;
		}
		this._publishedAgentActivities.set(agentId, activity);
		await this._emit({
			type: "agent_status_changed",
			agentId,
			...(previous === undefined ? undefined : { previousActivity: previous.activity }),
			activity: activity.activity,
			...(activity.maintenance === undefined ? undefined : { maintenance: activity.maintenance }),
			changedAt: now(),
		});
	}

	// -----------------------------------------------------------------------
	// Extension input presentations
	//
	// A presentation is delivered before the message it describes exists as a
	// session entry, so it waits in a per-target queue and is paired on the
	// harness `session_write` event.
	// -----------------------------------------------------------------------

	/**
	 * Wrap a direct steer or follow-up that carries a presentation, so a failed
	 * hand-off does not leave one waiting for a message that never lands.
	 */
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
		// A requeued delivery re-enters here; move it to the tail rather than leave
		// a duplicate that would pair with someone else's message.
		this._discardPendingExtensionInputPresentation(agentId, pending);
		pending.method = method;
		const presentations = this._pendingExtensionInputPresentations.get(agentId) ?? [];
		presentations.push(pending);
		this._pendingExtensionInputPresentations.set(agentId, presentations);
	}

	/**
	 * Pop the presentation belonging to the user message just persisted. Delivery
	 * order is the pairing rule and the queue serializes per target, so the head
	 * is the presentation of the oldest delivery still awaiting a write.
	 */
	private _takePendingExtensionInputPresentation(agentId: AgentId): PendingExtensionInputPresentation | undefined {
		const presentations = this._pendingExtensionInputPresentations.get(agentId);
		if (!presentations || presentations.length === 0) return undefined;
		const pending = presentations.shift();
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

	/**
	 * The steer and follow-up queues are emptied wholesale, so nothing delivered
	 * that way will ever be written. A `prompt` delivery is left alone: its user
	 * message was persisted at run start and an abort does not take it back.
	 */
	private _discardQueuedExtensionInputPresentations(agentId: AgentId): void {
		const presentations = this._pendingExtensionInputPresentations.get(agentId);
		if (!presentations) return;
		const remaining = presentations.filter((pending) => pending.method === "prompt");
		if (remaining.length === 0) {
			this._pendingExtensionInputPresentations.delete(agentId);
		} else {
			this._pendingExtensionInputPresentations.set(agentId, remaining);
		}
	}

	/**
	 * Two facts arrive through this one event: a persisted user message pairs with
	 * the presentation waiting for it, and the presentation entry written in
	 * response comes back with the id its own event needs. Nothing depends on
	 * `appendCustomEntry`'s return value, which is undefined whenever the write
	 * was buffered behind a running turn.
	 */
	private async _observeSessionWrite(agentId: AgentId, entryId: string, write: PendingSessionWrite): Promise<void> {
		if (write.type === "message" && write.message.role === "user") {
			const pending = this._takePendingExtensionInputPresentation(agentId);
			if (pending) {
				await this._commitExtensionInputPresentation(agentId, entryId, pending);
			}
			return;
		}
		if (write.type !== "custom" || write.customType !== EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE) {
			return;
		}
		const data = write.data as ExtensionInputPresentationEntryData;
		await this._emit(
			{
				type: "extension_input_presented",
				presentationId: this._createPresentationId(),
				entryId,
				messageEntryId: data.messageEntryId,
				agentId,
				extensionId: data.extensionId,
				presentation: cloneExtensionInputPresentation(data.presentation),
				createdAt: now(),
			},
			{ observeExtensions: false },
		);
	}

	/**
	 * Persist how to render a message an extension sent in.
	 *
	 * **Session write.** `harness.appendCustomEntry`; the branch is where this
	 * belongs because it names its user message by entry id, so a client hydrating
	 * the session later renders it exactly as the live client did. It never
	 * becomes model context. The event is published from the write's own
	 * `session_write`, not here.
	 */
	private async _commitExtensionInputPresentation(
		agentId: AgentId,
		messageEntryId: string,
		pending: PendingExtensionInputPresentation,
	): Promise<void> {
		const liveAgent = this._live.get(agentId);
		if (!liveAgent) return;
		try {
			await liveAgent.harness.appendCustomEntry(EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE, {
				messageEntryId,
				extensionId: pending.extensionId,
				presentation: pending.presentation,
			} satisfies ExtensionInputPresentationEntryData);
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.extension_input_presentation_failed",
				`Failed to persist extension input presentation for agent ${agentId}: ${formatError(error)}`,
			);
		}
	}

	// -----------------------------------------------------------------------
	// Maintenance
	// -----------------------------------------------------------------------

	/**
	 * Compaction replaces the branch the cached measurement described, and the
	 * retained tail carries the pre-compaction usage, so re-measuring here would
	 * report the old number as current. Drop it; the next settled re-measures.
	 */
	async compactAgent(agentId: AgentId, customInstructions?: string): Promise<CompactResult> {
		const result = await this._runMaintenanceOperation(
			agentId,
			async (harness) => await harness.compact(customInstructions),
		);
		await this._context.invalidate(agentId);
		return result;
	}

	/** Run session tree navigation, invalidating the projection if the leaf moved. */
	async navigateAgentTree(
		agentId: AgentId,
		targetId: string,
		options?: {
			readonly summarize?: boolean;
			readonly customInstructions?: string;
			readonly replaceInstructions?: boolean;
			readonly label?: string;
		},
	): Promise<NavigateTreeResult> {
		const previousLeafId = await this.sessionManager.getAgentSessionLeafId(agentId);
		try {
			return await this._runMaintenanceOperation(
				agentId,
				async (harness) => await harness.navigateTree(targetId, options),
			);
		} finally {
			// A post-move observer can fail after the harness changed the leaf.
			// Comparing in `finally` still invalidates the old gauge on that path,
			// while cancellation and no-op navigation leave it intact.
			if ((await this.sessionManager.getAgentSessionLeafId(agentId)) !== previousLeafId) {
				await this._context.invalidate(agentId);
			}
		}
	}

	/**
	 * Run a harness operation that occupies the agent without driving a loop
	 * (compaction, tree navigation). Concurrency is refused by the harness itself,
	 * so there is no orchestrator-side maintenance table; what is left is
	 * publishing the activity edges and stamping the released idle.
	 *
	 * **Start the operation first, then await the edge publication.** Both flip
	 * the phase on their first synchronous line, so publishing first would leave a
	 * window where the event says maintenance and the phase still says idle - and
	 * a steer landing there would pass the phase guard.
	 */
	private async _runMaintenanceOperation<T>(
		agentId: AgentId,
		operation: (harness: WidiAgentHarness) => Promise<T>,
	): Promise<T> {
		const harness = this._requireLiveAgent(agentId).harness;
		const running = operation(harness);
		// Read after the call: this is what tells an operation that started from one
		// the harness refused because it was already busy.
		const started = toMaintenanceKind(harness.getPhase()) !== undefined;
		try {
			await this._publishAgentActivityEdge(agentId, harness.getPhase());
		} catch (error) {
			running.catch(() => {});
			throw error;
		}
		try {
			return await running;
		} finally {
			if (started) {
				// No loop ran, so there is no new assistant message - but the
				// busy-to-idle edge happened, and a `waitForAgentIdle` caller needs it.
				this._agentIdleReasons.set(agentId, "maintenance");
				await this._publishAgentActivityEdge(agentId, harness.getPhase());
				this._messages.wake(agentId);
				await this._settleAgentIdle(agentId);
			}
		}
	}

	/**
	 * Failure is a warning, never a throw: an uncompactable over-threshold session
	 * keeps running until the provider rejects it, as it did before this trigger.
	 */
	private async _maybeAutoCompact(agentId: AgentId, contextTokens: number | undefined): Promise<void> {
		if (contextTokens === undefined) return;
		const settings = this.settingManager.getCompactionSettings();
		if (!settings.enabled) return;
		if (this._autoCompactingAgents.has(agentId)) return;
		const liveAgent = this._live.get(agentId);
		if (!liveAgent || liveAgent.harness.getPhase() !== "idle") return;
		const { contextWindow } = liveAgent.harness.getModel();
		if (!shouldCompact(contextTokens, contextWindow, settings)) return;
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

	// -----------------------------------------------------------------------
	// Extension runner lifecycle
	// -----------------------------------------------------------------------

	/** Register an in-process extension module with the loader. */
	registerExtension(extensionId: string, module: ExtensionModule): () => void {
		return this.extensionLoader.registerExtension(extensionId, module);
	}

	/**
	 * Per-agent because one extension can succeed for one agent and fail for
	 * another - the profile decides the enabled set. A reload resets the whole
	 * group rather than carrying the previous generation's failures forward.
	 */
	listExtensionStatuses(agentId: AgentId): readonly ExtensionStatusSnapshot[] {
		return this._extensionStatuses.list(agentId);
	}

	/** Refresh the catalog, then transactionally replace every selected agent's runner. */
	async reloadExtensions(options: { readonly agentIds?: readonly AgentId[] } = {}): Promise<ExtensionReloadResult> {
		const catalog = await this.extensionLoader.reloadAvailableExtensions(this.executionEnv);
		await this._publishDiagnostics(catalog.diagnostics);
		const agentIds = options.agentIds ? [...new Set(options.agentIds)] : [...this._live.keys()];
		const agents: ExtensionReloadAgentResult[] = [];
		for (const agentId of agentIds) {
			agents.push(await this._reloadLiveAgentExtensions(agentId));
		}
		return { catalog: { loaded: [...catalog.loaded], diagnostics: [...catalog.diagnostics] }, agents };
	}

	/**
	 * Build a candidate runner, re-resolve tools under the agent's current policy,
	 * then swap runner, bindings and policy in one step.
	 *
	 * A failure before installation leaves the original runner untouched; a failed
	 * harness write rolls all three fields back together. There is no state in
	 * which the harness holds the new tools while the agent points at the old
	 * runner. Any non-idle phase is skipped: replacing the runner underneath a
	 * running operation would swap the interceptors it is midway through.
	 */
	private async _reloadLiveAgentExtensions(agentId: AgentId): Promise<ExtensionReloadAgentResult> {
		const lookup = this._resolveAgent(agentId);
		if (lookup.kind !== "live") {
			const reason = lookup.kind === "creating" ? "creating" : "gone";
			const diagnostic: OrchestratorDiagnostic = {
				severity: "warning",
				code: "extension.reload_agent_skipped",
				message: `Skipped extension reload for agent ${agentId}: it is ${reason}.`,
				agentId,
			};
			await this._publishDiagnostic(diagnostic);
			return { agentId, status: "skipped", reason, diagnostics: [diagnostic] };
		}

		const { liveAgent } = lookup;
		const phase = liveAgent.harness.getPhase();
		if (phase !== "idle") {
			const diagnostic: OrchestratorDiagnostic = {
				severity: "warning",
				code: "extension.reload_agent_skipped",
				message: `Skipped extension reload for agent ${agentId}: it is in ${phase}.`,
				agentId,
			};
			this._addAgentDiagnostics(agentId, [diagnostic]);
			await this._publishDiagnostic(diagnostic);
			return { agentId, status: "skipped", reason: "running", diagnostics: [diagnostic] };
		}

		const previousRunner = liveAgent.extensionRunner;
		const previousBindings = liveAgent.extensionBindings;
		const previousPolicy = liveAgent.toolPolicy;
		let candidate: ExtensionRunner | undefined;
		let candidateBindings: ExtensionRunnerBindings | undefined;
		let installed = false;
		try {
			const profileId = liveAgent.profile.reference.id;
			candidate = await this._createExtensionRunner(agentId, profileId);
			const resolvedTools = await this._resolveAgentToolsForBuild(agentId, previousPolicy, candidate);
			candidateBindings = await this._bindExtensionRunner(agentId, liveAgent.generation, liveAgent.harness, candidate);
			// Before the awaited harness write: a turn starting mid-reload reads
			// `extensionRunner` for its tool context and must capture the new runner
			// rather than pin the one about to be disposed below.
			liveAgent.extensionRunner = candidate;
			liveAgent.extensionBindings = candidateBindings;
			liveAgent.toolPolicy = resolvedTools.policy;
			installed = true;
			try {
				await liveAgent.harness.setTools(resolvedTools.tools, [...resolvedTools.activeToolNames]);
			} catch (error) {
				liveAgent.extensionRunner = previousRunner;
				liveAgent.extensionBindings = previousBindings;
				liveAgent.toolPolicy = previousPolicy;
				installed = false;
				throw error;
			}

			// Provider registrations follow the runner: the stale runner's leases are
			// withdrawn before the replacement re-registers its own.
			await this._withdrawExtensionProviderContributions(agentId);
			await this._applyExtensionProviderContributions(agentId, candidate);
			await this._disposeExtensionRunner(
				agentId,
				previousRunner,
				previousBindings,
				"Extension runtime has been reloaded.",
			);
			// Before the new runner's diagnostics are published: those events reach
			// its observers, and a status one of them sets must survive this cleanup.
			await this._clearExtensionStatusesForAgent(agentId);
			this._addAgentDiagnostics(agentId, candidate.diagnostics);
			await this._publishDiagnostics(candidate.diagnostics);
			return { agentId, status: "reloaded", diagnostics: [...candidate.diagnostics] };
		} catch (error) {
			if (candidate && !installed) {
				await this._disposeExtensionRunner(
					agentId,
					candidate,
					candidateBindings,
					"Extension reload failed before installation.",
				);
			}
			const diagnostic: OrchestratorDiagnostic = {
				severity: "error",
				code: "extension.reload_agent_failed",
				message: `Failed to reload extensions for agent ${agentId}: ${formatError(error)}`,
				agentId,
			};
			this._addAgentDiagnostics(agentId, [diagnostic]);
			await this._publishDiagnostic(diagnostic);
			return { agentId, status: "failed", diagnostics: [diagnostic] };
		}
	}

	/**
	 * Activate the factories this agent's profile and settings select. Nothing is
	 * bound yet, so the candidate is invisible until installation.
	 */
	private async _createExtensionRunner(agentId: AgentId, profileId: string): Promise<ExtensionRunner> {
		const enabledExtensionIds = this.settingManager.getEnabledExtensions();
		const loadedScope = await this.extensionLoader.loadForAgent({
			agentId,
			profileId,
			extensionIds: enabledExtensionIds ?? this.extensionLoader.listAvailableExtensionIds(),
			missingExtensionSeverity: enabledExtensionIds ? "warning" : "ignore",
			divisionSelections: { settings: this.settingManager.getExtensionDivisionSelections() },
		});
		return new ExtensionRunner({ loadedScope });
	}

	/**
	 * Bind a runner to core and return a generation-scoped release handle. The
	 * harness interceptors are registered here because they are the part of a
	 * binding that must be revoked by hand: `shutdown()` clears the subscriber
	 * table itself, but a reload replaces the generation without one.
	 */
	private async _bindExtensionRunner(
		agentId: AgentId,
		generation: number,
		harness: WidiAgentHarness,
		runner: ExtensionRunner,
	): Promise<ExtensionRunnerBindings> {
		runner.bindCore(this._extensionCoreActions, this._createExtensionContextActions(agentId, generation));
		const releaseInterceptors = this._registerExtensionHarnessInterceptors(agentId, harness, runner);
		return {
			release: async () => {
				releaseInterceptors();
			},
		};
	}

	/**
	 * Generation-scoped rather than shared: the run signal and the idle judgement
	 * are only meaningful for the generation that installed them, and a stale
	 * runner reaching a successor's session would be a cross-generation write.
	 */
	private _createExtensionContextActions(agentId: AgentId, generation: number): ExtensionContextActions {
		const requireGeneration = (): LiveAgent => {
			const liveAgent = this._requireLiveAgent(agentId);
			if (liveAgent.generation !== generation) {
				throw new OrchestratorError({
					severity: "error",
					code: "extension.stale_generation",
					message: `Agent ${agentId} has been replaced since this extension runtime was bound.`,
					agentId,
				});
			}
			return liveAgent;
		};
		return {
			getSignal: () => this._agentRunSignals.get(agentId),
			isIdle: () => this._resolveAgentIdleState(agentId).kind === "idle",
			reportActionFailure: async (failure) => {
				await this._recordAndPublishExtensionDiagnostics(agentId, [
					{
						code: failure.code,
						severity: "warning",
						message: `Extension '${failure.extensionId}' action '${failure.action}' failed: ${formatError(failure.error)}`,
						agentId,
						extensionId: failure.extensionId,
					},
				]);
			},
			session: {
				// **Session write.** An extension's own entries go onto the branch
				// through the harness: they are its durable state for this conversation
				// and `findEntries` reads them back after a resume. The persisted type
				// is namespaced by extension id, so one cannot reach another's.
				appendEntry: async (extensionId, type, data) =>
					await requireGeneration().harness.appendCustomEntry(toExtensionCustomType(extensionId, type), data),
				findEntries: async (extensionId, type) =>
					await this.sessionManager.findExtensionCustomEntries(agentId, extensionId, type),
				// No extra gate: the extension already runs inside this session.
				getSnapshot: async () =>
					toExtensionSessionSnapshot(await this.sessionManager.getAgentSessionSnapshot(agentId), this.sessionManager),
				getTree: async () =>
					toExtensionSessionTree(await this.sessionManager.getAgentSessionTree(agentId), this.sessionManager),
				getLeafId: async () => await this.sessionManager.getAgentSessionLeafId(agentId),
				// The cross-session readers widen what an extension sees to every
				// conversation in this project, so they carry the same bar as exec.
				listSessions: async (extensionId) => {
					this._requireProjectTrustForExtension(agentId, extensionId, "list the project's sessions");
					const candidates = await this.sessionManager.listAgentSessionCandidates();
					return candidates.map((candidate) => ({
						ref: this.sessionManager.toSessionHandle(candidate.path),
						id: candidate.id,
						createdAt: candidate.createdAt,
						...(candidate.profile === undefined ? undefined : { profile: { ...candidate.profile } }),
						...(candidate.name === undefined ? undefined : { name: candidate.name }),
						...(candidate.firstUserMessage === undefined
							? undefined
							: { firstUserMessage: candidate.firstUserMessage }),
						...(candidate.parentSessionPath === undefined
							? undefined
							: { parentRef: this.sessionManager.toSessionHandle(candidate.parentSessionPath) }),
					}));
				},
				readSession: async (extensionId, ref) => {
					this._requireProjectTrustForExtension(agentId, extensionId, "read another session");
					return toExtensionSessionTree(
						await this.sessionManager.readSessionSnapshot(this.sessionManager.resolveSessionHandle(ref)),
						this.sessionManager,
					);
				},
			},
		};
	}

	/**
	 * Register the five transformable harness hooks. The returned handle revokes
	 * exactly this generation's handlers, which is what makes a reload a
	 * replacement rather than an accumulation.
	 */
	private _registerExtensionHarnessInterceptors(
		agentId: AgentId,
		harness: WidiAgentHarness,
		runner: ExtensionRunner,
	): () => void {
		const unsubscribes = [
			harness.on(
				"before_agent_start",
				async (event) => await this._runExtensionInterceptor<"before_agent_start">(agentId, runner, event),
			),
			harness.on(
				"before_provider_request",
				async (event) => await this._runExtensionInterceptor<"before_provider_request">(agentId, runner, event),
			),
			// blockImages applies inside this one handler: the harness keeps only the
			// last non-undefined hook result, so a separately registered filter could
			// be overridden by an extension transform.
			harness.on("context", async (event) => {
				const result = await this._runExtensionInterceptor<"context">(agentId, runner, event);
				const blockImages =
					this._live.get(agentId)?.settings.blockImages ?? this.settingManager.getImageSettings().blockImages;
				if (!blockImages) return result;
				return { messages: stripImagesFromMessages(result?.messages ?? event.messages) };
			}),
			harness.on(
				"tool_call",
				async (event) => await this._runExtensionInterceptor<"tool_call">(agentId, runner, event),
			),
			harness.on(
				"tool_result",
				async (event) => await this._runExtensionInterceptor<"tool_result">(agentId, runner, event),
			),
		];
		return () => {
			for (const unsubscribe of unsubscribes) unsubscribe();
		};
	}

	/** Run one runner interceptor, recording its handler diagnostics. */
	private async _runExtensionInterceptor<TName extends ExtensionInterceptorName>(
		agentId: AgentId,
		runner: ExtensionRunner,
		event: ExtensionInterceptorEventFor<TName>,
	): Promise<ExtensionInterceptorResultFor<TName>> {
		const run = await runner.interceptWithDiagnostics(event);
		await this._recordAndPublishExtensionDiagnostics(agentId, run.diagnostics);
		return run.result;
	}

	/**
	 * Input is not a harness hook: it sits in front of the harness, at
	 * `sendMessage`, so no delivery path can bypass an input policy.
	 */
	private async _interceptExtensionInput(
		agentId: AgentId,
		source: MessageSource,
		event: MessageInterceptEvent,
	): Promise<MessageInterceptRun> {
		const runner = this._live.get(agentId)?.extensionRunner;
		if (!runner || runner.isStale()) return { kind: "pass" };
		const run = await runner.interceptInput(event);
		await this._recordAndPublishExtensionDiagnostics(agentId, run.diagnostics);
		// A block this source does not enforce is still worth recording.
		if (run.kind === "block" && source.kind === "background_job") {
			await this._publishDiagnostic({
				severity: "warning",
				code: "orchestrator.message_block_ignored",
				message: `Extension '${run.blockedBy}' blocked a background job result for agent ${agentId}; it was delivered anyway because the model is waiting for that result.`,
				agentId,
			});
		}
		return run;
	}

	/**
	 * Trust ruling: a `!command` config value resolves through `ExecutionEnv.exec`
	 * at request time, so an untrusted project rejects the whole registration.
	 */
	private async _applyExtensionProviderContributions(agentId: AgentId, runner: ExtensionRunner): Promise<void> {
		const contributions = runner.getProviderContributions();
		if (contributions.length === 0) return;
		const diagnostics: OrchestratorDiagnostic[] = [];
		const projectTrusted = this.settingManager.isProjectTrusted();
		for (const contribution of contributions) {
			const attribution = { agentId, extensionId: contribution.extensionId } as const;
			if (!projectTrusted && hasCommandConfigValues(contribution.config, this.modelRegistry.configValueResolver)) {
				diagnostics.push({
					...attribution,
					severity: "error",
					code: "extension.provider_trust_denied",
					message: `Extension '${contribution.extensionId}' provider '${contribution.providerName}' uses command config values and was denied because the project is not trusted.`,
				});
				continue;
			}
			const result = this.modelRegistry.registerExtensionProvider(contribution.providerName, contribution.config, {
				extensionId: contribution.extensionId,
				agentId,
			});
			if (result.ok) continue;
			diagnostics.push(
				result.reason === "conflict"
					? {
							...attribution,
							severity: "warning",
							code: "extension.provider_conflict",
							message: `Extension '${contribution.extensionId}' provider '${contribution.providerName}' conflicts with a ${result.conflictWith} provider and was skipped.`,
						}
					: {
							...attribution,
							severity: "error",
							code: "extension.provider_invalid",
							message: `Extension '${contribution.extensionId}' provider '${contribution.providerName}' was rejected: ${result.message}`,
						},
			);
		}
		if (diagnostics.length === 0) return;
		this._addAgentDiagnostics(agentId, diagnostics);
		await this._publishDiagnostics(diagnostics);
	}

	/** Withdraw this agent's provider leases, leaving every other agent's alone. */
	private async _withdrawExtensionProviderContributions(agentId: AgentId): Promise<void> {
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

	/** Make the contexts stale, revoke bindings, run every `onDispose` handler. */
	private async _disposeExtensionRunner(
		agentId: AgentId,
		runner: ExtensionRunner | undefined,
		bindings: ExtensionRunnerBindings | undefined,
		reason: string,
	): Promise<void> {
		// Bindings first: a released interceptor cannot fire into an onDispose
		// handler that has already run.
		try {
			await bindings?.release();
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.agent_dispose_failed",
				`Failed to release extension bindings for agent ${agentId}: ${formatError(error)}`,
			);
		}
		if (!runner) return;
		try {
			await runner.dispose(reason);
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				agentId,
				"orchestrator.agent_dispose_failed",
				`Failed to dispose extension runtime for agent ${agentId}: ${formatError(error)}`,
			);
		}
	}

	/** Drop every status this agent's runner published, announcing each removal. */
	private async _clearExtensionStatusesForAgent(agentId: AgentId): Promise<void> {
		for (const snapshot of this._extensionStatuses.clearAgent(agentId)) {
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

	private async _recordAndPublishExtensionDiagnostics(
		agentId: AgentId,
		diagnostics: readonly OrchestratorDiagnostic[],
	): Promise<void> {
		if (diagnostics.length === 0) return;
		this._addAgentDiagnostics(agentId, diagnostics);
		await this._publishDiagnostics(diagnostics, {
			// Still recorded and published to core consumers, but a diagnostic raised
			// inside an observer must not feed back into observers and recurse.
			observeExtensions: (this._extensionObserverDispatchDepth.get(agentId) ?? 0) === 0,
		});
	}

	/**
	 * Trust gate for extension actions that reach beyond the agent's own session.
	 * `action` completes "... is denied because the project is not trusted".
	 */
	private _requireProjectTrustForExtension(agentId: AgentId, extensionId: string, action: string): void {
		if (this.settingManager.isProjectTrusted()) return;
		throw new OrchestratorError({
			severity: "error",
			code: "extension.session_read_denied",
			message: `Extension '${extensionId}' may not ${action} because the project is not trusted.`,
			agentId,
			extensionId,
		});
	}

	// -----------------------------------------------------------------------
	// Extension event fan-out
	// -----------------------------------------------------------------------

	/**
	 * Relay one named extension event to every live runner's subscribers.
	 * Runtime-level by construction: the runners are the subscriber set, so a
	 * reload swaps subscriptions with the runner it replaced and disposal drops
	 * them, with no second lifecycle to keep in step.
	 */
	private async _emitExtensionEvent(envelope: ExtensionEventEnvelope): Promise<void> {
		const immutable = freezeExtensionEventEnvelope(envelope);
		const depth = this._extensionEventDispatchContext.getStore() ?? 0;
		if (depth >= MAX_EXTENSION_EVENT_DISPATCH_DEPTH) {
			await this._publishDiagnostic(
				{
					severity: "warning",
					code: "extension.event_recursion_dropped",
					message: `Extension event '${immutable.name}' from '${immutable.sourceExtensionId}' was dropped after ${MAX_EXTENSION_EVENT_DISPATCH_DEPTH} nested dispatches.`,
					agentId: immutable.sourceAgentId,
					extensionId: immutable.sourceExtensionId,
				},
				{ observeExtensions: false },
			);
			return;
		}
		await this._extensionEventDispatchContext.run(depth + 1, async () => {
			for (const [agentId, liveAgent] of [...this._live]) {
				const runner = liveAgent.extensionRunner;
				if (runner.isStale()) continue;
				await this._recordAndPublishExtensionDiagnostics(agentId, await runner.emitExtensionEvent(immutable));
			}
		});
	}

	/**
	 * A runtime-scoped fact - today only `runtime_shutdown_requested` - goes to
	 * every live runner: the agents that must wind down are not only the one whose
	 * extension asked.
	 */
	private async _dispatchExtensionObservedEvent(event: ExtensionObservedEvent): Promise<void> {
		const agentId =
			event.type === "diagnostic"
				? event.diagnostic.agentId
				: event.type === "runtime_shutdown_requested"
					? undefined
					: event.agentId;
		if (agentId !== undefined) {
			await this._dispatchExtensionObservedEventForAgent(agentId, event);
			return;
		}
		if (event.type !== "runtime_shutdown_requested") return;
		for (const observedAgentId of [...this._live.keys()]) {
			await this._dispatchExtensionObservedEventForAgent(observedAgentId, event);
		}
	}

	private async _dispatchExtensionObservedEventForAgent(
		agentId: AgentId,
		event: ExtensionObservedEvent,
	): Promise<void> {
		const runner = this._live.get(agentId)?.extensionRunner;
		if (!runner || runner.isStale()) return;
		this._extensionObserverDispatchDepth.set(agentId, (this._extensionObserverDispatchDepth.get(agentId) ?? 0) + 1);
		try {
			await this._recordAndPublishExtensionDiagnostics(agentId, await runner.emitObserved(event));
		} finally {
			// Dispatches interleave, so decrement rather than restore a snapshot.
			const depth = this._extensionObserverDispatchDepth.get(agentId) ?? 1;
			if (depth <= 1) this._extensionObserverDispatchDepth.delete(agentId);
			else this._extensionObserverDispatchDepth.set(agentId, depth - 1);
		}
	}

	/**
	 * Map the runner authors' actions onto host and runtime services. One shared
	 * table: the runner injects its own agentId and extensionId.
	 */
	private _createExtensionCoreActions(): ExtensionCoreActions {
		return {
			getAgentTools: (agentId) => this.getAgentTools(agentId),
			setAgentTools: async (agentId, toolNames, activeToolNames) => {
				await this.setAgentTools(agentId, toolNames, activeToolNames);
			},
			setAgentActiveTools: async (agentId, toolNames) => {
				await this.setAgentActiveTools(agentId, toolNames);
			},
			listAgentBackgroundJobs: (agentId) => this.listAgentBackgroundJobs(agentId),
			readAgentBackgroundJobOutput: (agentId, jobId) => this.readAgentBackgroundJobOutput(agentId, jobId),
			abortAgentBackgroundJob: (agentId, jobId, reason) => this.abortAgentBackgroundJob(agentId, jobId, reason),
			requestHuman: async (agentId, extensionId, request) =>
				await this._requestHumanForAgent(agentId, { ...request, source: { kind: "extension", extensionId } }),
			emitOutput: async (agentId, extensionId, text) => {
				this._requireLiveAgent(agentId);
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
				this._requireLiveAgent(agentId);
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
				this._requireLiveAgent(agentId);
				assertExtensionStatusKey(key);
				const changedAt = now();
				const snapshot = this._extensionStatuses.set(
					agentId,
					extensionId,
					key,
					validateExtensionStatus(status),
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
				this._requireLiveAgent(agentId);
				assertExtensionStatusKey(key);
				if (!this._extensionStatuses.clear(agentId, extensionId, key)) return;
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
				this._requireLiveAgent(agentId);
				const validated = validateExtensionDiagnosticDraft(draft);
				const diagnostic: OrchestratorDiagnostic = {
					code: `extension.${extensionId}.${validated.code}`,
					severity: validated.severity,
					message: validated.message,
					agentId,
					extensionId,
				};
				this._addAgentDiagnostics(agentId, [diagnostic]);
				// Extension-published facts never feed back into extension observers.
				await this._publishDiagnostic(diagnostic, { observeExtensions: false });
			},
			/**
			 * **Session write.** A published message is durable presentation content
			 * belonging to the conversation it was published into, so it goes onto the
			 * branch through `harness.appendCustomEntry`. It never becomes model
			 * context. The id returned here is only the fast path for a write that
			 * landed immediately; the event is emitted from the `session_write`.
			 */
			publishMessage: async (agentId, extensionId, message) => {
				const liveAgent = this._requireLiveAgent(agentId);
				const entryId = await liveAgent.harness.appendCustomEntry(
					EXTENSION_MESSAGE_CUSTOM_TYPE,
					Object.freeze({
						extensionId,
						message: validateExtensionMessage(message),
					}) satisfies ExtensionMessageEntryData,
				);
				return entryId === undefined ? {} : { entryId };
			},
			// The presentation rides the message pipeline, where a block returns before
			// any session write: none is recorded for a message an interceptor refused.
			promptAgent: async (agentId, extensionId, text, options) => {
				await this.promptAgent(agentId, text, {
					...(options?.images === undefined ? undefined : { images: options.images }),
					...(options?.presentation === undefined
						? undefined
						: { presentation: { extensionId, presentation: options.presentation } }),
				});
			},
			steerAgent: async (agentId, extensionId, text, options) => {
				await this._withExtensionInputPresentation(agentId, extensionId, "steer", options?.presentation, async () => {
					await this.steerAgent(agentId, text, {
						...(options?.images === undefined ? undefined : { images: options.images }),
					});
				});
			},
			followUpAgent: async (agentId, extensionId, text, options) => {
				await this._withExtensionInputPresentation(
					agentId,
					extensionId,
					"follow_up",
					options?.presentation,
					async () => {
						await this.followUpAgent(agentId, text, {
							...(options?.images === undefined ? undefined : { images: options.images }),
						});
					},
				);
			},
			getAgentContextUsage: (agentId) => this._context.get(agentId),
			isProjectTrusted: () => this.settingManager.isProjectTrusted(),
			getAgentSystemPrompt: async (agentId) => await this.getAgentSystemPrompt(agentId),
			agentHasPendingMessages: (agentId) => this.agentHasPendingMessages(agentId),
			waitForAgentIdle: async (agentId, options) => {
				await this.waitForAgentIdle(agentId, options);
			},
			emitExtensionEvent: async (agentId, extensionId, name, payload) => {
				this._requireLiveAgent(agentId);
				await this._emitExtensionEvent({
					name: validateExtensionEventName(name),
					payload: validateExtensionEventPayload(payload),
					sourceExtensionId: extensionId,
					sourceAgentId: agentId,
					emittedAt: now(),
				});
			},
			requestRuntimeShutdown: async (agentId, extensionId, reason) => {
				this._requireLiveAgent(agentId);
				await this.requestShutdown({
					requestedBy: extensionId,
					requestedByAgentId: agentId,
					...(reason === undefined ? undefined : { reason }),
				});
			},
			disposeRuntime: async (agentId, extensionId, reason) => {
				this._requireLiveAgent(agentId);
				await this.disposeAll(reason ?? `Extension '${extensionId}' disposed the runtime from agent ${agentId}.`);
			},
			setAgentSessionName: async (agentId, name) => {
				await this.setAgentSessionName(agentId, name);
			},
			getAgentSessionName: async (agentId) => await this.getAgentSessionName(agentId),
			compactAgent: async (agentId, customInstructions) => await this.compactAgent(agentId, customInstructions),
			setAgentModelByReference: async (agentId, reference) => await this.setAgentModelByReference(agentId, reference),
			getAgentModel: (agentId) => this.getAgentModel(agentId),
			listModelCandidates: async () => (await this.listAvailableModelCandidates()).models,
			getAgentThinkingLevel: (agentId) => this.getAgentThinkingLevel(agentId),
			setAgentThinkingLevel: async (agentId, level) => {
				await this.setAgentThinkingLevel(agentId, level);
			},
			abortAgent: async (agentId) => {
				await this.abortAgent(agentId);
			},
			// Trust ruling: exec runs arbitrary commands in the project cwd.
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

	// -----------------------------------------------------------------------
	// Spawn tree persistence
	//
	// The runtime holds the tree in `_spawnParent`; these methods are its durable
	// mirror. `SessionManager` owns only the IO primitives - append, replay, read
	// a session by directory - while reduction, ordering and id remapping are
	// multi-agent judgements and stay here.
	// -----------------------------------------------------------------------

	/**
	 * Both halves must be persistable: a child with no session directory has
	 * nothing to record, a root with none has nowhere to record it. Resolved
	 * during the build so an unpersistable tree is known before install.
	 */
	private async _createTreeSpawnRecord(request: AgentBuildRequest): Promise<AgentTreeSpawnRecord | undefined> {
		const { parent } = request;
		if (parent === undefined) return undefined;
		const sessionDir = await this.sessionManager.getAgentSessionDirName(request.agentId);
		if (!sessionDir) return undefined;
		return {
			v: 1,
			type: "spawned",
			agentId: request.agentId,
			sessionDir,
			profileId: request.resolvedProfile.profile.id,
			spawnedBy: parent,
			at: now(),
		};
	}

	/**
	 * Append `spawned` to the root's `agents/tree.jsonl` and write the child's
	 * `agents/parent.json`.
	 *
	 * The back-pointer is not optional: the tree index is one-way, but the session
	 * picker lists child sessions too, so without it opening a child directly
	 * yields an orphan and resuming its root afterwards opens the same session
	 * twice.
	 *
	 * A write failure is a diagnostic and never rolls the install back - an agent
	 * that works but cannot be restored beats an agent that does not exist.
	 */
	private async _recordAgentSpawnedInTree(build: LiveAgentBuild): Promise<void> {
		const record = build.treeRecord;
		if (!record) return;
		const rootAgentId = this._resolveAgentTreeRoot(record.agentId);
		const rootSessionDir = await this.sessionManager.getAgentSessionDirName(rootAgentId);
		if (!rootSessionDir) {
			await this._publishDiagnostic({
				severity: "warning",
				code: "orchestrator.agent_tree_not_persistable",
				message: `Agent ${record.agentId} was spawned under ephemeral root ${rootAgentId}; this spawn tree will not be restored.`,
				agentId: record.agentId,
			});
			return;
		}
		await this._enqueueTreeWrite(rootAgentId, async () => {
			await this.sessionManager.appendAgentTreeRecord(rootAgentId, record);
			await this.sessionManager.writeAgentParentPointer(record.agentId, {
				v: 1,
				rootSessionDir,
				parentAgentId: record.spawnedBy,
				agentId: record.agentId,
			});
		});
	}

	/** Append `removed` only when the agent is meant not to come back. */
	private async _recordAgentRemovedFromTree(agentId: AgentId, intent: AgentDisposeIntent): Promise<void> {
		if (intent !== "removed") return;
		if (this._spawnParent.get(agentId) === undefined) return;
		const rootAgentId = this._resolveAgentTreeRoot(agentId);
		if (rootAgentId === agentId) return;
		await this._enqueueTreeWrite(rootAgentId, async () => {
			await this.sessionManager.appendAgentTreeRecord(rootAgentId, { v: 1, type: "removed", agentId, at: now() });
		});
	}

	/**
	 * Serialize writes per root file so records keep event order, and report a
	 * failure without letting it reach the lifecycle operation that triggered it.
	 */
	private async _enqueueTreeWrite(rootAgentId: AgentId, write: () => Promise<void>): Promise<void> {
		const tail = (this._treeWrites.get(rootAgentId) ?? Promise.resolve()).then(async () => {
			try {
				await write();
			} catch (error) {
				await this._publishDiagnostic({
					severity: "warning",
					code: "orchestrator.agent_tree_write_failed",
					message: `Failed to record a spawn-tree change under root ${rootAgentId}: ${formatError(error)}`,
					agentId: rootAgentId,
				});
			}
		});
		this._treeWrites.set(rootAgentId, tail);
		await tail;
		if (this._treeWrites.get(rootAgentId) === tail) {
			this._treeWrites.delete(rootAgentId);
		}
	}

	private async _planAgentTreeResume(rootSessionDir: string): Promise<readonly AgentTreeSpawnRecord[]> {
		return reduceAgentTreeRecords(await this.sessionManager.readAgentTreeRecords(rootSessionDir));
	}

	/**
	 * Bring a resumed root's recorded children back, then tell the root what it
	 * got. A failure to read the log is a diagnostic, never a failure of the
	 * resume that triggered it - the root is already live and usable.
	 */
	private async _restoreSpawnTree(rootAgentId: AgentId): Promise<void> {
		let members: readonly AgentTreeSpawnRecord[];
		try {
			const rootSessionDir = await this.sessionManager.getAgentSessionDirName(rootAgentId);
			if (!rootSessionDir) return;
			members = await this._planAgentTreeResume(rootSessionDir);
		} catch (error) {
			await this._publishDiagnostic({
				severity: "warning",
				code: "orchestrator.agent_tree_read_failed",
				message: `Failed to read the spawn tree of agent ${rootAgentId}; it was resumed alone: ${formatError(error)}`,
				agentId: rootAgentId,
			});
			return;
		}
		if (members.length === 0) return;
		await this._publishTreeResumeReconciliation(await this._resumeAgentTree(rootAgentId, members));
	}

	/**
	 * Resume the root of a directly named session that turns out to be somebody's
	 * child. Returns the AgentId now holding that session, which is not
	 * necessarily the recorded one because a restore remaps a colliding id;
	 * undefined means the caller resumes it as a top-level agent as before.
	 */
	private async _redirectChildResumeToRoot(reference: string | JsonlSessionMetadata): Promise<AgentId | undefined> {
		const metadata =
			typeof reference === "string" ? await this.sessionManager.resolveAgentSessionReference(reference) : reference;
		const sessionDir = sessionDirNameFromPath(metadata.path);
		const pointer = await this._resolveResumeRoot(sessionDir);
		if (!pointer || pointer.rootSessionDir === sessionDir) return undefined;
		try {
			const rootMetadata = await this.sessionManager.resolveAgentSessionByDir(pointer.rootSessionDir);
			await this.spawnAgent({ origin: { kind: "resume", reference: rootMetadata } });
		} catch (error) {
			await this._publishDiagnostic({
				severity: "warning",
				code: "orchestrator.agent_tree_root_unresolved",
				message: `Session ${sessionDir} records a spawn-tree root that could not be opened; resuming it as a top-level agent: ${formatError(error)}`,
			});
			return undefined;
		}
		// The restore opened this session under whatever id was free. If it did not
		// - a member the log no longer lists, or one that failed - fall back.
		return this.sessionManager.findAgentIdBySessionDir(sessionDir);
	}

	/**
	 * Restore a tree eagerly, in the order the log recorded it, so a parent always
	 * exists before its child.
	 *
	 * A recorded AgentId can collide across processes; the member is then resumed
	 * under a fresh id and the substitution recorded, because not remapping would
	 * leave the parent's history naming `coder-2` while `send_message("coder-2")`
	 * reaches somebody else. One member failing never takes the root or its
	 * siblings down with it.
	 */
	private async _resumeAgentTree(
		rootAgentId: AgentId,
		members: readonly AgentTreeSpawnRecord[],
	): Promise<AgentTreeResumeOutcome> {
		const resumed: AgentId[] = [];
		const failed: AgentId[] = [];
		const remapped: Array<{ readonly from: AgentId; readonly to: AgentId }> = [];
		// A record names its parent by the recorded id, which may itself have just
		// been remapped.
		const substitutions = new Map<AgentId, AgentId>();
		for (const member of members) {
			const parent =
				substitutions.get(member.spawnedBy) ?? (this._live.has(member.spawnedBy) ? member.spawnedBy : rootAgentId);
			try {
				const metadata = await this.sessionManager.resolveAgentSessionByDir(member.sessionDir);
				const agentId = await this.spawnAgent({ origin: { kind: "resume", reference: metadata }, parent });
				if (agentId !== member.agentId) {
					substitutions.set(member.agentId, agentId);
					remapped.push({ from: member.agentId, to: agentId });
				}
				resumed.push(agentId);
			} catch (error) {
				failed.push(member.agentId);
				await this._publishDiagnostic({
					severity: "warning",
					code: "orchestrator.agent_tree_member_failed",
					message: `Failed to restore agent ${member.agentId} under root ${rootAgentId}: ${formatError(error)}`,
					agentId: rootAgentId,
				});
			}
		}
		return { rootAgentId, resumed, failed, remapped };
	}

	/**
	 * **Session write.** The reconciliation goes onto the root's branch through
	 * `harness.appendMessage`, because it is context the model must resume with:
	 * a model that is not told keeps addressing agents that no longer exist or
	 * whose ids moved. Nothing is written when the tree came back whole.
	 */
	private async _publishTreeResumeReconciliation(outcome: AgentTreeResumeOutcome): Promise<void> {
		if (outcome.failed.length === 0 && outcome.remapped.length === 0) return;
		const liveAgent = this._live.get(outcome.rootAgentId);
		if (!liveAgent) return;
		const lines = ["[Spawn tree restored]"];
		if (outcome.resumed.length > 0) {
			lines.push(`Restored: ${outcome.resumed.join(", ")}.`);
		}
		if (outcome.failed.length > 0) {
			lines.push(`Not restored: ${outcome.failed.join(", ")}. Messages to them will fail.`);
		}
		for (const { from, to } of outcome.remapped) {
			lines.push(`Agent ${from} is now addressed as ${to}.`);
		}
		try {
			await liveAgent.harness.appendMessage({
				role: "user",
				content: [{ type: "text", text: lines.join("\n") }],
				timestamp: Date.now(),
			});
		} catch (error) {
			await this._recordAgentLifecycleFailure(
				outcome.rootAgentId,
				"orchestrator.agent_tree_reconciliation_failed",
				`Failed to record the spawn-tree reconciliation for agent ${outcome.rootAgentId}: ${formatError(error)}`,
			);
		}
	}

	/**
	 * Read a directly resumed child's `parent.json`. Not found - old data, or a
	 * deleted root - means it comes back as a top-level agent.
	 */
	private async _resolveResumeRoot(sessionDir: string): Promise<AgentParentPointer | undefined> {
		try {
			return await this.sessionManager.readAgentParentPointer(sessionDir);
		} catch (error) {
			await this._publishDiagnostic({
				severity: "warning",
				code: "orchestrator.agent_tree_root_unresolved",
				message: `Failed to read the spawn-tree parent pointer of session ${sessionDir}; resuming it as a top-level agent: ${formatError(error)}`,
			});
			return undefined;
		}
	}

	// -----------------------------------------------------------------------
	// Tool policy and system prompt
	//
	// The harness owns the installed and active tools, and every read below asks
	// it. What stays here is the declarative intent behind them - which tool names
	// were requested, and whether the active set was chosen or defaulted - because
	// an extension reload has to resolve that intent again against a replacement
	// runner, and the resolved result cannot answer that question.
	// -----------------------------------------------------------------------

	/** The harness's own answer, projected. There is no second copy to drift. */
	private _snapshotAgentTools(liveAgent: LiveAgent): AgentToolsSnapshot {
		const { harness } = liveAgent;
		return {
			toolNames: harness.getTools().map((tool) => tool.name),
			activeToolNames: harness.getActiveTools().map((tool) => tool.name),
		};
	}

	getAgentTools(agentId: AgentId): AgentToolsSnapshot {
		return this._snapshotAgentTools(this._requireLiveAgent(agentId));
	}

	/**
	 * The policy is updated only after the harness accepts the new tools, so a
	 * rejected write leaves the recorded intent describing what is installed.
	 */
	async setAgentTools(
		agentId: AgentId,
		toolNames: readonly string[],
		activeToolNames?: readonly string[],
	): Promise<void> {
		const liveAgent = this._requireLiveAgent(agentId);
		const resolved = await this._resolveAgentToolsForBuild(
			agentId,
			{
				requestedToolNames: [...toolNames],
				activeToolSelection:
					activeToolNames === undefined
						? { mode: "default_all" }
						: { mode: "explicit", toolNames: [...activeToolNames] },
			},
			liveAgent.extensionRunner,
		);
		await liveAgent.harness.setTools(resolved.tools, [...resolved.activeToolNames]);
		liveAgent.toolPolicy = resolved.policy;
	}

	/**
	 * Validation runs against the harness's live tool list with no await between
	 * check and apply. Re-resolving the registry here would race a concurrent
	 * `setTools` and re-publish the standing resolve diagnostics on every toggle.
	 */
	async setAgentActiveTools(agentId: AgentId, toolNames: readonly string[]): Promise<void> {
		const liveAgent = this._requireLiveAgent(agentId);
		const { harness } = liveAgent;
		const { activeToolNames, diagnostics } = selectActiveToolNames(
			toolNames,
			new Set(harness.getTools().map((tool) => tool.name)),
			agentId,
		);
		await harness.setActiveTools(activeToolNames);
		// Re-read after the await: the harness is the source of truth, and a
		// concurrent tool-set change must not be overwritten by a stale copy.
		liveAgent.toolPolicy = {
			...liveAgent.toolPolicy,
			activeToolSelection: { mode: "explicit", toolNames: harness.getActiveTools().map((tool) => tool.name) },
		};
		await this._publishDiagnostics(diagnostics);
	}

	/**
	 * The returned policy is the intent as the registry understood it, which makes
	 * a later reload idempotent: an explicit selection narrows to what resolved,
	 * while `default_all` stays open to tools a replacement runner contributes.
	 */
	private async _resolveAgentToolsForBuild(
		agentId: AgentId,
		policy: AgentToolPolicy,
		extensionRunner: ExtensionRunner,
	): Promise<{
		readonly tools: ResolvedAgentHarnessTool[];
		readonly activeToolNames: readonly string[];
		readonly policy: AgentToolPolicy;
	}> {
		const registry = this.toolRegistry.clone();
		extensionRunner.contributeToolsTo(registry);
		const resolved = registry.resolve({
			...(policy.requestedToolNames === undefined ? undefined : { requestedToolNames: policy.requestedToolNames }),
			...(policy.activeToolSelection.mode === "explicit"
				? { activeToolNames: policy.activeToolSelection.toolNames }
				: undefined),
		});
		await this._publishDiagnostics(resolved.diagnostics.map((diagnostic) => ({ ...diagnostic, agentId })));
		return {
			tools: createAgentHarnessToolsFromResolvedTools(resolved.tools),
			activeToolNames: resolved.activeToolNames,
			policy: {
				...(policy.requestedToolNames === undefined
					? undefined
					: { requestedToolNames: [...policy.requestedToolNames] }),
				activeToolSelection:
					policy.activeToolSelection.mode === "explicit"
						? { mode: "explicit", toolNames: [...resolved.activeToolNames] }
						: { mode: "default_all" },
			},
		};
	}

	/**
	 * The runner is read here rather than captured at construction, which is the
	 * whole reason this is a callback: a reload replaces the runner and the
	 * sections it appends have to follow.
	 */
	private _composeAgentSystemPrompt(agentId: AgentId, activeTools: readonly ToolPromptGuidance[]): string {
		const liveAgent = this._requireLiveAgent(agentId);
		const facts = liveAgent.systemPrompt;
		return buildAgentSystemPrompt({
			basePrompt: facts.basePrompt,
			skills: facts.skills,
			activeTools,
			agentId,
			appendSections: [...facts.appendSections, ...liveAgent.extensionRunner.getSystemPromptAppends()],
			contextFiles: facts.contextFiles,
			...(facts.includeSkills === undefined ? undefined : { includeSkills: facts.includeSkills }),
			...(facts.cwd === undefined ? undefined : { cwd: facts.cwd }),
		});
	}

	/**
	 * What the next turn would be built with. Read-only: `before_agent_start` can
	 * still replace this text for one turn without changing what this returns.
	 */
	async getAgentSystemPrompt(agentId: AgentId): Promise<string> {
		const { harness } = this._requireLiveAgent(agentId);
		return this._composeAgentSystemPrompt(agentId, harness.getActiveTools());
	}

	/**
	 * The runner is captured into this snapshot, so a call that continues in the
	 * background after a reload keeps the runner it started under and observes
	 * that runner's stale boundary instead of switching mid-call.
	 */
	private _createToolAdapterContext(agentId: AgentId, profileId: string): ToolAdapterContext {
		const liveAgent = this._requireLiveAgent(agentId);
		const extensionRunner = liveAgent.extensionRunner;
		return {
			human: {
				request: async (request) =>
					await this._requestHumanForAgent(agentId, { ...request, source: { kind: "agent", agentId } }),
			},
			agents: this._createToolAgentHost(agentId, liveAgent.backgroundAttachment),
			humanInterrupts: this._humanInterrupts.watch(agentId),
			createExtensionContext: (source) => {
				if (source.kind !== "extension") return undefined;
				return {
					extensionId: source.id,
					host: { agentId, profileId, actions: extensionRunner.createContext(source.id).actions },
				};
			},
		};
	}

	/**
	 * The caller's identity is captured here and never read from tool arguments,
	 * so no model-controlled value can forge the sender of a message, the owner of
	 * a job, or the settler of someone else's. Discovery and dispose scope resolve
	 * over private runtime state for the same reason.
	 */
	private _createToolAgentHost(agentId: AgentId, attachment: OwnerAttachment): ToolAgentHost {
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
							...(profile.description === undefined ? undefined : { description: profile.description }),
							...(profile.whenToUse === undefined ? undefined : { whenToUse: profile.whenToUse }),
							persist: profile.persist,
						}),
					);
			},
			// Discovery is tree-scoped, while exact ids stay runtime-wide addresses
			// through `describe` and `sendMessage` - the deliberate soft bridge
			// between otherwise isolated trees.
			listAgents: () => {
				const rootAgentId = this._resolveAgentTreeRoot(agentId);
				return [...this._live.values()]
					.filter((liveAgent) => this._resolveAgentTreeRoot(liveAgent.agentId) === rootAgentId)
					.map((liveAgent) => describeAgentForTools(liveAgent));
			},
			describe: (targetAgentId) => {
				const liveAgent = this._live.get(targetAgentId);
				return liveAgent ? describeAgentForTools(liveAgent) : undefined;
			},
			// The caller becomes the parent, so the child is rendered under it and
			// swept by its subtree dispose.
			spawn: async (profileId) => await this.spawnAgent({ origin: { kind: "new", profileId }, parent: agentId }),
			sendMessage: async (targetAgentId, body) =>
				await this.sendMessage({
					source: { kind: "agent", agentId },
					targetAgentId,
					body,
					// Never preempts a turn in flight: the target decides when to read.
					mode: "next_turn",
				}),
			dispose: async (targetAgentId, options) => {
				if (!this._live.has(targetAgentId)) {
					return { kind: this._tombstones.has(targetAgentId) ? "already_disposed" : "unknown" };
				}
				if (!this._agentsShareTree(agentId, targetAgentId)) {
					return { kind: "outside_tree" };
				}
				const selected =
					options.scope === "subtree" ? this._collectAgentSubtreePostOrder(targetAgentId) : [targetAgentId];
				// An agent cannot dispose itself, directly or inside the subtree it
				// named: the reply to this very tool call would have nowhere to land.
				if (selected.includes(agentId)) return { kind: "self" };
				const agentIds = await this.disposeAgent(targetAgentId, {
					intent: "removed",
					reason: options.reason,
					scope: options.scope,
				});
				return agentIds.length > 0 ? { kind: "disposed", agentIds } : { kind: "already_disposed" };
			},
			// The attachment's own capabilities, not an id-taking forwarder: they carry
			// the owner and generation the job table authorizes against.
			jobs: attachment.host,
			settler: attachment.settler,
			requestHuman: async (request) =>
				await this._requestHumanForAgent(agentId, { ...request, source: { kind: "agent", agentId } }),
		};
	}

	// -----------------------------------------------------------------------
	// Profiles, models, thinking levels, and resources
	//
	// Mostly forwarding. A single agent's model and thinking level live in its
	// harness; what is added here is the runtime policy around them - enabled
	// profiles, available models, and the refusal to resume under a model that is
	// no longer registered.
	// -----------------------------------------------------------------------

	private _isProfileEnabled(profileId: string): boolean {
		return this._enabledProfileIds === undefined || this._enabledProfileIds.includes(profileId);
	}

	private async _resolveCreateProfile(
		origin: Extract<SpawnAgentOrigin, { kind: "new" }>,
	): Promise<ResolvedAgentProfile> {
		const resolved = await this._resolveProfileById(origin.profileId ?? this._defaultProfileId, undefined);
		return { ...resolved, profile: await this._applyProfileOverride(resolved.profile, origin.profileOverride) };
	}

	/**
	 * A session with no profile reference cannot be resumed at all: nothing else
	 * records what the agent was, and guessing would resume the branch as
	 * something it never ran as.
	 */
	private async _resolveResumeProfile(agentId: AgentId, metadata: JsonlSessionMetadata): Promise<ResolvedAgentProfile> {
		const reference = parseAgentProfileReference(metadata.metadata?.profile);
		if (!reference) {
			throw new OrchestratorError({
				severity: "error",
				code: "profile.resolution_failed",
				message: `Cannot resume agent ${agentId}: session metadata does not contain a profile reference.`,
				agentId,
			});
		}
		return await this._resolveProfileById(reference.id, agentId);
	}

	private async _resolveProfileById(profileId: string, agentId: AgentId | undefined): Promise<ResolvedAgentProfile> {
		const result = await this.profileRegistry.resolveProfile(profileId);
		await this._publishDiagnostics(result.diagnostics);
		if (!result.ok) {
			throw new OrchestratorError(
				await this._publishAndReturn({
					severity: "error",
					code: "profile.resolution_failed",
					message: `Cannot resolve profile ${profileId}: ${result.reason}.`,
					agentId,
				}),
			);
		}
		if (!this._isProfileEnabled(result.profile.id)) {
			throw new OrchestratorError(
				await this._publishAndReturn({
					severity: "error",
					code: "profile.disabled",
					message: `Profile is disabled by runtime policy: ${result.profile.id}`,
					agentId,
				}),
			);
		}
		return { profile: result.profile, source: result.source, entryId: result.entryId };
	}

	/**
	 * An override may not change the id, and a persistent profile may not have its
	 * recoverable fields overridden: a resume re-resolves those from the registry,
	 * so such a session could never be reopened as the agent that wrote it.
	 */
	private async _applyProfileOverride(
		profile: AgentProfile,
		override: AgentProfileOverride | undefined,
	): Promise<AgentProfile> {
		if (!override) return profile;
		if ("id" in override) {
			throw new OrchestratorError(
				await this._publishAndReturn({
					severity: "error",
					code: "profile.override_invalid",
					message: `Profile override cannot change profile id: ${profile.id}.`,
				}),
			);
		}
		const merged: AgentProfile = { ...profile, ...override };
		if (merged.persist && changesRecoverableProfileFields(override)) {
			throw new OrchestratorError(
				await this._publishAndReturn({
					severity: "error",
					code: "profile.override_not_persistable",
					message: `Profile '${profile.id}' override changes recoverable profile fields and cannot create a persistent session.`,
				}),
			);
		}
		return merged;
	}

	/**
	 * A recorded model that is no longer registered is an error, not a silent
	 * fallback: the branch was produced by that model, and reopening it under
	 * another changes what the conversation is without saying so.
	 */
	private _resolveResumeModel(
		contextModel: { readonly provider: string; readonly modelId: string } | null,
	): RuntimeModel {
		if (!contextModel) return this._defaultModel;
		const model = this.modelRegistry.find(contextModel.provider, contextModel.modelId);
		if (!model) {
			throw new OrchestratorError({
				severity: "error",
				code: "model.not_available",
				message: `Cannot resume model ${contextModel.provider}/${contextModel.modelId}: it is not registered.`,
			});
		}
		return model;
	}

	/**
	 * The settings the harness cannot answer after construction. Read fresh per
	 * spawn rather than inherited: an agent created after the user changed a
	 * setting should run under the setting now in force.
	 */
	private _captureAgentSettings(): AgentSettings {
		return {
			retry: this.settingManager.getRetrySettings(),
			providerRetry: this.settingManager.getProviderRetrySettings(),
			compaction: this.settingManager.getCompactionSettings(),
			blockImages: this.settingManager.getImageSettings().blockImages,
		};
	}

	getAgentModel(agentId: AgentId): RuntimeModel {
		return this._requireLiveAgent(agentId).harness.getModel();
	}

	async setAgentModel(agentId: AgentId, model: RuntimeModel): Promise<void> {
		await this._requireLiveAgent(agentId).harness.setModel(model);
		// The cached measurement names the previous model and its window.
		await this._context.invalidate(agentId);
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

	async setAgentModelByReference(agentId: AgentId, reference: string): Promise<RuntimeModel> {
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
		const model = models.find((candidate) => candidate.provider === parsed.provider && candidate.id === parsed.modelId);
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
		return this._auth.listProviders();
	}

	async listAuthCredentialCandidates(): Promise<AuthCredentialCandidateListResult> {
		return await this._auth.listCredentials();
	}

	async loginAuthProvider(
		providerId: string,
		options?: { readonly agentId?: AgentId },
	): Promise<AuthProviderLoginResult> {
		return await this._auth.login(providerId, options);
	}

	async logoutAuthProvider(providerId: string): Promise<AuthProviderLogoutResult> {
		return await this._auth.logout(providerId);
	}

	listAgentThinkingLevelCandidates(agentId: AgentId): AgentThinkingLevelCandidateListResult {
		const { harness } = this._requireLiveAgent(agentId);
		return { levels: this._thinkingLevelCandidates(agentId, harness.getModel()) };
	}

	getAgentThinkingLevel(agentId: AgentId): ThinkingLevel {
		return this._requireLiveAgent(agentId).harness.getThinkingLevel();
	}

	async setAgentThinkingLevel(agentId: AgentId, level: ThinkingLevel): Promise<void> {
		const { harness } = this._requireLiveAgent(agentId);
		const model = harness.getModel();
		const supported = this._thinkingLevelCandidates(agentId, model);
		if (!supported.some((candidate) => candidate.value === level)) {
			throw new OrchestratorError({
				severity: "error",
				code: "model.thinking_level_not_supported",
				message: `Thinking level ${level} is not supported by model ${model.provider}/${model.id}.`,
				agentId,
			});
		}
		await harness.setThinkingLevel(level);
	}

	async setAgentThinkingLevelByName(agentId: AgentId, levelName: string): Promise<AgentThinkingLevelResult> {
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

	/**
	 * A model with no reasoning throws rather than returning an empty list: "none
	 * available" and "not a thinking model" are different answers.
	 */
	private _thinkingLevelCandidates(agentId: AgentId, model: RuntimeModel): readonly CandidateItem[] {
		if (!model.reasoning) {
			throw new OrchestratorError({
				severity: "error",
				code: "model.thinking_not_supported",
				message: `Model ${model.provider}/${model.id} does not support thinking levels.`,
				agentId,
			});
		}
		return getSupportedThinkingLevels(model).map((level) => ({ value: level, label: level }));
	}

	async listAgentPromptTemplateCandidates(agentId: AgentId): Promise<AgentPromptTemplateCandidateListResult> {
		return {
			templates: (await this._loadAgentPromptTemplates(agentId)).map((template) => ({
				value: template.name,
				label: template.name,
				...(template.description === undefined ? undefined : { description: template.description }),
			})),
		};
	}

	async getAgentPromptTemplate(agentId: AgentId, name: string): Promise<PromptTemplate> {
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

	/** Reloaded per listing: a template the user just edited should be usable at once. */
	private async _loadAgentPromptTemplates(agentId: AgentId): Promise<readonly PromptTemplate[]> {
		this._requireLiveAgent(agentId);
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

	async listAgentSkillCandidates(agentId: AgentId): Promise<AgentSkillCandidateListResult> {
		return {
			skills: (await this._loadAgentSkills(agentId)).map((skill) => ({
				value: skill.name,
				label: skill.name,
				...(skill.description === undefined ? undefined : { description: skill.description }),
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
	private async _loadAgentSkills(agentId: AgentId): Promise<readonly Skill[]> {
		const { resolvedProfile } = this._requireLiveAgent(agentId);
		const loaded = await this.resourceLoader.loadSkills(resolvedProfile.skills);
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

	// -----------------------------------------------------------------------
	// Sessions
	//
	// Reads go straight to the SessionManager. The one write goes through the
	// harness, which owns the session file while an operation is running.
	// -----------------------------------------------------------------------

	async listAgentSessions(): Promise<AgentSessionListResult> {
		return { sessions: await this.sessionManager.listAgentSessionCandidates() };
	}

	async getAgentSession(agentId: AgentId): Promise<AgentSessionSnapshot> {
		this._requireLiveAgent(agentId);
		return await this.sessionManager.getAgentSessionSnapshot(agentId);
	}

	async getAgentSessionTree(agentId: AgentId): Promise<AgentSessionTreeSnapshot> {
		this._requireLiveAgent(agentId);
		return await this.sessionManager.getAgentSessionTree(agentId);
	}

	async getAgentSessionName(agentId: AgentId): Promise<string | undefined> {
		return (await this.getAgentSession(agentId)).name;
	}

	/**
	 * **Session write.** Metadata rather than branch content, but it takes the
	 * same route: `harness.setSessionName` serializes behind whatever the harness
	 * has already buffered instead of racing it.
	 */
	async setAgentSessionName(agentId: AgentId, name: string): Promise<void> {
		await this._requireLiveAgent(agentId).harness.setSessionName(name);
		await this._emit({ type: "agent_session_info_changed", agentId, name, changedAt: now() });
	}

	// -----------------------------------------------------------------------
	// Background jobs
	//
	// Forwarding, plus the liveness gate this class owns: the runtime answers by
	// owner id and knows nothing about `_live`, so without the gate a tombstoned
	// agent's jobs would still be listable.
	// -----------------------------------------------------------------------

	/** Live backgrounded jobs: the t0 handles the model is currently holding. */
	listAgentBackgroundJobs(agentId: AgentId): BackgroundJobSnapshot[] {
		this._requireLiveAgent(agentId);
		return [...this._backgroundJobs.listJobs(agentId)];
	}

	/** Rolling output tail of a live job. Output is pull-only: events never carry it. */
	readAgentBackgroundJobOutput(agentId: AgentId, jobId: string): string | undefined {
		this._requireLiveAgent(agentId);
		const result = this._backgroundJobs.readJobOutput(agentId, jobId);
		return result.ok ? result.read.output : undefined;
	}

	/**
	 * A request, not a kill: a local job stops only if its tool honours the
	 * signal, while an external job is cancelled by the runtime itself. False
	 * means there was no such live job - it may have settled since it was listed.
	 */
	abortAgentBackgroundJob(agentId: AgentId, jobId: string, reason?: string): boolean {
		this._requireLiveAgent(agentId);
		return this._backgroundJobs.abortJob(agentId, jobId, reason).ok;
	}

	/** Every job this session has on record, including runs before this process. */
	agentBackgroundJobHistory(agentId: AgentId): readonly JobHistoryEntry[] {
		this._requireLiveAgent(agentId);
		return this._backgroundJobs.history(agentId);
	}

	// -----------------------------------------------------------------------
	// Human requests, clients, and events
	// -----------------------------------------------------------------------

	async requestHuman(request: HumanRequest): Promise<HumanResponse> {
		return await this._humanRequests.request(request);
	}

	/**
	 * The agentId is a separate argument because it decides cancellation scope,
	 * and that must not be forgeable through the request's own `source`.
	 */
	private async _requestHumanForAgent(agentId: AgentId, request: HumanRequest): Promise<HumanResponse> {
		return await this._humanRequests.request(request, { agentId });
	}

	async cancelHumanRequest(requestId: string, reason?: string): Promise<boolean> {
		return await this._humanRequests.cancel(requestId, reason);
	}

	registerClient(client: OrchestratorClient<OrchestratorEvent>): () => void {
		return this._events.registerClient(client);
	}

	subscribe(listener: OrchestratorEventListener): () => void {
		return this._events.subscribe(listener);
	}

	subscribeAgent(agentId: AgentId, listener: OrchestratorEventListener): () => void {
		return this._events.subscribeAgent(agentId, listener);
	}

	/**
	 * Broadcast, once, that an exit is intended. Nothing is torn down here; the
	 * host decides what to do about it.
	 *
	 * The dispatch order is a deliberate exception to `_emit`: a host listener may
	 * start `disposeAll` the instant it sees the request, so extension observers
	 * get their final persistence work in first.
	 */
	async requestShutdown(request: RuntimeShutdownRequest): Promise<void> {
		if (this._shutdownRequested) return;
		this._shutdownRequested = true;
		const event: Extract<OrchestratorEvent, { type: "runtime_shutdown_requested" }> = Object.freeze({
			type: "runtime_shutdown_requested",
			requestedBy: request.requestedBy,
			requestedByAgentId: request.requestedByAgentId,
			...(request.reason === undefined ? undefined : { reason: request.reason }),
			createdAt: now(),
		});
		await this._dispatchExtensionObservedEvent(event);
		await this._emit(event, { observeExtensions: false });
	}

	/**
	 * The bus owns listeners and clients; extension observers are a runner
	 * lifecycle concern composed here rather than inside the bus, which knows
	 * nothing about extensions. `observeExtensions: false` is how a fact an
	 * extension produced avoids feeding straight back into it.
	 */
	private async _emit(
		event: OrchestratorEvent,
		options: EventPublishOptions & { readonly observeExtensions?: boolean } = {},
	): Promise<void> {
		await this._events.publish(event, options);
		if (options.observeExtensions === false) return;
		if (!isExtensionObservedEvent(event)) return;
		await this._dispatchExtensionObservedEvent(event);
	}

	private async _publishDiagnostic(
		diagnostic: OrchestratorDiagnostic,
		options: EventPublishOptions & { readonly observeExtensions?: boolean } = {},
	): Promise<void> {
		await this._emit({ type: "diagnostic", diagnostic, createdAt: now() }, options);
	}

	private async _publishDiagnostics(
		diagnostics: readonly OrchestratorDiagnostic[],
		options: EventPublishOptions & { readonly observeExtensions?: boolean } = {},
	): Promise<void> {
		for (const diagnostic of diagnostics) {
			await this._publishDiagnostic(diagnostic, options);
		}
	}

	/** Publish a diagnostic and hand it back, for the throw-after-publish paths. */
	private async _publishAndReturn(diagnostic: OrchestratorDiagnostic): Promise<OrchestratorDiagnostic> {
		await this._publishDiagnostic(diagnostic);
		return diagnostic;
	}

	/** Drained rather than read, so a second call does not republish the same warnings. */
	private _drainCoreDiagnostics(): readonly OrchestratorDiagnostic[] {
		return [
			...this.settingManager.drainDiagnostics(),
			...this.modelRegistry.authStorage.drainDiagnostics(),
			...this.modelRegistry.drainDiagnostics(),
		];
	}

	/**
	 * Always a warning and never re-thrown: these are reported from teardown and
	 * observer paths where no caller is left to handle a rejection.
	 */
	private async _recordAgentLifecycleFailure(agentId: AgentId, code: string, message: string): Promise<void> {
		const diagnostic: OrchestratorDiagnostic = { severity: "warning", code, message, agentId };
		this._addAgentDiagnostics(agentId, [diagnostic]);
		await this._publishDiagnostic(diagnostic);
	}

	/**
	 * One subscription, not two: the activity observer and the session-write
	 * observer need the same event and the same run signal, and splitting them
	 * would double every dispatch and let the two views drift on ordering.
	 */
	private async _bindHarness(
		agentId: AgentId,
		generation: number,
		harness: WidiAgentHarness,
	): Promise<() => Promise<void>> {
		const unsubscribe = harness.subscribe((event, signal) => {
			void this._handleHarnessEvent(agentId, generation, event, signal);
		});
		return async () => {
			unsubscribe();
		};
	}

	/**
	 * The run signal is installed before the observers run and cleared after
	 * `settled`, but only if it is still this run's signal: a queued next turn may
	 * have installed its own while dispatch was pending.
	 *
	 * `agent_harness_event` is published before the session-write observer so a
	 * client sees the persisted user message before the presentation entry that
	 * names it.
	 */
	private async _handleHarnessEvent(
		agentId: AgentId,
		generation: number,
		event: AgentHarnessEvent,
		signal: AbortSignal | undefined,
	): Promise<void> {
		if (signal) this._agentRunSignals.set(agentId, signal);
		try {
			await this._observeHarnessActivity(agentId, generation, event);
			await this._emit({ type: "agent_harness_event", agentId, event });
			if (event.type === "session_write") {
				await this._observeSessionWrite(agentId, event.entryId, event.write);
			}
		} finally {
			if (event.type === "settled" && this._agentRunSignals.get(agentId) === signal) {
				this._agentRunSignals.delete(agentId);
			}
		}
	}

	/** Append to this agent's diagnostics history, which the snapshot reads. */
	private _addAgentDiagnostics(agentId: AgentId, diagnostics: readonly OrchestratorDiagnostic[]): void {
		if (diagnostics.length === 0) return;
		const history = this._agentDiagnostics.get(agentId) ?? [];
		history.push(...diagnostics);
		this._agentDiagnostics.set(agentId, history);
	}
}

/** How long a dispose waits for `shutdown()`; the wait is otherwise unbounded. */
const AGENT_SHUTDOWN_TIMEOUT_MS = 10_000;

async function withTimeout(work: Promise<void>, timeoutMs: number, message: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		// The abandoned work still settles; it must not surface as unhandled.
		work.catch(() => {});
	}
}

/** Maintenance phases the harness reports, in the vocabulary surfaces use. */
function toMaintenanceKind(phase: AgentHarnessPhase): AgentMaintenanceKind | undefined {
	if (phase === "compaction") return "compaction";
	if (phase === "branch_summary") return "tree-navigation";
	return undefined;
}

function toActivitySnapshot(phase: AgentHarnessPhase): AgentActivitySnapshot {
	const maintenance = toMaintenanceKind(phase);
	if (maintenance) return { activity: "running", maintenance };
	return { activity: phase === "idle" ? "idle" : "running" };
}

function maintenanceDescription(kind: AgentMaintenanceKind): string {
	return kind === "tree-navigation" ? "tree navigation" : "compaction";
}

/** Everything handed to a harness that it has not read yet. */
function queuedMessageCount(harness: WidiAgentHarness): number {
	const counts = harness.getQueuedMessageCounts();
	return counts.steer + counts.followUp + counts.nextTurn;
}

/** One background-runtime event, renamed into the orchestrator's vocabulary. */
function toOrchestratorBackgroundEvent(event: BackgroundJobEvent): OrchestratorEvent {
	if (event.type === "job_changed") {
		return {
			type: "agent_background_job_changed",
			agentId: event.agentId,
			job: event.job,
			transition: event.transition,
			liveCount: event.liveCount,
			changedAt: event.changedAt,
		};
	}
	if (event.type === "job_report") {
		return {
			type: "agent_background_job_report_updated",
			agentId: event.agentId,
			jobId: event.jobId,
			report: event.report,
			changedAt: event.changedAt,
			operationRef: event.operationRef,
		};
	}
	return {
		type: "agent_background_job_progress",
		agentId: event.agentId,
		jobId: event.jobId,
		sequence: event.sequence,
		chunk: event.chunk,
		startByte: event.startByte,
		endByte: event.endByte,
		totalBytesSeen: event.totalBytesSeen,
		progressDroppedBytes: event.progressDroppedBytes,
		observedAt: event.observedAt,
		operationRef: event.operationRef,
	};
}

/** Model-visible summary of one live agent, for the collaboration tools. */
function describeAgentForTools(liveAgent: LiveAgent): AgentBrief {
	const { reference } = liveAgent.profile;
	return {
		agentId: liveAgent.agentId,
		profileId: reference.id,
		...(reference.label === undefined ? undefined : { label: reference.label }),
		activity: toActivitySnapshot(liveAgent.harness.getPhase()).activity,
	};
}

/**
 * Narrow requested active tools to the installed ones, reporting each rejection
 * rather than failing the call. Deliberately not the registry's own resolution:
 * this validates against the harness's live tool set, the only set that can be
 * activated, and never re-derives the installed tools as a side effect.
 */
function selectActiveToolNames(
	toolNames: readonly string[],
	installedNames: ReadonlySet<string>,
	agentId: AgentId,
): { readonly activeToolNames: string[]; readonly diagnostics: readonly OrchestratorDiagnostic[] } {
	const activeToolNames: string[] = [];
	const diagnostics: OrchestratorDiagnostic[] = [];
	const seen = new Set<string>();
	for (const rawName of toolNames) {
		const name = rawName.trim();
		if (!name) {
			diagnostics.push({
				severity: "error",
				code: "tool.invalid_name",
				message: "Tool name list contains an empty name.",
				agentId,
			});
			continue;
		}
		if (seen.has(name)) {
			diagnostics.push({
				severity: "warning",
				code: "tool.active_duplicate",
				message: `Tool name '${name}' is listed more than once; keeping the first occurrence.`,
				agentId,
			});
			continue;
		}
		seen.add(name);
		if (!installedNames.has(name)) {
			diagnostics.push({
				severity: "warning",
				code: "tool.active_missing",
				message: `Active tool '${name}' is not in the agent's installed tool set.`,
				agentId,
			});
			continue;
		}
		activeToolNames.push(name);
	}
	return { activeToolNames, diagnostics };
}

/**
 * Profile fields a resume re-resolves from the registry. Overriding one of them
 * on a persistent profile would produce a session that could never be reopened
 * as the agent that wrote it.
 */
function changesRecoverableProfileFields(override: AgentProfileOverride): boolean {
	return (
		override.systemPrompt !== undefined ||
		override.tools !== undefined ||
		override.skills !== undefined ||
		override.projectContext !== undefined ||
		override.includeCwd !== undefined ||
		override.skillsListing !== undefined ||
		override.appendSystemPrompt !== undefined ||
		override.persist !== undefined
	);
}

/** Which orchestrator events extension runners are allowed to observe. */
function isExtensionObservedEvent(event: OrchestratorEvent): event is ExtensionObservedEvent {
	return Object.hasOwn(EXTENSION_OBSERVED_EVENT_NAMES, event.type);
}

/** The harness takes a mutable image array; the orchestrator passes readonly ones. */
function toHarnessMessageOptions(
	options: { readonly images?: readonly ImageContent[] } | undefined,
): { images: ImageContent[] } | undefined {
	return options?.images ? { images: [...options.images] } : undefined;
}

/**
 * Reduce the append-only tree log to the members still live when it was last
 * written. The log is appended in event order, so order is the truth.
 */
function reduceAgentTreeRecords(records: readonly AgentTreeRecord[]): readonly AgentTreeSpawnRecord[] {
	const members = new Map<AgentId, AgentTreeSpawnRecord>();
	for (const record of records) {
		if (record.type === "removed") members.delete(record.agentId);
		else members.set(record.agentId, record);
	}
	return [...members.values()];
}

/**
 * The extension-facing shape: identity and conversation, no filesystem layout.
 * An ephemeral session owns no persisted file and therefore has no ref.
 */
function toExtensionSessionSnapshot(
	snapshot: AgentSessionSnapshot,
	sessions: SessionManager,
): ExtensionSessionSnapshot {
	const { metadata } = snapshot;
	const path = "path" in metadata && typeof metadata.path === "string" ? metadata.path : undefined;
	return {
		...(path === undefined ? undefined : { ref: sessions.toSessionHandle(path) }),
		id: metadata.id,
		...(snapshot.name === undefined ? undefined : { name: snapshot.name }),
		leafId: snapshot.leafId,
		pathToRoot: cloneSessionEntries(snapshot.pathToRoot),
	};
}

function toExtensionSessionTree(snapshot: AgentSessionTreeSnapshot, sessions: SessionManager): ExtensionSessionTree {
	return { ...toExtensionSessionSnapshot(snapshot, sessions), entries: cloneSessionEntries(snapshot.entries) };
}

function cloneSessionEntries(entries: readonly SessionTreeEntry[]): readonly SessionTreeEntry[] {
	return structuredClone(entries);
}

/**
 * Every config-value channel in a provider config: the provider api key, and
 * the provider- and model-level request headers.
 */
function hasCommandConfigValues(config: ProviderConfigInput, resolver: ConfigValueResolver): boolean {
	const values = [
		config.apiKey,
		...Object.values(config.headers ?? {}),
		...(config.models ?? []).flatMap((model) => Object.values(model.headers ?? {})),
	];
	return values.some((value) => value !== undefined && resolver.isCommandConfigValue(value));
}

/**
 * Severity is the whole test: a warning describes a degraded extension, an error
 * one the agent cannot run without.
 */
function isBlockedExtensionDiagnostic(diagnostic: OrchestratorDiagnostic): boolean {
	return diagnostic.severity === "error";
}

/** A thinking level recorded in a session, rejected rather than coerced. */
function resolveThinkingLevel(level: string): ThinkingLevel | undefined {
	const parsed = parseThinkingLevel(level);
	return parsed === level ? parsed : undefined;
}

function collectUserMessageText(entries: readonly SessionTreeEntry[]): string[] {
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

/** The recorded outcome when there is one, otherwise a cancellation for work the exit ended. */
function toCarriedOverJobResultText(job: JobHistoryEntry): string {
	return (
		job.messageText ??
		formatInterruptedBackgroundJobResultText({
			jobId: job.jobId,
			toolCallId: job.toolCallId,
			toolName: job.toolName,
			...(job.stopReason === undefined ? undefined : { stopReason: job.stopReason }),
		})
	);
}

function now(): string {
	return new Date().toISOString();
}
