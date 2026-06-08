/**
 * AgentOrchestrator - Core abstraction for orchestrating multiple agents lifecycle and sessions management.
 * 
 * This Class is shared between all run modes (interactive, print, rpc).
 */
import type {
  AgentHarness,
  AgentHarnessEvent,
  ExecutionEnv,
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
  MailboxManager,
} from "./mailbox-manager.js";
import {
  ResourceLoader,
} from "./resource-loader.js";
import type {
  AgentId,
} from "./types.js";

export type OrchestratorEvent = 
  | { readonly type: "agent_harness_event"; agentId: AgentId; event: AgentHarnessEvent }

export type OrchestratorEventListener = (event: OrchestratorEvent) => Promise<void> | void;

export interface AgentOrchestratorConfigs {
  executionEnv: ExecutionEnv;
  resourceLoader: ResourceLoader;
  persistenceManager: PersistenceManager;
  settingManager: SettingManager;
  mailboxManager: MailboxManager;
}

export interface SpawnAgentHarnessOptions {
  profile: AgentProfile;
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
  readonly mailboxManager: MailboxManager;

  private _unscribeAgentHarness: Map<AgentId, () => Promise<void> | void> = new Map();
  private _eventListeners: OrchestratorEventListener[] = [];

  constructor(config: AgentOrchestratorConfigs) {
    this.executionEnv = config.executionEnv;
    this.resourceLoader = config.resourceLoader;
    this.persistenceManager = config.persistenceManager;
    this.settingManager = config.settingManager;
    this.mailboxManager = config.mailboxManager;
  }

  async spawnAgentHarness(options: SpawnAgentHarnessOptions) {
    let agentId = this._allocateAgentId(options.profile);
    const agentProfile = options.profileOverrride ? { ...options.profile, ...options.profileOverrride } : options.profile;
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

  private async _loadSessionRepo()
}