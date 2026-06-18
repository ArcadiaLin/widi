/**
 * AgentOrchestrator - Core abstraction for orchestrating multiple agents lifecycle and sessions management.
 * 
 * This Class is shared between all run modes (interactive, print, rpc).
 */
import {
  type Model,
} from "@earendil-works/pi-ai"
import {
  AgentHarness,
  type AgentHarnessEvent,
  type AgentHarnessResources,
  type AgentTool,
  type ExecutionEnv,
  type Session,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
  AgentProfile,
} from "./agent-profile.js";
import {
  type AgentSessionMetadata,
  SessionManager,
} from "./session-manager.ts";
import {
  SettingManager,
} from "./setting-manager.js";
import {
  ResourceLoader,
} from "./resource-loader.js";
import {
  type ModelRegistry,
} from "./model-registry.js";
import type {
  ExtendedJsonlSessionMetadata,
} from "../storage/jsonl-repo.ts";

export type OrchestratorEvent = 
  | { readonly type: "agent_harness_event"; agentId: AgentId; event: AgentHarnessEvent }
  | { readonly type: "agent_spawned"; agentId: AgentId; profile: AgentProfile; model: Model<any> }
  | { readonly type: "agent_resumed"; agentId: AgentId; profile: AgentProfile; model: Model<any> }
  | {
    readonly type: "agent_profile_missing";
    agentId: AgentId;
    missingProfileId: string;
    missingProfileLabel?: string;
    fallbackProfileId: string;
  }

export type OrchestratorEventListener = (event: OrchestratorEvent) => Promise<void> | void;
export type AgentProfileResolver = (profileId: string) => AgentProfile | undefined | Promise<AgentProfile | undefined>;

export interface AgentOrchestratorConfigs {
  executionEnv: ExecutionEnv;
  resourceLoader: ResourceLoader;
  sessionManager: SessionManager;
  settingManager: SettingManager;
  modelRegistry: ModelRegistry;
  defaultProfile: AgentProfile;
  defaultModel: Model<any>;
  resolveProfile?: AgentProfileResolver;
}

export type AgentId = string;

interface SpawnAgentHarnessCommonOptions {
  model?: Model<any>;
  inheritModelFromAgentId?: AgentId;
  tools?: AgentTool[];
}

export interface SpawnAgentHarnessCreateOptions extends SpawnAgentHarnessCommonOptions {
  resume?: false;
  profile?: AgentProfile;
  profileOverride?: Partial<AgentProfile>;
}

export interface SpawnAgentHarnessResumeOptions extends SpawnAgentHarnessCommonOptions {
  resume: true;
  metadata: ExtendedJsonlSessionMetadata;
}

export type SpawnAgentHarnessOptions = SpawnAgentHarnessCreateOptions | SpawnAgentHarnessResumeOptions;

export interface SpawnAgentHarnessResult {
  agentId: AgentId;
  harness: AgentHarness;
}

export class AgentOrchestrator {
  private _defaultModel: Model<any>;
  private _defaultProfile: AgentProfile;
  readonly agents: Map<AgentId, AgentHarness> = new Map();
  readonly executionEnv: ExecutionEnv;
  readonly resourceLoader: ResourceLoader;
  readonly sessionManager: SessionManager;
  readonly settingManager: SettingManager;
  readonly modelRegistry: ModelRegistry;
  private readonly _resolveProfile?: AgentProfileResolver;

  private _unsubscribeAgentHarness: Map<AgentId, () => void> = new Map();
  private _eventListeners: Set<OrchestratorEventListener> = new Set();

  constructor(config: AgentOrchestratorConfigs) {
    this.executionEnv = config.executionEnv;
    this.resourceLoader = config.resourceLoader;
    this.sessionManager = config.sessionManager;
    this.settingManager = config.settingManager;
    this.modelRegistry = config.modelRegistry;
    this._defaultProfile = config.defaultProfile;
    this._defaultModel = config.defaultModel;
    this._resolveProfile = config.resolveProfile;
  }

  async spawnAgentHarness(options: SpawnAgentHarnessOptions = {}): Promise<SpawnAgentHarnessResult> {
    if (options.resume) {
      return await this._resumeAgentHarness(options);
    }

    const baseProfile = options.profile ?? this._defaultProfile;
    const agentProfile = options.profileOverride ? { ...baseProfile, ...options.profileOverride } : baseProfile;
    const model = this._resolveSpawnModel(options);
    return await this._createAgentHarness(agentProfile, options.tools ?? [], model);
  }

  getDefaultModel(): Model<any> {
    return this._defaultModel;
  }

  setDefaultModel(model: Model<any>): void {
    this._defaultModel = model;
  }

  getDefaultProfile(): AgentProfile {
    return this._defaultProfile;
  }

  setDefaultProfile(profile: AgentProfile): void {
    this._defaultProfile = profile;
  }

  getAgentHarness(agentId: AgentId): AgentHarness | undefined {
    return this.agents.get(agentId);
  }

  async setAgentModel(agentId: AgentId, model: Model<any>): Promise<void> {
    const harness = this.agents.get(agentId);
    if (!harness) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    await harness.setModel(model);
  }

  subscribe(listener: OrchestratorEventListener): () => void {
    this._eventListeners.add(listener);
    return () => this._eventListeners.delete(listener);
  }

