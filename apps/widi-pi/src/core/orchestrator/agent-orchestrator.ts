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
import {
	AgentHarness,
	AgentHarnessError,
	type AgentHarnessPhase,
	type ExecutionEnv,
	type JsonlSessionMetadata,
	type Session,
	type SessionTreeEntry,
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
import type { ExtensionInputPresentation } from "../extension/presentation.ts";
import { ExtensionStatusRegistry } from "../extension/status-registry.ts";
import { HumanInterruptRegistry } from "../human-interrupt.ts";
import { HumanRequestBroker } from "../human-request.ts";
import {
	type MessageDeliveryMethod,
	MessageDeliveryQueue,
	type MessageDeliveryReceipt,
} from "../message.ts";
import { type ModelRegistry, parseThinkingLevel } from "../model-registry.js";
import type { ResourceLoader } from "../resource-loader.js";
import type {
	AgentSessionCandidate,
	AgentSessionMetadata,
	SessionManager,
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
 */
interface PendingExtensionInputPresentation
	extends ExtensionInputPresentationRecord {
	method?: MessageDeliveryMethod;
	entryId?: string;
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

	private _nextInputId = 1;

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
