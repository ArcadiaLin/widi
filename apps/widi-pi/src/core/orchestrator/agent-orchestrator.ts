/**
 * AgentOrchestrator - the multi-agent runtime.
 *
 * One criterion shapes this file: a fact about a single agent is read from that
 * agent's `AgentHarness`; the orchestrator only decides what needs more than one
 * agent to answer. That is AgentId allocation and non-reuse, spawn-tree
 * ownership and traversal, cross-agent routing and source attribution, who is
 * waiting on whom to go idle, and the persistence of those facts.
 *
 * The exceptions are enumerated in `docs/agent-harness-ownership-plan.md`:
 * declarative tool policy, the system-prompt and resource facts removed from the
 * harness fork, the four remaining `AgentSettings` entries, the per-run abort
 * signal, and the agentId-to-session-directory mapping.
 *
 * Collaborators are split by one rule: a runtime earns its own class only when
 * it owns state whose invariant it can maintain alone, without consulting
 * `_live`. Four qualify - `BackgroundJobRuntime`, `OrchestratorEventBus`,
 * `AgentContextMonitor`, `AuthRuntimeController`. Everything whose central
 * judgement is a join across `_live`, harness phase, the spawn tree, or
 * background jobs stays here, because that join is what an orchestrator is.
 * `MessageDeliveryQueue` is a tool this class calls, not a peer domain.
 *
 * Design: `docs/orchestrator.pseudo.ts`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
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
	type Session,
	type SessionTreeEntry,
	shouldCompact,
	type ThinkingLevel,
} from "@widi/agent-core";
import { formatError } from "../../utils/errors.ts";
import type {
	AgentProfile,
	AgentProfileOverride,
	AgentProfileRegistry,
	AgentProfileSource,
} from "../agent-profile.js";
import {
	type BackgroundJobDelivery,
	type BackgroundJobDeliveryReceipt,
	BackgroundJobRuntime,
	backgroundJobResultHeaderPrefix,
	formatInterruptedBackgroundJobResultText,
	type OwnerAttachment,
	type PersistedBackgroundJob,
} from "../background/index.ts";
import {
	type OrchestratorDiagnostic,
	OrchestratorError,
} from "../diagnostics.ts";
import type { ExtensionCoreActions } from "../extension/index.ts";
import { ExtensionLoader, type ExtensionRunner } from "../extension/index.ts";
import {
	cloneExtensionInputPresentation,
	type ExtensionInputPresentation,
	validateExtensionInputPresentation,
} from "../extension/presentation.ts";
import { ExtensionStatusRegistry } from "../extension/status-registry.ts";
import { HumanInterruptRegistry } from "../human-interrupt.ts";
import { HumanRequestBroker } from "../human-request.ts";
import {
	assertMessageBody,
	backgroundResultMergeKey,
	type MessageDeliveryMethod,
	type MessageDeliveryPhase,
	MessageDeliveryQueue,
	type MessageDeliveryReceipt,
	type MessageDeliveryRequest,
	type MessageDraft,
	type MessageSendOutcome,
	renderMessageEnvelope,
	transformMessage,
} from "../message.ts";
import { type ModelRegistry, parseThinkingLevel } from "../model-registry.js";
import type { ResourceLoader } from "../resource-loader.js";
import type {
	AgentSessionCandidate,
	AgentSessionMetadata,
	SessionManager,
} from "../session-manager.ts";
import {
	COMMAND_EXPANSION_CUSTOM_TYPE,
	type CommandExpansionEntryData,
	EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE,
	type ExtensionInputPresentationEntryData,
	INPUT_TRANSFORM_CUSTOM_TYPE,
	type InputTransformEntryData,
} from "../session-manager.ts";
import type { AgentTreeSpawnRecord } from "../session-tree.ts";
import type { SettingManager } from "../setting-manager.js";
import { ToolRegistry } from "../tool-registry.ts";
import type {
	AgentActivitySnapshot,
	AgentId,
	AgentIdleReason,
	AgentMaintenanceKind,
	CandidateItem,
	PromptExpansion,
	PromptOutcome,
	RuntimeModel,
} from "../types.ts";
import { AuthRuntimeController } from "./auth-controller.ts";
import { AgentContextMonitor } from "./context-monitor.ts";
import { OrchestratorEventBus } from "./event-bus.ts";
import type { AgentDisposeScope } from "./host.ts";
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

/**
 * Where an agent's context comes from. Orthogonal to `parent`, which decides
 * spawn-tree ownership: a resumed agent can be someone's child, and a new
 * top-level agent has no parent.
 */
export type SpawnAgentOrigin =
	| {
			readonly kind: "new";
			readonly profileId?: string;
			readonly profileOverride?: AgentProfileOverride;
	  }
	| {
			readonly kind: "resume";
			readonly reference: string | JsonlSessionMetadata;
	  }
	| {
			readonly kind: "fork";
			readonly sourceAgentId: AgentId;
			readonly entryId?: string;
	  };

export interface SpawnAgentOptions {
	readonly origin: SpawnAgentOrigin;
	/** Absent means top-level; present records `spawnedBy` and the tree edge. */
	readonly parent?: AgentId;
	readonly model?: RuntimeModel;
	readonly thinkingLevel?: ThinkingLevel;
}

/**
 * Why an agent is going away.
 *
 * `removed` means it should not come back and writes a durable tombstone into
 * the tree log. `runtime_shutdown` writes nothing: without the distinction, a
 * normal exit would mark every agent as removed and tree restoration would never
 * restore anything.
 */
export type AgentDisposeIntent = "removed" | "runtime_shutdown";

export interface DisposeAgentOptions {
	readonly intent: AgentDisposeIntent;
	readonly reason?: string;
	/** Default: dispose only the named agent. */
	readonly scope?: AgentDisposeScope;
}

/**
 * A creation in flight.
 *
 * Not a request-coalescing optimization: it exists so a second resume of the
 * same session reuses the first result (restoring a tree hits this whenever the
 * user already resumed a child by hand), and so a build caught by `disposeAll`
 * can be cancelled instead of becoming an orphan after the sweep.
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

/**
 * One lookup, one complete answer. The four cases exhaust what an AgentId can
 * mean, and each comes from exactly one table.
 */
type AgentLookup =
	| { readonly kind: "live"; readonly liveAgent: LiveAgent }
	| { readonly kind: "gone" }
	| {
			readonly kind: "creating";
			readonly reservation: AgentCreationReservation;
	  }
	| { readonly kind: "unknown" };

/**
 * A resolved delivery target.
 *
 * `phase` is read from the harness at lookup time rather than projected: the
 * delivery method is chosen from it, and harness errors do not cover every
 * phase (calling `followUp` on an idle target only yields a retryable
 * `invalid_state`, which would defer the message forever).
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
 * An input presentation waiting to be paired with the user message it belongs
 * to. Pairing happens on the harness `session_write` event, which carries both
 * the persisted entry and its id.
 *
 * `method` is recorded because an abort clears the steer and follow-up queues
 * wholesale: everything delivered that way is now never going to be written,
 * while a `prompt` delivery has already committed its user message.
 */
interface PendingExtensionInputPresentation
	extends ExtensionInputPresentationRecord {
	method?: MessageDeliveryMethod;
}

/**
 * A message accepted into the target's delivery queue, or one an extension
 * ended before it got there.
 *
 * There is no third case for "written but undelivered": the provisional entry
 * pair and its retraction point are gone, because the accounting entries are
 * now written through the harness and ordered on its own write tail.
 */
