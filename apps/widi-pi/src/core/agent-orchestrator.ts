/**
 * AgentOrchestrator - Core abstraction for orchestrating multiple agents lifecycle and sessions management.
 * 
 * This Class is shared between all run modes (interactive, print, rpc).
 */
import {
  Model
} from "@earendil-works/pi-ai"
import {
  AgentHarness,
  AgentHarnessOptions,
  AgentHarnessEvent,
  ExecutionEnv,
  AgentHarnessResources,
  type Session,
  type SessionMetadata,
} from "@earendil-works/pi-agent-core";
import type {
  AgentProfile,
} from "./agent-profile.js";
import {
  ExtensionRunner,
} from "./extension-runner.js";
import {
  PersistenceManager,
} from "./persistence-manager.js";
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
  ModelRegistry,
} from "./model-registry.js";

export type OrchestratorEvent = 
  | { readonly type: "agent_harness_event"; agentId: AgentId; event: AgentHarnessEvent }

export type OrchestratorEventListener = (event: OrchestratorEvent) => Promise<void> | void;

export interface AgentOrchestratorConfigs {
  executionEnv: ExecutionEnv;
  resourceLoader: ResourceLoader;
  persistenceManager: PersistenceManager;
  settingManager: SettingManager;
  modelRegistry: ModelRegistry;
}

export interface SpawnAgentHarnessOptions {
  profile: AgentProfile;
  resume?: boolean;
  /**
   * yet not implemented, whether to focus this agent after spawn, default to false
   */
  focus?: boolean;
  profileOverrride?: Partial<AgentProfile>;
}

export class AgentOrchestrator {
  private _focusAgentId: AgentId | null = null;
  readonly agents: Map<AgentId, AgentHarness> = new Map();
  readonly executionEnv: ExecutionEnv;
  readonly resourceLoader: ResourceLoader;
  readonly persistenceManager: PersistenceManager;
  readonly settingManager: SettingManager;

  private _unscribeAgentHarness: Map<AgentId, () => Promise<void> | void> = new Map();
  private _eventListeners: OrchestratorEventListener[] = [];

  constructor(config: AgentOrchestratorConfigs) {
    this.executionEnv = config.executionEnv;
    this.resourceLoader = config.resourceLoader;
    this.persistenceManager = config.persistenceManager;
    this.settingManager = config.settingManager;
  }

  async spawnAgentHarness(options: SpawnAgentHarnessOptions) {
    const agentProfile = options.profileOverrride ? { ...options.profile, ...options.profileOverrride } : options.profile;
    // phase 1 - create not resume
    if (!options.resume) {
      // Implementation for creating a new agent harness
    }
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

  private async _createAgentHarness(
    profile: AgentProfile,
    tools: any = [],
    model: Model<any>,
  ): Promise<AgentHarness> {
    const agentId = this._allocateAgentId(profile);
    const LoadedSkill = await this.resourceLoader.loadSkills(profile.skills);
    const LoadedPromptTemplate = await this.resourceLoader.loadPromptTemplates(profile.promptTemplates);

    const resources: AgentHarnessResources = {
      // this step ignore thie "ResourceSource", may be has any other usage;
      skills: LoadedSkill.skills.map(({ skill }) => skill),
      promptTemplates: LoadedPromptTemplate.promptTemplates.map(({ promptTemplate }) => promptTemplate),
    }

    const session = await this.persistenceManager.createAgentSession({
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
    })
    return harness;
  }
}