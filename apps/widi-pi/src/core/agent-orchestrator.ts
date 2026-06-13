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
} from "@earendil-works/pi-agent-core";
import type {
  AgentProfile,
} from "./agent-profile.js";
import {
  SessionManager,
} from "./session-manager.ts";
import {
  SettingManager,
} from "./setting-manager.js";
import {
  ResourceLoader,
} from "./resource-loader.js";
import type {
  AgentId,
} from "./types.js";
import {
  type ModelRegistry,
} from "./model-registry.js";

export type OrchestratorEvent = 
  | { readonly type: "agent_harness_event"; agentId: AgentId; event: AgentHarnessEvent }
  | { readonly type: "agent_spawned"; agentId: AgentId; profile: AgentProfile; model: Model<any> }

export type OrchestratorEventListener = (event: OrchestratorEvent) => Promise<void> | void;

export interface AgentOrchestratorConfigs {
  executionEnv: ExecutionEnv;
  resourceLoader: ResourceLoader;
  sessionManager: SessionManager;
  settingManager: SettingManager;
  modelRegistry: ModelRegistry;
  defaultProfile: AgentProfile;
  defaultModel: Model<any>;
}

export interface SpawnAgentHarnessOptions {
  profile?: AgentProfile;
  model?: Model<any>;
  inheritModelFromAgentId?: AgentId;
  resume?: boolean;
  profileOverride?: Partial<AgentProfile>;
  tools?: AgentTool[];
}

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
  }

  async spawnMainAgentHarness(options: Omit<SpawnAgentHarnessOptions, "profile"> = {}): Promise<SpawnAgentHarnessResult> {
    return await this.spawnAgentHarness({ ...options, profile: this._defaultProfile, model: options.model ?? this._defaultModel });
  }

  async spawnAgentHarness(options: SpawnAgentHarnessOptions = {}): Promise<SpawnAgentHarnessResult> {
    if (options.resume) {
      throw new Error("Resuming agent harness sessions is not implemented yet.");
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

  private async _createAgentHarness(
    profile: AgentProfile,
    tools: AgentTool[] = [],
    model: Model<any>,
  ): Promise<SpawnAgentHarnessResult> {
    const agentId = this._allocateAgentId(profile);
    const LoadedSkill = await this.resourceLoader.loadSkills(profile.skills);
    const LoadedPromptTemplate = await this.resourceLoader.loadPromptTemplates(profile.promptTemplates);

    const resources: AgentHarnessResources = {
      // this step ignore thie "ResourceSource", may be has any other usage;
      skills: LoadedSkill.skills.map(({ skill }) => skill),
      promptTemplates: LoadedPromptTemplate.promptTemplates.map(({ promptTemplate }) => promptTemplate),
    }

    const session = await this.sessionManager.createAgentSession({
      agentId: agentId,
      agentProfile: profile
    });
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
    await this._emit({ type: "agent_spawned", agentId, profile, model });
    return { agentId, harness };
  }

  private async _emit(event: OrchestratorEvent): Promise<void> {
    for (const listener of this._eventListeners) {
      await listener(event);
    }
  }
}