type AcceptedMessage =
	| { readonly kind: "accepted"; readonly receipt: MessageDeliveryReceipt }
	| {
			readonly kind: "blocked";
			readonly inputId: string;
			readonly reason?: string;
			readonly blockedBy: string;
	  };

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
 * touched. Producing it can fail freely: nothing has been registered yet.
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
 * The synchronous cutover result of one dispose target.
 *
 * `liveAgent` may be absent: the target can already be a tombstone, or still be
 * building - in which case the creation reservation's `cancelled` flag makes the
 * builder run its own failure cleanup.
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
	 * A sibling runtime. This reference exists only to attach and detach, hand
	 * capabilities to scoped hosts, read `liveJobCount` and `carriedOverJobs`,
	 * and receive t1 deliveries. Job state is never read from here, and an
	 * unsettled job never makes its owner busy.
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

	/**
	 * Per-target FIFO with merge and failure requeue. Two ports, no knowledge of
	 * the agent registry. There is no second message class: the judgement that
	 * would justify one - where a message goes, and whether an agent is idle - is
	 * a join across `_live`, harness phase, and background jobs, which is this
	 * class by definition.
	 */
	private readonly _messages: MessageDeliveryQueue;

	/**
	 * Prompt runs this orchestrator started. The harness reports that it is in a
	 * turn; it cannot report who started that turn, who is awaiting its result,
	 * or whether the run ended by abort or settlement.
	 *
	 * Staleness is decided by object identity, which is why there is no
	 * `_agentStatusRevisions`: a run only settles the idle edge while it is still
	 * the value in this map.
	 */
	private readonly _agentPromptRuns = new Map<AgentId, AgentPromptRun>();

	/**
	 * Waiters for the target's next `agent_start`, registered before `prompt()`.
	 *
	 * Acceptance waits for that event because everything the harness does before
	 * it is asynchronous and can fail, and a failure there means the user message
	 * was never persisted. Phase cannot substitute: it flips to `turn` on the
	 * first line of `prompt()`.
	 */
	private readonly _agentRunStartWaiters = new Map<AgentId, Set<() => void>>();

	/** The current run's abort signal, captured from the harness subscription. */
	private readonly _agentRunSignals = new Map<AgentId, AbortSignal>();

	/**
	 * The idle edge: who is waiting for it, why the last one happened, and
	 * whether it has already been published.
	 *
	 * All three read the one judgement in `_resolveAgentIdleState`, so a consumer
	 * that awaited `waitForAgentIdle` and one subscribed to `agent_idle` can
	 * never disagree about whether the agent stopped.
	 */
	private readonly _agentIdleWaiters = new Map<AgentId, Set<AgentIdleWaiter>>();
	private readonly _agentIdleReasons = new Map<AgentId, AgentIdleReason>();
	private readonly _publishedAgentIdles = new Set<AgentId>();

	/**
	 * The activity last published for each agent.
	 *
	 * Not a mirror of the harness - every reader takes `getPhase()` - but
	 * `agent_status_changed` is edge-triggered, and an edge cannot be detected
	 * from a value alone. This is the previous value that makes the comparison
	 * possible, and the source of the event's `previousActivity`.
	 */
	private readonly _publishedAgentActivities = new Map<
		AgentId,
		AgentActivitySnapshot
	>();

	private _nextInputId = 1;
	private _nextPresentationId = 1;

	// -- Extension data plane ------------------------------------------------

	/**
	 * Input presentations already delivered but not yet paired with a user
	 * message, in delivery order per target. Pairing pops the head on the harness
	 * `session_write` event, which carries the entry and its id together; the old
	 * `expectedText` guess and the reverse session scan are both gone.
	 */
	private readonly _pendingExtensionInputPresentations = new Map<
		AgentId,
		PendingExtensionInputPresentation[]
	>();

	/** Per-agent, per-generation extension load results. */
	private readonly _extensionStatuses = new ExtensionStatusRegistry();

	/**
	 * Recursion depth for extension events. It belongs to the causal async chain,
	 * not the runtime: independent concurrent emits must not consume one
	 * another's budget, while a handler's nested emit inherits its parent's.
	 */
	private readonly _extensionEventDispatchContext =
		new AsyncLocalStorage<number>();

	/** Observed-event fan-out depth, which keeps diagnostics from self-feeding. */
	private readonly _extensionObserverDispatchDepth = new Map<AgentId, number>();

	/**
	 * One action table shared by every runner. The methods take agentId and
	 * extensionId explicitly and call this class's real methods, so no closure
	 * set is rebuilt per agent or per tool.
	 */
	private readonly _extensionCoreActions: ExtensionCoreActions;

	// -- Agent registry ------------------------------------------------------

	/**
	 * The only routable set, current generation only. Written by install, removed
	 * synchronously by the dispose cutover. A hit means alive; nothing else needs
	 * to be asked.
	 */
	private readonly _live = new Map<AgentId, LiveAgent>();

	/**
	 * AgentIds that existed and are gone.
	 *
	 * The sole purpose is to keep a dead id from being reused: an in-flight
	 * message aimed at a recycled id would reach a different agent. Intent, time,
	 * and reason are carried by `agent_disposed` and by `agents/tree.jsonl`, so
	 * nothing but the string is kept here.
	 */
	private readonly _tombstones = new Set<AgentId>();

	/**
	 * Spawn-tree edges, child to parent. **Not deleted on dispose.**
	 *
	 * A single dispose does not take the subtree with it, so a vanished
	 * intermediate node must still let an ancestor's subtree dispose reach its
	 * surviving descendants. This is also the in-memory mirror of
	 * `agents/tree.jsonl`.
	 *
	 * Pruning, without which this is just a slow leak in a new place: disposing a
	 * node with no surviving descendants drops its edge, then walks up the
	 * ancestor chain dropping every tombstone edge that likewise has none. What
	 * remains is bounded by the number of concurrently live branches.
	 */
	private readonly _spawnParent = new Map<AgentId, AgentId>();

	/** Next generation per AgentId, monotonic across resume of the same id. */
	private readonly _agentGenerations = new Map<AgentId, number>();

	/** Resume de-duplication and build cancellation. Not an activity state. */
	private readonly _agentCreations = new Map<
		AgentId,
		AgentCreationReservation
	>();

	/** Merges concurrent dispose requests only. */
	private readonly _agentDisposals = new Map<
		AgentId,
		AgentDisposalReservation
	>();

	/**
	 * Diagnostics history per agent, read by `AgentSnapshot`.
	 *
	 * A map is the whole thing: append, read by agent, drop on dispose. It is
	 * separate from `LiveAgent` because a disposed agent's `LiveAgent` is thrown
	 * away wholesale.
	 */
	private readonly _agentDiagnostics = new Map<
		AgentId,
		OrchestratorDiagnostic[]
	>();

	/**
	 * Agents already scheduled for automatic compaction but not yet started.
	 *
	 * Phase cannot replace this. The decision spans an await (re-measuring
	 * context usage), so phase only rejects at the second `compact()` call, and
	 * that rejection lands in a catch and becomes a user-visible
	 * `compaction.auto_failed` warning - a normal de-duplication turned into
	 * noise. This expresses scheduling intent, which was never the harness's
	 * question.
	 */
	private readonly _autoCompactingAgents = new Set<AgentId>();

	/**
	 * Serialized write tail per root tree file, so appended `spawned` and
	 * `removed` records keep the order the events happened in.
	 */
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
		this._enabledProfileIds = config.enabledProfileIds
			? [...config.enabledProfileIds]
			: undefined;
		this._defaultModel = config.defaultModel;
		this._defaultThinkingLevel = config.defaultThinkingLevel;

		this.modelRegistry.setDiagnosticPublisher(
			async (diagnostics) => await this._publishDiagnostics(diagnostics),
		);

		// Every port below points back at a private method of this class, so the
		// dependency edge stays one-way: a runtime knows its handful of callbacks
		// and nothing about the orchestrator.
		this._events = new OrchestratorEventBus({
			diagnose: async (diagnostic, options) =>
				await this._publishDiagnostic(diagnostic, options),
		});
		this._context = new AgentContextMonitor({
			sessionManager: this.sessionManager,
			resolve: (agentId) => {
				const liveAgent = this._live.get(agentId);
				return liveAgent
					? {
							generation: liveAgent.generation,
							model: liveAgent.harness.getModel(),
						}
					: undefined;
			},
			publish: async (event) => await this._emit(event),
			diagnose: async (diagnostic) => await this._publishDiagnostic(diagnostic),
		});
		this._humanRequests = new HumanRequestBroker({
			findHumanRequestHandler: () => this._events.findHumanRequestHandler(),
			emit: async (event) => await this._emit(event),
			publishDiagnostic: async (diagnostic) =>
				await this._publishDiagnostic(diagnostic),
			recordAgentLifecycleFailure: async (agentId, code, message) =>
				await this._recordAgentLifecycleFailure(agentId, code, message),
		});
		this._auth = new AuthRuntimeController({
			models: this.modelRegistry,
			humanRequests: this._humanRequests,
			publish: async (event) => await this._emit(event),
			diagnose: async (diagnostic) => await this._publishDiagnostic(diagnostic),
			diagnoseMany: async (diagnostics) =>
				await this._publishDiagnostics(diagnostics),
		});
		this._backgroundJobs = new BackgroundJobRuntime({
			openOwnerJournal: async (owner) =>
				await this.sessionManager.openBackgroundJobJournal(owner),
			deliverResult: async (delivery) =>
				await this._deliverBackgroundResult(delivery),
			publish: async (event) => await this._emit(event),
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
	// These are not any agent's state - a single agent's current values are read
	// from its harness - so every setter affects later spawns only and never
	// walks the live set rewriting it.
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
	 * Publish the diagnostics services accumulated while starting up.
	 *
	 * A separate method rather than part of the constructor: at construction no
	 * client has subscribed yet, so anything emitted there reaches nobody.
	 */
	async emitStartupDiagnostics(): Promise<void> {
		await this._publishDiagnostics(this._drainCoreDiagnostics());
	}

	// -----------------------------------------------------------------------
	// Registry lookup and projection
	// -----------------------------------------------------------------------

	/**
	 * The single lookup entry point, giving the complete gate answer at once.
	 *
	 * A hit in `_live` is routable. On a miss, `_tombstones` and
	 * `_agentCreations` tell `gone` from `creating`, and neither means `unknown`.
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
	 * Take the harness, and reject the phases that would accept text nothing
	 * reads.
	 *
	 * It rejects `compaction` and `branch_summary` only:
	 *
	 * - idle belongs to the harness. `steer()`, `followUp()`, and
	 *   `promoteFollowUpsToSteer()` already throw `invalid_state` there, and
	 *   checking it again would give one condition two producers.
	 * - abort must be allowed while idle: draining the queues is a meaningful
	 *   operation, not an error. Because only maintenance is blocked here, all
	 *   four entry points can share this helper.
	 * - a shut-down harness never reaches this point; `_requireLiveAgent` has
	 *   already thrown on the `_live` miss.
	 */
	private _requireHarnessOutsideMaintenance(
		agentId: AgentId,
		action: string,
	): WidiAgentHarness {
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
	 * Current activity, mapped straight from the harness phase.
	 *
	 * `turn` is running; `compaction` and `branch_summary` are running with a
	 * maintenance kind; `idle` is idle. The mapping only holds for a live agent:
	 * a shut-down harness also reports idle, and the `_live` miss rejects it
	 * before this point.
	 */
	getAgentActivity(agentId: AgentId): AgentActivitySnapshot {
		return toActivitySnapshot(
			this._requireLiveAgent(agentId).harness.getPhase(),
		);
	}

	/** Combine `LiveAgent`, live harness values, and the standalone projections. */
	private _snapshotAgent(liveAgent: LiveAgent): AgentSnapshot {
		const { agentId, harness } = liveAgent;
		const spawnedBy = this._spawnParent.get(agentId);
		const contextUsage = this._context.get(agentId);
		return {
			agentId,
			generation: liveAgent.generation,
			profile: liveAgent.profile,
			...(spawnedBy === undefined ? undefined : { spawnedBy }),
			...(liveAgent.sessionMetadata === undefined
				? undefined
				: { sessionMetadata: liveAgent.sessionMetadata }),
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

	/**
	 * Live agents only. A tombstone never appears here; surfaces drop their row
	 * on `agent_disposed`.
	 */
	listAgents(): AgentListResult {
		return {
			agents: Array.from(this._live.values(), (liveAgent) =>
				this._snapshotAgent(liveAgent),
			),
		};
	}

	/**
	 * Check that the three tables do not contradict each other: `_live` and
	 * `_tombstones` are disjoint, and every parent in `_spawnParent` is either
	 * live or a tombstone. For high-risk lifecycle boundaries and tests; never
	 * part of a business branch.
	 */
	private _assertRegistryInvariant(agentId?: AgentId): void {
		for (const id of agentId ? [agentId] : this._live.keys()) {
			if (this._live.has(id) && this._tombstones.has(id)) {
				throw new Error(`Agent ${id} is both live and a tombstone.`);
			}
		}
		for (const [child, parent] of this._spawnParent) {
			if (!this._live.has(parent) && !this._tombstones.has(parent)) {
				throw new Error(
					`Spawn edge ${child} -> ${parent} points at an unknown agent.`,
				);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Spawn tree traversal
	// -----------------------------------------------------------------------

	/** Walk `_spawnParent` to the root of this agent's tree. */
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

	private _agentsShareTree(
		firstAgentId: AgentId,
		secondAgentId: AgentId,
	): boolean {
		return (
			this._resolveAgentTreeRoot(firstAgentId) ===
			this._resolveAgentTreeRoot(secondAgentId)
		);
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
	 * Drop this agent's tree edge once it has no surviving descendants, then walk
	 * up dropping every ancestor tombstone edge that likewise has none.
	 *
	 * Without it the map only grows: a long session that spawns and disposes
	 * agents in a loop accumulates one dead edge per spawn.
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
	 *
	 * Validation combines both dimensions. The parent must exist, be live, not be
	 * the agent itself, and not close a cycle; `resume` and `fork` require a
	 * persistable profile because an ephemeral agent has no session, and `fork`
	 * additionally requires its source to be live right now.
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
		if (options.parent !== undefined)
			this._assertAgentCanParent(options.parent);

		const request = await this._resolveAgentBuild(options);
		// A resume that names a session another caller is already resuming waits
		// for that build instead of opening the same session twice. Tree recovery
		// hits this whenever the user resumed a child by hand first.
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
					...(request.parent === undefined
						? undefined
						: { spawnedBy: request.parent }),
				});
			}
			return agentId;
		} catch (error) {
			this._finishAgentCreation(request.agentId, reservation, undefined, error);
			throw error;
		}
	}

	/**
	 * Resolve an origin into a build request: profile, session, model, thinking
	 * level, settings snapshot, and the initial tool policy.
	 *
	 * `new` allocates a readable AgentId that avoids both tombstones and ids
	 * already recorded in the tree, then creates the session. `resume` resolves
	 * the reference and reuses the id the session recorded. `fork` forks a new
	 * session from a live source and takes the new session's id.
	 *
	 * Nothing live is registered here: the result is a plain value.
	 */
	private async _resolveAgentBuild(
		options: SpawnAgentOptions,
	): Promise<AgentBuildRequest> {
		const settings = this._captureAgentSettings(options.parent);
		if (options.origin.kind === "resume") {
			const metadata =
				typeof options.origin.reference === "string"
					? await this.sessionManager.resolveAgentSessionReference(
							options.origin.reference,
						)
					: options.origin.reference;
			const agentId = metadata.id;
			const resolvedProfile = await this._resolveResumeProfile(
				agentId,
				metadata,
			);
			const session = await this.sessionManager.resumeAgentSession({
				agentId,
				metadata,
			});
			const context =
				await this.sessionManager.buildAgentSessionContext(agentId);
			return {
				agentId,
				origin: "resume",
				resolvedProfile,
				session,
				sessionMetadata: await session.getMetadata(),
				model: options.model ?? this._resolveResumeModel(context.model),
				thinkingLevel:
					options.thinkingLevel ??
					resolveThinkingLevel(context.thinkingLevel) ??
					this._defaultThinkingLevel,
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
				options.origin.entryId === undefined
					? undefined
					: { entryId: options.origin.entryId },
			);
			await this._emit({
				type: "agent_session_forked",
				agentId: source.agentId,
				forkedSessionId: metadata.id,
				...(options.origin.entryId === undefined
					? undefined
					: { entryId: options.origin.entryId }),
				createdAt: now(),
			});
			const agentId = metadata.id;
			const session = await this.sessionManager.resumeAgentSession({
				agentId,
				metadata,
			});
			return {
				agentId,
				origin: "fork",
				// The source's exact profile, overrides included, rather than a fresh
				// resolution: a fork continues one conversation, and re-resolving could
				// hand it a profile the branch it inherits was never written under.
				resolvedProfile: {
					profile: source.resolvedProfile,
					source: source.profile.source,
					entryId: source.profile.entryId,
				},
				session,
				sessionMetadata: await session.getMetadata(),
				model: options.model ?? source.harness.getModel(),
				thinkingLevel:
					options.thinkingLevel ?? source.harness.getThinkingLevel(),
				settings,
				toolPolicy: source.toolPolicy,
				parent: options.parent,
			};
		}

		const resolvedProfile = await this._resolveCreateProfile(options.origin);
		const agentId = this._allocateAgentId(resolvedProfile.profile);
		const session = await this.sessionManager.createAgentSession({
			agentId,
			agentProfile: resolvedProfile.profile,
		});
		return {
			agentId,
			origin: "new",
			resolvedProfile,
			session,
			sessionMetadata: await session.getMetadata(),
			model: options.model ?? this._defaultModel,
			thinkingLevel: options.thinkingLevel ?? this._defaultThinkingLevel,
			settings,
			toolPolicy: {
				requestedToolNames: resolvedProfile.profile.tools,
				activeToolSelection: { mode: "default_all" },
			},
			parent: options.parent,
		};
	}

	/**
	 * Create the background attachment, runner, tools, harness, and bindings in
	 * local variables. The live registry is not touched until this succeeds.
	 *
	 * Order matters: attach background, activate the runner, apply provider
	 * contributions, resolve scoped tools against those contributions, create the
	 * harness, then bind. The reservation is re-checked after every await, and
	 * any failure or cancellation releases in the reverse order.
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
			partial.backgroundAttachment = await this._backgroundJobs.attachAgent({
				agentId,
				sessionId,
			});
			this._assertBuildNotCancelled(agentId, reservation);

			const extensionRunner = await this._createExtensionRunner(
				agentId,
				profile.id,
			);
			partial.extensionRunner = extensionRunner;
			await this._publishDiagnostics(extensionRunner.diagnostics);
			this._addAgentDiagnostics(agentId, {
				extensionDiagnostics: [...extensionRunner.diagnostics],
			});
			const blocked = extensionRunner.diagnostics.find(
				isBlockedExtensionDiagnostic,
			);
			if (blocked) throw new OrchestratorError(blocked);
			// Contributed providers register before the harness exists so their
			// models are selectable from the first turn. Model resolution for this
			// spawn already happened and cannot reference them.
			await this._applyExtensionProviderContributions(agentId, extensionRunner);
			this._assertBuildNotCancelled(agentId, reservation);

			const loaded = await this.resourceLoader.loadAgentResources(profile);
			const resourceDiagnostics = loaded.diagnostics.map((diagnostic) => ({
				...diagnostic,
				agentId,
			}));
			await this._publishDiagnostics(resourceDiagnostics);
			this._addAgentDiagnostics(agentId, { resourceDiagnostics });
			this._assertBuildNotCancelled(agentId, reservation);

			const resources: AgentResourcesSnapshot = {
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
			const systemPrompt: AgentSystemPromptFacts = {
				basePrompt: profile.systemPrompt,
				skills: loaded.skills.map(({ skill }) => skill),
				// The role's own append text is the most specific statement about this
				// agent, so it comes first; extension sections are read per turn from
				// the runner and follow.
				appendSections: profile.appendSystemPrompt
					? [profile.appendSystemPrompt]
					: [],
				contextFiles: loaded.contextFiles,
				...(profile.skillsListing === undefined
					? undefined
					: { includeSkills: profile.skillsListing }),
				// The resource loader's cwd, not the execution env's: it is the
				// project directory the file tools resolve relative paths against, and
				// the prompt has to name the same one.
				...((profile.includeCwd ?? true)
					? { cwd: this.resourceLoader.getCwd() }
					: undefined),
			};

			const resolvedTools = await this._resolveAgentToolsForBuild(
				agentId,
				profile.id,
				request.toolPolicy,
				extensionRunner,
			);
			this._assertBuildNotCancelled(agentId, reservation);

			const harness: WidiAgentHarness = new AgentHarness({
				session: request.session,
				models: this.modelRegistry.getRuntime(),
				toolContext: () => this._createToolAdapterContext(agentId, profile.id),
				streamOptions: request.settings.providerRetry,
				retry: request.settings.retry,
				tools: resolvedTools.tools,
				// A callback rather than a string, so the skills listing tracks the
				// harness's active tools at each turn start and follows an extension
				// reload that replaced the runner.
				systemPrompt: ({ activeTools }) =>
					this._composeAgentSystemPrompt(agentId, activeTools),
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
				...(request.sessionMetadata === undefined
					? undefined
					: { sessionMetadata: request.sessionMetadata }),
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

			const extensionBindings = await this._bindExtensionRunner(
				agentId,
				generation,
				harness,
				extensionRunner,
			);
			partial.extensionBindings = extensionBindings;
			liveAgent.extensionBindings = extensionBindings;

			const releaseHarnessBindings = await this._bindHarness(
				agentId,
				generation,
				harness,
			);
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
	 * Publish the agent with no await in between: allocate its generation, clear
	 * any tombstone, and record the tree edge.
	 *
	 * This is spawn's only routing cutover. Appearing in `_live` is what makes an
	 * agent routable; there is no intermediate "registered but harness pending"
	 * state for anything to observe.
	 */
	private _installLiveAgent(build: LiveAgentBuild): AgentId {
		const { liveAgent } = build;
		const { agentId } = liveAgent;
		this._agentGenerations.set(agentId, liveAgent.generation);
		// A resumed session legitimately reuses an id this runtime buried earlier.
		this._tombstones.delete(agentId);
		this._live.set(agentId, liveAgent);
		// The first idle this agent reaches has no turn behind it. Every later one
		// is stamped by whoever ended the work: a prompt run, an abort, or the
		// release of a maintenance operation.
		this._agentIdleReasons.set(agentId, "ready");
		if (build.treeRecord) {
			this._spawnParent.set(agentId, build.treeRecord.spawnedBy);
		}
		this._context.attach(agentId, liveAgent.generation);
		this._assertRegistryInvariant(agentId);
		return agentId;
	}

	/**
	 * Release a build that failed or was cancelled: detach background, dispose the
	 * candidate runner, revoke bindings, and shut the half-built harness down.
	 *
	 * `shutdown()` rather than `abort()`: this harness was never routable and
	 * never will be, but the build may already have bound interceptors or written
	 * to its session. Sealing it is closer to the truth than leaving it usable.
	 *
	 * Nothing is published, and in particular **no tombstone is written**: the
	 * agent never existed, so its AgentId stays available to a later spawn. The
	 * failure reaches the caller as the thrown error.
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
		const releaseHarnessBindings =
			build.releaseHarnessBindings ?? liveAgent?.releaseHarnessBindings;

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
				await this._disposeExtensionRunner(
					agentId,
					runner,
					bindings,
					"Agent creation failed.",
				);
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
	 * Answer every t0 handle a previous runtime left open on this session.
	 *
	 * The jobs themselves are gone - a local job is a promise in a process that
	 * exited - so this recovers the conversation, not the work: each unanswered
	 * handle gets exactly one closing message, either the outcome recorded before
	 * the exit or a cancellation explaining the restart.
	 *
	 * The session history, not the job log, decides what is unanswered: a message
	 * queued into a harness is never persisted, so acceptance is no evidence the
	 * model read it.
	 *
	 * **Session write.** `harness.appendMessage` puts this straight on the branch,
	 * which is where it belongs: the text must be in the session the moment this
	 * returns, so a second interrupted resume finds it and stays idempotent, and
	 * a resume must not start a model run nobody asked for over results that are
	 * already stale. The harness is necessarily idle here, so the write lands
	 * immediately and is ordered ahead of everything that follows on the same
	 * write tail. Called before the agent becomes routable, because a stale result
	 * arriving after that is a message, not context.
	 */
	private async _reconcileCarriedOverJobs(agentId: AgentId): Promise<void> {
		const carried = this._backgroundJobs.carriedOverJobs(agentId);
		if (carried.length === 0) return;
		const liveAgent = this._live.get(agentId);
		if (!liveAgent) return;
		const snapshot = await this.sessionManager.getAgentSessionSnapshot(agentId);
		const branchText = collectUserMessageText(snapshot.pathToRoot);
		const unanswered = carried.filter(
			(job) =>
				!branchText.some((text) =>
					text.includes(
						backgroundJobResultHeaderPrefix(job.jobId, job.toolCallId),
					),
				),
		);
		if (unanswered.length === 0) return;
		try {
			await liveAgent.harness.appendMessage({
				role: "user",
				content: [
					{
						type: "text",
						text: unanswered.map(toCarriedOverJobResultText).join("\n\n"),
					},
				],
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

	/** The parent must exist, be live, not be the child, and not close a cycle. */
	private _assertAgentCanParent(parentAgentId: AgentId): void {
		this._requireLiveAgent(parentAgentId);
	}

	private _createAgentCreationReservation(
		agentId: AgentId,
	): AgentCreationReservation {
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
		// Nobody may await this promise before `_finishAgentCreation` settles it,
		// and a rejection with no awaiter is an unhandled rejection.
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
		const settlers = reservation as unknown as {
			_settle: (agentId: AgentId) => void;
			_fail: (error: unknown) => void;
		};
		if (result === undefined) settlers._fail(error);
		else settlers._settle(result);
	}

	private _assertBuildNotCancelled(
		agentId: AgentId,
		reservation: AgentCreationReservation,
	): void {
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
	 * Dispose one agent or a whole subtree.
	 *
	 * Every target completes its `_live` removal, tombstone write, and background
	 * detach before the first await, so "is it routable" collapses to
	 * `_live.has(agentId)` and no second `disposing` set is needed. Only
	 * `intent: "removed"` writes a durable tombstone into the tree log.
	 */
	async disposeAgent(
		agentId: AgentId,
		options: DisposeAgentOptions,
	): Promise<readonly AgentId[]> {
		const targets =
			options.scope === "subtree"
				? this._collectAgentSubtreePostOrder(agentId)
				: [agentId];
		// Duplicate requests share one teardown. A subtree dispose must wait for a
		// descendant somebody else is already tearing down before it removes the
		// ancestor, which is what makes this a lookup rather than a skip.
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
			this._agentDisposals.set(target.agentId, {
				agentId: target.agentId,
				completion,
			});
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
			throw new AggregateError(
				failures,
				`Failed to dispose ${failures.length} agents in subtree ${agentId}.`,
			);
		}
		return disposed.map((target) => target.agentId);
	}

	/**
	 * Complete the cutover with no await: remove from `_live`, write
	 * `_tombstones`, cancel the delivery queue, and detach background.
	 *
	 * `_spawnParent` is not deleted here - the edge belongs to surviving
	 * descendants - and resources and system prompt vanish with the discarded
	 * `LiveAgent` rather than needing to be cleared.
	 *
	 * The detach position is the background runtime's hard contract: after the
	 * agent is marked as going away, before any other teardown.
	 *
	 * Cancelling the queue before tearing the harness down is also ordering, not
	 * taste: a cancelled queue swaps its array, which is how requeue logic
	 * decides an undeliverable message is `target_unavailable`. The other order
	 * makes those messages hit a shutdown code first and take an extra lap.
	 */
	private _cutOverDisposed(
		targets: readonly AgentId[],
		options: DisposeAgentOptions,
	): readonly DisposedLiveAgent[] {
		const disposed: DisposedLiveAgent[] = [];
		for (const agentId of targets) {
			const liveAgent = this._live.get(agentId);
			const creation = this._agentCreations.get(agentId);
			if (!liveAgent && !creation) continue;
			// A build in flight is cancelled rather than waited on: its own failure
			// path releases everything it had allocated.
			creation?.cancel();
			this._live.delete(agentId);
			if (options.intent === "removed") this._tombstones.add(agentId);
			this._messages.cancel(
				agentId,
				options.reason ??
					`Agent ${agentId} was disposed before the message was delivered.`,
			);
			this._backgroundJobs.detachAgent(agentId);
			disposed.push(liveAgent ? { agentId, liveAgent } : { agentId });
		}
		return disposed;
	}

	/**
	 * Release the harness, runner, bindings, and surrounding workflows through
	 * the references captured before the cutover. Failures record a diagnostic
	 * and never restore live routing.
	 *
	 * The harness takes two calls, and their order is part of correctness:
	 * **abort() first, then shutdown()**.
	 *
	 * - `abort()` lets the interrupted turn run its own `finally` and flush the
	 *   session writes it had buffered. It now genuinely cancels compaction and
	 *   branch summary as well, and waits for them to land.
	 * - `shutdown()` **discards** pending session writes, so it can never stand in
	 *   for `abort()`. It seals the harness and waits for every idle-time write
	 *   to reach disk.
	 *
	 * Both are idempotent: on a repeat dispose `abort()` waits for the shutdown
	 * and returns an empty result.
	 *
	 * **Constraint: shutdown() may only be disposal's tail.** `abort()` is not a
	 * tracked task, so a concurrent shutdown can clear the subscriber table
	 * before abort emits its last event, and that event is silently dropped.
	 * Today that is harmless because this disposal is the only source of
	 * concurrency and every consumer of that event checks generation against an
	 * agent already absent from `_live`. If a "seal the harness but keep the
	 * agent" use ever appears, `abort()` must first become a harness lifecycle
	 * task (or share a teardown promise with shutdown) before that use lands.
	 *
	 * `shutdown()` waits without a bound - it waits for the operation to finish,
	 * which depends on every awaited tool honouring the abort signal, and
	 * `ask_human` waiting on a real person inside a tool call is a known
	 * counter-example. The timeout here is required: on expiry it gives up
	 * waiting, records a diagnostic, and continues the teardown without restoring
	 * routing. The harness has already sealed further writes, so the cost is
	 * bounded.
	 */
	private async _disposeLiveAgent(
		disposed: DisposedLiveAgent,
		options: DisposeAgentOptions,
	): Promise<void> {
		const { agentId, liveAgent } = disposed;
		const reason = options.reason ?? `Agent disposed: ${agentId}`;

		this._humanInterrupts.forget(agentId);
		this._resolveAgentRunStartWaiters(agentId);
		this._rejectAgentIdleWaiters(
			agentId,
			`Agent ${agentId} was disposed while waiting for it to idle.`,
		);
		// A resumed session reuses this id; all of these describe the occupant
		// that just left.
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
			...(options.reason === undefined
				? undefined
				: { reason: options.reason }),
			disposedAt: now(),
		});
	}

	/**
	 * Sever every live route synchronously, then release all runtime resources.
	 *
	 * `_shutdownRequested` is set first, then in-flight creation reservations are
	 * cancelled and awaited, and only then does the full sweep run with intent
	 * `runtime_shutdown` so nothing durable is written. Any other order lets an
	 * agent finish installing after the sweep has passed it.
	 *
	 * This is not `requestShutdown()`, which only broadcasts a request to
	 * extensions. When this returns, every harness is sealed and its session
	 * writes have landed, so the process may exit - provided `_disposeLiveAgent`'s
	 * timeout caught any tool that ignores its abort signal.
	 */
	async disposeAll(reason?: string): Promise<void> {
		this._shutdownRequested = true;
		for (const reservation of [...this._agentCreations.values()]) {
			reservation.cancel();
		}
		await Promise.allSettled(
			[...this._agentCreations.values()].map(
				(reservation) => reservation.completion,
			),
		);
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
	private async _tryTeardown(
		agentId: AgentId,
		step: string,
		run: () => Promise<void>,
	): Promise<void> {
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
	 * The unified entry point for human, agent, background and system input.
	 *
	 * This overload is for the trusted shell (TUI, RPC), which may construct a
	 * `human` or `system` source. Agent identity goes through
	 * `sendMessageFromAgent`, which synthesizes the source itself.
	 */
	async sendMessage(draft: MessageDraft): Promise<MessageSendOutcome> {
		const accepted = await this._routeMessage(draft, {
			requiresIdle: false,
			awaited: false,
		});
		return accepted.kind === "blocked" ? accepted : { kind: "accepted" };
	}

	/**
	 * The human text-input entry point: the same pipeline, waiting for the
	 * assistant message the calling surface is going to render.
	 */
	async promptAgent(
		agentId: AgentId,
		text: string,
		options?: {
			readonly images?: readonly ImageContent[];
			readonly expansion?: PromptExpansion;
			readonly presentation?: ExtensionInputPresentationRecord;
		},
	): Promise<PromptOutcome> {
		const accepted = await this._routeMessage(
			{
				source: {
					kind: "human",
					...(options?.expansion === undefined
						? undefined
						: { expansion: options.expansion }),
				},
				targetAgentId: agentId,
				body: text,
				...(options?.images === undefined
					? undefined
					: { images: options.images }),
				mode: "next_turn",
			},
			{
				requiresIdle: true,
				awaited: true,
				...(options?.presentation === undefined
					? undefined
					: { presentation: options.presentation }),
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
	 * delivery queue.
	 *
	 * All of it stays in this class because every step's dependency is here:
	 * interception needs the target's runner, accounting needs its harness, and
	 * the input events need the event bus. Cutting a message domain out of it
	 * would make each message cross the boundary four times.
	 *
	 * `requiresIdle` expresses only that the caller must receive this run's
	 * assistant result, so a busy target is refused up front rather than
	 * silently becoming a follow-up whose reply nobody is waiting for.
	 */
	private async _routeMessage(
		draft: MessageDraft,
		options: RouteMessageOptions,
	): Promise<AcceptedMessage> {
		const agentId = draft.targetAgentId;
		assertMessageBody(draft.body);
		// Gate before interception and any session write: a prompt the harness
		// would reject must not emit input events or leave accounting entries with
		// no user message to pair with.
		const target = this._resolveDeliveryTarget(agentId);
		if (
			options.requiresIdle &&
			(target.phase !== "idle" || this._agentPromptRuns.has(agentId))
		) {
			throw new OrchestratorError({
				severity: "error",
				code: "orchestrator.agent_busy",
				message: `Agent ${agentId} cannot accept a prompt while ${target.phase}.`,
				agentId,
			});
		}

		const outcome = await transformMessage(draft, {
			intercept: async (event) =>
				await this._interceptExtensionInput(agentId, draft.source, event),
		});

		if (outcome.kind === "block") {
			const inputId = this._createInputId();
			await this._emit({
				type: "input_blocked",
				agentId,
				inputId,
				originalText: draft.body,
				...(outcome.reason === undefined
					? undefined
					: { reason: outcome.reason }),
				blockedBy: outcome.blockedBy,
				createdAt: now(),
			});
			return {
				kind: "blocked",
				inputId,
				...(outcome.reason === undefined
					? undefined
					: { reason: outcome.reason }),
				blockedBy: outcome.blockedBy,
			};
		}

		let inputId: string | undefined;
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
		}

		await this._writeMessageAccounting(target, {
			inputId,
			originalText: draft.body,
			...(draft.source.kind === "human" && draft.source.expansion !== undefined
				? { expansion: draft.source.expansion }
				: undefined),
			...(outcome.kind === "transform"
				? {
						transform: {
							text: outcome.text,
							transformedBy: outcome.transformedBy,
						},
					}
				: undefined),
		});

		// A job result is the one source with no caller left to hear about a
		// failure: its tool call already returned, and the model is waiting for
		// exactly one t1 that nobody else will resend. It is also the only source
		// whose messages merge, since each carries its own job header already.
		const jobSource =
			draft.source.kind === "background_job" ? draft.source : undefined;
		const pending: PendingExtensionInputPresentation | undefined =
			options.presentation
				? {
						extensionId: options.presentation.extensionId,
						presentation: validateExtensionInputPresentation(
							options.presentation.presentation,
						),
					}
				: undefined;
		const receipt = await this._messages.enqueue({
			targetAgentId: agentId,
			text: renderMessageEnvelope(draft.source, outcome.text),
			...(outcome.images === undefined
				? undefined
				: { images: outcome.images }),
			mode: draft.mode,
			requiresIdle: options.requiresIdle,
			humanInterrupt: draft.source.kind === "human",
			...(jobSource === undefined
				? undefined
				: {
						mergeKey: backgroundResultMergeKey(draft.mode),
						onDeferredFailure: (error: unknown) => {
							void this._reportDeferredDeliveryFailure(
								agentId,
								jobSource.jobId,
								error,
							);
						},
					}),
			awaited: options.awaited,
			retryOnFailure: jobSource !== undefined,
			...(pending === undefined
				? undefined
				: {
						onDeliveryStart: (method: MessageDeliveryMethod) => {
							this._beginExtensionInputPresentationDelivery(
								agentId,
								pending,
								method,
							);
						},
						onDeliveryFailure: () => {
							this._discardPendingExtensionInputPresentation(agentId, pending);
						},
					}),
		});
		return { kind: "accepted", receipt };
	}

	/**
	 * Write the entries that record what the human typed before the model saw it:
	 * the pre-expansion input of an inline command, and an extension's rewrite.
	 *
	 * **Session write.** Both go through `harness.appendCustomEntry`, which is the
	 * only supported way onto a live branch. They belong there because they are
	 * the durable half of a dual record: the user message carries the text the
	 * model actually read, and only these entries can still answer what was typed
	 * after a resume, when the surface that expanded it is long gone. Blocked
	 * input writes nothing - it never reached the model and left no state to
	 * explain.
	 *
	 * The harness's own write tail orders them ahead of the user message when the
	 * target is idle, which is the ordinary prompt case. When the target is in a
	 * turn the write buffers to the next save point and therefore lands after the
	 * steered message it describes; the entries name their `inputId` rather than
	 * relying on adjacency, so that is a display-order wrinkle, not a lost pair.
	 * There is no retraction path: a delivery that fails afterwards leaves the
	 * entry, and reaching back into a branch to remove it is exactly what the
	 * harness write surface exists to prevent.
	 */
	private async _writeMessageAccounting(
		target: DeliveryTarget,
		accounting: {
			readonly inputId: string | undefined;
			readonly originalText: string;
			readonly expansion?: PromptExpansion;
			readonly transform?: {
				readonly text: string;
				readonly transformedBy: readonly string[];
			};
		},
	): Promise<void> {
		const { expansion, transform } = accounting;
		if (!expansion && !transform) return;
		const inputId = accounting.inputId ?? this._createInputId();
		if (expansion) {
			await target.harness.appendCustomEntry(COMMAND_EXPANSION_CUSTOM_TYPE, {
				inputId,
				originalText: expansion.originalText,
				expansions: expansion.items,
			} satisfies CommandExpansionEntryData);
		}
		if (transform) {
			await target.harness.appendCustomEntry(INPUT_TRANSFORM_CUSTOM_TYPE, {
				inputId,
				originalText: accounting.originalText,
				text: transform.text,
				transformedBy: transform.transformedBy,
			} satisfies InputTransformEntryData);
		}
	}

	/**
	 * The first availability gate: the harness, its generation, and the phase read
	 * on the spot.
	 *
	 * The phase is read rather than projected because the delivery method is
	 * chosen from it and harness errors do not cover every phase - calling
	 * `followUp` on an idle target yields only a retryable `invalid_state`, which
	 * would defer the message forever.
	 */
	private _resolveDeliveryTarget(agentId: AgentId): DeliveryTarget {
		const liveAgent = this._requireLiveAgent(agentId);
		return {
			agentId,
			generation: liveAgent.generation,
			harness: liveAgent.harness,
			phase: liveAgent.harness.getPhase(),
		};
	}

	/**
	 * The delivery queue's `resolvePhase` port, re-read immediately before every
	 * attempt. `undefined` means the agent is no longer routable.
	 */
	private _resolveDeliveryPhase(agentId: AgentId): MessageDeliveryPhase {
		return this._live.get(agentId)?.harness.getPhase();
	}

	/**
	 * The delivery queue's `deliver` port: called back when this target's turn to
	 * receive a batch comes up.
	 *
	 * The method was already chosen from the phase the queue re-read; the race
	 * between reading it and calling is what the typed harness errors arbitrate,
	 * and the queue retries `busy` and `invalid_state` on the next phase change.
	 */
	private async _deliverQueuedMessage(
		request: MessageDeliveryRequest,
	): Promise<MessageDeliveryReceipt> {
		const { agentId } = request;
		const liveAgent = this._live.get(agentId);
		if (!liveAgent) {
			// Terminal for the queue, which is the point: no phase change brings a
			// routing entry back, so a message with `retryOnFailure` must not sit
			// here waiting for one. Practically unreachable - the dispose cutover
			// cancels this queue on the same tick - but a silent requeue loop is a
			// worse failure than an explicit one.
			throw new AgentHarnessError(
				"shutdown",
				`Agent ${agentId} is no longer routable.`,
			);
		}
		const { harness } = liveAgent;
		const options = request.images
			? { images: [...request.images] }
			: undefined;
		if (request.method === "prompt") {
			return await this._startPrompt(
				{
					agentId,
					generation: liveAgent.generation,
					harness,
					phase: harness.getPhase(),
				},
				request,
			);
		}
		if (request.method === "follow_up") {
			await harness.followUp(request.text, options);
			return { method: "follow_up" };
		}
		// A human steer is only "read" once the harness reports an empty steering
		// queue, so the interrupt is registered around the call that hands it over.
		const clearRevision = request.humanInterrupt
			? this._humanInterrupts.captureClearRevision(agentId)
			: undefined;
		await harness.steer(request.text, options);
		if (clearRevision !== undefined) {
			this._humanInterrupts.notifyIfUncleared(agentId, clearRevision);
		}
		return { method: "steer" };
	}

	/**
	 * Start a fresh prompt, which is the only delivery that must produce an
	 * assistant result.
	 *
	 * Acceptance waits for the harness's own `agent_start`, racing the run
	 * promise's rejection: everything the harness does before that event is
	 * asynchronous and can fail, and a failure there means the user message was
	 * never persisted. Resolving early would let the queue drop a background job
	 * t1 the model is waiting for. The phase cannot stand in for the event - it
	 * flips to `turn` on the first line of `prompt()`.
	 */
	private async _startPrompt(
		target: DeliveryTarget,
		request: MessageDeliveryRequest,
	): Promise<MessageDeliveryReceipt> {
		const { agentId, harness } = target;
		if (target.phase !== "idle" || this._agentPromptRuns.has(agentId)) {
			throw new AgentHarnessError(
				"busy",
				`Agent ${agentId} cannot accept a prompt while ${target.phase}.`,
			);
		}

		// Registered before the call, so a fast `agent_start` cannot be missed.
		const started = this._awaitAgentRunStart(agentId);
		const promptRun: AgentPromptRun = {};
		this._agentPromptRuns.set(agentId, promptRun);
		const run = harness.prompt(request.text, {
			...(request.images === undefined
				? undefined
				: { images: [...request.images] }),
		});
		// A run that settles without ever starting a loop still resolves here; the
		// alternative is waiting forever for a signal that is not coming.
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
				// `busy` rejection - another operation won the race - simply finds the
				// agent still working and re-arms.
				await this._settleAgentIdle(agentId);
			}
			throw start.error;
		}

		void this._finishPrompt(agentId, run, promptRun, {
			reportFailure: !request.awaited,
		}).catch(() => {});
		return { method: "prompt", completed: run };
	}

	/**
	 * Close out a prompt run and publish the idle edge it produced.
	 *
	 * Staleness is decided by object identity: disposal or a resumed session may
	 * have replaced this run while its promise was settling, and a stale
	 * completion must not stamp the successor's idle reason or publish its edge.
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
				// Terminal harness events have already flipped the phase to idle;
				// clearing this run is the last fact the waiters and the observable
				// edge were missing.
				await this._settleAgentIdle(agentId);
			}
		}
	}

	/**
	 * A pending observation of the target's next agent-loop start.
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
	 * An unexpected delivery failure that will be retried at the target's next
	 * phase change. Reported per attempt, so a target that never accepts is
	 * visible instead of silently accumulating messages.
	 */
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

	/**
	 * The background runtime's t1 delivery port. It hands the text to the ordinary
	 * message entry point and neither reads the job record nor decides its
	 * lifecycle.
	 */
	private async _deliverBackgroundResult(
		delivery: BackgroundJobDelivery,
	): Promise<BackgroundJobDeliveryReceipt> {
		const agentId = delivery.ownerAgentId;
		try {
			await this.sendMessage({
				source: {
					kind: "background_job",
					ownerAgentId: agentId,
					jobId: delivery.jobId,
				},
				targetAgentId: agentId,
				body: delivery.body,
				mode: "interrupt",
			});
		} catch (error) {
			// Retryable failures keep the result queued, so reaching here means the
			// owner can never take it: the model will not see this job's outcome.
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
		const harness = this._requireHarnessOutsideMaintenance(
			agentId,
			"queue a follow-up",
		);
		await harness.followUp(text, toHarnessMessageOptions(options));
	}

	/**
	 * Promote everything queued as a follow-up into steering, so it is read at the
	 * next turn boundary instead of only where the run would have stopped.
	 *
	 * This is the "I cannot wait for this" path of a message the surface already
	 * accepted: the text is in the harness, so re-sending it would deliver it
	 * twice and only the harness can take it back. It is kept rather than exposed
	 * as a bare `promoteFollowUpsToSteer` because it adds the human-interrupt
	 * coordination. Returns how many messages moved.
	 */
	async steerQueuedFollowUps(agentId: AgentId): Promise<number> {
		const harness = this._requireHarnessOutsideMaintenance(
			agentId,
			"steer queued follow-ups",
		);
		const clearRevision = this._humanInterrupts.captureClearRevision(agentId);
		const promoted = await harness.promoteFollowUpsToSteer();
		if (promoted.length > 0) {
			this._humanInterrupts.notifyIfUncleared(agentId, clearRevision);
		}
		return promoted.length;
	}

	/**
	 * End the current harness operation and settle what its cleared queues leave
	 * behind.
	 *
	 * The result comes straight from the harness; there is no aborted/running
	 * mirror to update. It can now also cancel compaction and branch summary and
	 * waits for them to land - but those two phases are refused by
	 * `_requireHarnessOutsideMaintenance`, so a user-initiated abort never reaches
	 * that capability. Disposal is what uses it.
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

	/**
	 * Whether the core delivery queue or either harness queue still holds text
	 * nobody has read.
	 */
	agentHasPendingMessages(agentId: AgentId): boolean {
		if (this._messages.hasPending(agentId)) return true;
		const liveAgent = this._live.get(agentId);
		return liveAgent ? queuedMessageCount(liveAgent.harness) > 0 : false;
	}

	/**
	 * Whether the agent can currently be treated as idle.
	 *
	 * The judgement is a join across four sources: the phase is idle, both harness
	 * queues are empty, `_messages` has nothing pending, and no prompt run started
	 * by this class is still in flight. The last one cannot be dropped - the
	 * harness sets the phase to idle inside `agent_end` and only then emits
	 * `settled`, while the `prompt()` promise still has to complete a second flush
	 * in its `finally`, leaving a short window where the phase says idle and the
	 * run has not been accounted for.
	 *
	 * It is still not a synonym for `harness.waitForIdle()`, for one remaining
	 * reason: that call now covers compaction and tree navigation, but looks at no
	 * queue at all, so a harness with a steer waiting in it reads as idle.
	 *
	 * This join spans `_live`, the harness and `_messages`, which is the direct
	 * reason the message domain cannot be a class of its own.
	 */
	isAgentIdle(agentId: AgentId): boolean {
		return this._resolveAgentIdleState(agentId).kind === "idle";
	}

	/**
	 * Wait for that combined condition to hold.
	 *
	 * It rejects rather than hanging when the agent can never reach it: disposal
	 * and a generation change both fail the wait.
	 */
	async waitForAgentIdle(
		agentId: AgentId,
		options: { readonly signal?: AbortSignal } = {},
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
	 * Idle now, never going to be, or simply still busy. A creating agent counts
	 * as busy: it is on its way to a first idle.
	 */
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
		return this._messages.hasPending(agentId)
			? { kind: "busy" }
			: { kind: "idle" };
	}

	/**
	 * Settle everything waiting on this agent's idle: the promise waiters first,
	 * then the event.
	 *
	 * Both read the one judgement in `_resolveAgentIdleState`, so a consumer that
	 * awaited `waitForAgentIdle` and one subscribed to `agent_idle` can never
	 * disagree about whether the agent stopped. Waiters go first because they are
	 * resolved synchronously and a listener may take as long as it likes.
	 *
	 * `liveJobCount` is a narrow query into the background runtime, not a term in
	 * the judgement: an unsettled job never makes its owner busy, it only tells a
	 * consumer that this idle is an agent waiting rather than an agent done.
	 */
	private async _settleAgentIdle(agentId: AgentId): Promise<void> {
		this._settleAgentIdleWaiters(agentId);
		const state = this._resolveAgentIdleState(agentId);
		if (state.kind !== "idle") {
			// Busy or gone re-arms the edge. A gone agent never publishes: its
			// disposal is a fact of its own, and an agent that stopped because it was
			// torn down did not become idle in any useful sense.
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
	 * Harness-event-driven activity edge detection: publish
	 * `agent_status_changed` and `agent_idle` when they have actually moved, and
	 * wake the delivery queue.
	 *
	 * The activity value itself comes from the harness (phase plus queue counts).
	 * The event only supplies the timing - that an edge just happened - and the
	 * causality an `AgentIdleReason` needs, which no phase carries: an abort, a
	 * `turn_end` stop reason, a maintenance release.
	 */
	private async _observeHarnessActivity(
		agentId: AgentId,
		generation: number,
		event: AgentHarnessEvent,
	): Promise<void> {
		const liveAgent = this._live.get(agentId);
		if (!liveAgent || liveAgent.generation !== generation) return;

		if (event.type === "agent_start") {
			// The loop is running, so the prompt's user message is committed to this
			// run and a pending delivery may be reported as accepted. Resolved before
			// anything is awaited, so acceptance never waits on observers.
			this._resolveAgentRunStartWaiters(agentId);
		}
		// A turn may be followed by tool execution and another turn, so it is not
		// an idle boundary. It can still say that the eventual idle was an abort.
		if (
			event.type === "turn_end" &&
			event.message.role === "assistant" &&
			event.message.stopReason === "aborted"
		) {
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
		// The loop reports its queues after every drain, so an empty steering queue
		// is the only honest evidence that the human's interrupt was read - an
		// abort clears the queue through the same event.
		if (event.type === "queue_update" && event.steer.length === 0) {
			this._humanInterrupts.clear(agentId);
		}

		await this._publishAgentActivityEdge(agentId, liveAgent.harness.getPhase());
		// Every harness event can change the delivery phase, so re-examine the
		// queue: this is what resumes a message deferred during maintenance or
		// retried after a busy race.
		this._messages.wake(agentId);
		await this._settleAgentIdle(agentId);

		// Auto-compaction rides the settled fact: the harness is idle and its
		// pending session writes are flushed, so the branch and the last assistant
		// usage are durable. A settled with queued next turns is skipped - the next
		// run starts immediately and compaction would race its own idle check.
		if (event.type === "settled" && event.nextTurnCount === 0) {
			// The measurement walks the branch, so it runs once here and its result
			// is handed to the trigger rather than read a second time.
			const contextTokens = await this._context.refresh(agentId);
			await this._maybeAutoCompact(agentId, contextTokens);
		}
	}

	/**
	 * Publish `agent_status_changed` when the phase-derived activity differs from
	 * the last one published for this agent.
	 */
	private async _publishAgentActivityEdge(
		agentId: AgentId,
		phase: AgentHarnessPhase,
	): Promise<void> {
		const activity = toActivitySnapshot(phase);
		const previous = this._publishedAgentActivities.get(agentId);
		if (
			previous?.activity === activity.activity &&
			previous.maintenance === activity.maintenance
		) {
			return;
		}
		this._publishedAgentActivities.set(agentId, activity);
		await this._emit({
			type: "agent_status_changed",
			agentId,
			...(previous === undefined
				? undefined
				: { previousActivity: previous.activity }),
			activity: activity.activity,
			...(activity.maintenance === undefined
				? undefined
				: { maintenance: activity.maintenance }),
			changedAt: now(),
		});
	}

	// -----------------------------------------------------------------------
	// Extension input presentations
	//
	// A presentation is delivered before the message it describes exists as a
	// session entry, so it waits in a short per-target queue and is paired on the
	// harness `session_write` event, which carries the persisted entry and its id
	// together.
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
		// A requeued delivery re-enters here; move it to the tail rather than
		// leaving a duplicate that would pair with someone else's message.
		this._discardPendingExtensionInputPresentation(agentId, pending);
		pending.method = method;
		const presentations =
			this._pendingExtensionInputPresentations.get(agentId) ?? [];
		presentations.push(pending);
		this._pendingExtensionInputPresentations.set(agentId, presentations);
	}

	/**
	 * Pop the presentation belonging to the user message that was just persisted.
	 *
	 * Delivery order is the pairing rule, which is what makes this exact: the
	 * queue serializes per target, so the head of this list is the presentation of
	 * the oldest delivery still awaiting a write. The old fallbacks - guessing by
	 * expected text, and scanning the session backwards by object identity - are
	 * both gone.
	 */
	private _takePendingExtensionInputPresentation(
		agentId: AgentId,
	): PendingExtensionInputPresentation | undefined {
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
	 * Drop the presentations of everything an abort cleared.
	 *
	 * The steer and follow-up queues are emptied wholesale, so nothing delivered
	 * that way will ever be written. A `prompt` delivery is left alone: its user
	 * message was persisted at run start, and an abort does not take it back.
	 */
	private _discardQueuedExtensionInputPresentations(agentId: AgentId): void {
		const presentations = this._pendingExtensionInputPresentations.get(agentId);
		if (!presentations) return;
		const remaining = presentations.filter(
			(pending) => pending.method === "prompt",
		);
		if (remaining.length === 0) {
			this._pendingExtensionInputPresentations.delete(agentId);
		} else {
			this._pendingExtensionInputPresentations.set(agentId, remaining);
		}
	}

	/**
	 * The messaging half of the harness `session_write` observer.
	 *
	 * Two facts arrive through this one event. A persisted user message pairs with
	 * the presentation waiting for it, and the presentation entry written in
	 * response comes back through here with the id its own event needs - which is
	 * why nothing depends on `appendCustomEntry`'s return value: it is undefined
	 * whenever the write was buffered behind a running turn, and that is the
	 * common case.
	 */
	private async _observeSessionWrite(
		agentId: AgentId,
		entryId: string,
		write: PendingSessionWrite,
	): Promise<void> {
		if (write.type === "message" && write.message.role === "user") {
			const pending = this._takePendingExtensionInputPresentation(agentId);
			if (pending) {
				await this._commitExtensionInputPresentation(agentId, entryId, pending);
			}
			return;
		}
		if (
			write.type !== "custom" ||
			write.customType !== EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE
		) {
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
	 * Persist the presentation that explains how to render a message an extension
	 * just sent in.
	 *
	 * **Session write.** `harness.appendCustomEntry` is the only supported way
	 * onto the branch, and the branch is where this belongs: it names its user
	 * message by entry id, so a client hydrating the session later renders that
	 * message exactly as the live client did. It never becomes model context.
	 * The `extension_input_presented` event is published from the write's own
	 * `session_write`, not from here.
	 */
	private async _commitExtensionInputPresentation(
		agentId: AgentId,
		messageEntryId: string,
		pending: PendingExtensionInputPresentation,
	): Promise<void> {
		const liveAgent = this._live.get(agentId);
		if (!liveAgent) return;
		try {
			await liveAgent.harness.appendCustomEntry(
				EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE,
				{
					messageEntryId,
					extensionId: pending.extensionId,
					presentation: pending.presentation,
				} satisfies ExtensionInputPresentationEntryData,
			);
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
	 * Run compaction and invalidate the context-usage projection it obsoletes.
	 *
	 * Compaction replaces the branch the cached measurement described, and the
	 * retained tail carries the pre-compaction assistant usage, so re-measuring
	 * here would report the old number as if it were current. Drop it instead;
	 * the next settled measures the new branch.
	 */
	async compactAgent(
		agentId: AgentId,
		customInstructions?: string,
	): Promise<CompactResult> {
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
		const previousLeafId =
			await this.sessionManager.getAgentSessionLeafId(agentId);
		try {
			return await this._runMaintenanceOperation(
				agentId,
				async (harness) => await harness.navigateTree(targetId, options),
			);
		} finally {
			// A post-move observer can fail after the harness changed the leaf.
			// Comparing in `finally` keeps that path invalidating the old gauge,
			// while cancellation and no-op navigation leave it intact.
			if (
				(await this.sessionManager.getAgentSessionLeafId(agentId)) !==
				previousLeafId
			) {
				await this._context.invalidate(agentId);
			}
		}
	}

	/**
	 * Run a harness operation that occupies the agent without driving an agent
	 * loop (compaction, tree navigation).
	 *
	 * Concurrency is refused by the harness itself - both operations require an
	 * idle phase - so there is no orchestrator-side maintenance table. What is
	 * left here is publishing the activity edges, invalidating nothing, and
	 * stamping the released idle as `maintenance`.
	 *
	 * The order is part of correctness: **start the harness operation first, then
	 * await the edge publication**. `compact()` and `navigateTree()` flip the
	 * phase on their first synchronous line, so publishing first would leave a
	 * window where the event says maintenance and the phase still says idle - and
	 * a steer landing in that window would pass the phase guard. When the
	 * publication in between throws, the already-started promise must be caught
	 * explicitly before rethrowing, or it becomes an unhandled rejection.
	 */
	private async _runMaintenanceOperation<T>(
		agentId: AgentId,
		operation: (harness: WidiAgentHarness) => Promise<T>,
	): Promise<T> {
		const harness = this._requireLiveAgent(agentId).harness;
		const running = operation(harness);
		// Read after the call, for the same reason the call comes first: this is
		// what tells an operation that started from one the harness refused because
		// it was already busy.
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
				// No agent loop ran, so there is no new assistant message - but the
				// busy-to-idle edge really happened and has to be published, or a
				// `waitForAgentIdle` caller misses it entirely.
				this._agentIdleReasons.set(agentId, "maintenance");
				await this._publishAgentActivityEdge(agentId, harness.getPhase());
				this._messages.wake(agentId);
				await this._settleAgentIdle(agentId);
			}
		}
	}

	/**
	 * Threshold trigger for automatic compaction.
	 *
	 * Failure is a warning diagnostic, never a thrown error: an uncompactable
	 * over-threshold session keeps running until the provider rejects it, which is
	 * what happened before this trigger existed.
	 */
	private async _maybeAutoCompact(
		agentId: AgentId,
		contextTokens: number | undefined,
	): Promise<void> {
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
}

/**
 * How long a dispose waits for `shutdown()` before giving up on it. The wait is
 * otherwise unbounded, because it depends on tools honouring their abort signal.
 */
const AGENT_SHUTDOWN_TIMEOUT_MS = 10_000;

async function withTimeout(
	work: Promise<void>,
	timeoutMs: number,
	message: string,
): Promise<void> {
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
function toMaintenanceKind(
	phase: AgentHarnessPhase,
): AgentMaintenanceKind | undefined {
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

/** The harness takes a mutable image array; the orchestrator passes readonly ones. */
function toHarnessMessageOptions(
	options: { readonly images?: readonly ImageContent[] } | undefined,
): { images: ImageContent[] } | undefined {
	return options?.images ? { images: [...options.images] } : undefined;
}

/**
 * An extension that failed to load hard enough to block the build. Severity is
 * the whole test: a warning describes a degraded extension, an error describes
 * one the agent cannot run without.
 */
function isBlockedExtensionDiagnostic(
	diagnostic: OrchestratorDiagnostic,
): boolean {
	return diagnostic.severity === "error";
}

/** A thinking level recorded in a session, rejected rather than coerced. */
function resolveThinkingLevel(level: string): ThinkingLevel | undefined {
	const parsed = parseThinkingLevel(level);
	return parsed === level ? parsed : undefined;
}

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
			...(job.stopReason === undefined
				? undefined
				: { stopReason: job.stopReason }),
		})
	);
}

function now(): string {
	return new Date().toISOString();
}