  subscribeAgent(agentId: AgentId, listener: OrchestratorEventListener): () => void {
    return this.subscribe((event) => {
      if ("agentId" in event && event.agentId === agentId) {
        return listener(event);
      }
    });
  }

  private _allocateAgentId(profile: AgentProfile): AgentId {
    const base = profile.label.trim().toLocaleLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
    let agentId: AgentId = base;
    let suffix = 2;

    while (this.agents.has(agentId)) {
      agentId = `${base}-${suffix}`;
      suffix += 1;
    }

    return agentId;
  }

  private _resolveSpawnModel(options: SpawnAgentHarnessOptions): Model<any> {
    if (options.model) {
      return options.model;
    }

    if (options.inheritModelFromAgentId) {
      const sourceHarness = this.agents.get(options.inheritModelFromAgentId);
      if (!sourceHarness) {
        throw new Error(`Cannot inherit model from unknown agent: ${options.inheritModelFromAgentId}`);
      }
      return sourceHarness.getModel();
    }

    return this._defaultModel;
  }

  private async _resolveResumeProfile(agentId: AgentId, metadata: ExtendedJsonlSessionMetadata): Promise<AgentProfile> {
    const profileReference = metadata.metadata?.profile;
    if (!profileReference?.id) {
      return this._defaultProfile;
    }

    const resolvedProfile = await this._resolveProfile?.(profileReference.id);
    if (resolvedProfile) {
      return resolvedProfile;
    }

    if (profileReference.id !== this._defaultProfile.id) {
      await this._emit({
        type: "agent_profile_missing",
        agentId,
        missingProfileId: profileReference.id,
        missingProfileLabel: profileReference.label,
        fallbackProfileId: this._defaultProfile.id,
      });
    }
    return this._defaultProfile;
  }

  private _resolveResumeModel(options: SpawnAgentHarnessResumeOptions, contextModel: { provider: string; modelId: string } | null): Model<any> {
    if (options.model || options.inheritModelFromAgentId) {
      return this._resolveSpawnModel(options);
    }

    if (!contextModel) {
      return this._defaultModel;
    }

    const model = this.modelRegistry.find(contextModel.provider, contextModel.modelId);
    if (!model) {
      throw new Error(`Cannot resume model ${contextModel.provider}/${contextModel.modelId}: model is not registered.`);
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
    throw new Error(`Cannot resume session with invalid thinking level: ${level}`);
  }

  private async _createAgentHarness(
    profile: AgentProfile,
    tools: AgentTool[] = [],
    model: Model<any>,
  ): Promise<SpawnAgentHarnessResult> {
    const agentId = this._allocateAgentId(profile);
    const session = await this.sessionManager.createAgentSession({
      agentId: agentId,
      agentProfile: profile
    });

    const harness = await this._buildAgentHarness({
      agentId,
      profile,
      session,
      tools,
      model,
    });
    await this._emit({ type: "agent_spawned", agentId, profile, model });
    return { agentId, harness };
  }

  private async _resumeAgentHarness(options: SpawnAgentHarnessResumeOptions): Promise<SpawnAgentHarnessResult> {
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
    const context = await session.buildContext();
    const model = this._resolveResumeModel(options, context.model);
    const harness = await this._buildAgentHarness({
      agentId,
      profile,
      session,
      tools: options.tools ?? [],
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
    tools: AgentTool[];
    model: Model<any>;
    thinkingLevel?: ThinkingLevel;
    activeToolNames?: string[];
  }): Promise<AgentHarness> {
    const { agentId, profile, session, tools, model } = options;
    const LoadedSkill = await this.resourceLoader.loadSkills(profile.skills);
    const LoadedPromptTemplate = await this.resourceLoader.loadPromptTemplates(profile.promptTemplates);

    const resources: AgentHarnessResources = {
      // this step ignore thie "ResourceSource", may be has any other usage;
      skills: LoadedSkill.skills.map(({ skill }) => skill),
      promptTemplates: LoadedPromptTemplate.promptTemplates.map(({ promptTemplate }) => promptTemplate),
    }

    // resourceLoader also return a resource diagnostics, so todo is dealing with diagnostics
    // such as _dealDisgnostics()
    // const resourceDiagnostics = {

    // }

    const harness = new AgentHarness({
      env: this.executionEnv,
      session: session,
      resources: resources,
      tools: tools,
      systemPrompt: profile.systemPrompt,
      model: model,
      thinkingLevel: options.thinkingLevel,
      activeToolNames: options.activeToolNames,
      getApiKeyAndHeaders: async (requestModel) => {
        const result = await this.modelRegistry.getApiKeyAndHeaders(requestModel);
        if (!result.ok) {
          throw new Error(result.error);
        }
        return result.apiKey || result.headers ? { apiKey: result.apiKey ?? "", headers: result.headers } : undefined;
      },
    })
    this.agents.set(agentId, harness);
    this._unsubscribeAgentHarness.set(agentId, harness.subscribe((event) => {
      void this._emit({ type: "agent_harness_event", agentId, event });
    }));
    return harness;
  }

  private async _emit(event: OrchestratorEvent): Promise<void> {
    for (const listener of this._eventListeners) {
      await listener(event);
    }
  }
}
