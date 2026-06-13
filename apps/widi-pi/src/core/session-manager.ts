/**
 * SessionManager owns session repositories used by AgentOrchestrator.
 *
 * Pi's JsonlSessionRepo writes the session metadata/header line when create()
 * is called. After that, AgentHarness writes through the returned Session; WIDI
 * should not manage JsonlSessionStorage directly.
 */

import type {
  FileSystem,
  JsonlSessionMetadata,
  Session,
  SessionMetadata,
} from "@earendil-works/pi-agent-core";
import {
  InMemorySessionRepo,
  JsonlSessionRepo,
} from "@earendil-works/pi-agent-core";
import type {
  AgentId,
} from "./types.ts";
import type {
  AgentProfile,
} from "./agent-profile.ts";

export interface SessionManagerConfigs {
  fs: FileSystem;
  cwd: string;
  sessionsRoot: string;
}

type CreateAgentSessionOptions = {
  agentId: AgentId;
  agentProfile: AgentProfile;
  parentSessionPath?: string;
}

type ResumeAgentSessionOptions = {
  agentId: AgentId;
  metadata: JsonlSessionMetadata;
}

export class SessionManager {
  readonly sessionRepo: JsonlSessionRepo;
  private readonly _cwd: string;
  private readonly _agentSessions: Map<AgentId, Session<SessionMetadata>> = new Map();
  private readonly _memorySessionRepo: InMemorySessionRepo = new InMemorySessionRepo();

  constructor(config: SessionManagerConfigs) {
    this._cwd = config.cwd;
    this.sessionRepo = new JsonlSessionRepo({
      fs: config.fs,
      sessionsRoot: config.sessionsRoot,
    });
  }

  async createAgentSession(options: CreateAgentSessionOptions): Promise<Session<SessionMetadata>> {
    const cachedSession = this._agentSessions.get(options.agentId);
    if (cachedSession) {
      return cachedSession;
    }

    const session = options.agentProfile.persist
      ? await this._createPersistentAgentSession(options)
      : await this._createEphemeralAgentSession(options.agentId);
    this._agentSessions.set(options.agentId, session);
    return session;
  }

  async resumeAgentSession(options: ResumeAgentSessionOptions): Promise<Session<SessionMetadata>> {
    return this._agentSessions.get(options.agentId) ?? await this.sessionRepo.open(options.metadata);
  }

  private async _createPersistentAgentSession(options: CreateAgentSessionOptions): Promise<Session<JsonlSessionMetadata>> {
    // TODO: Add file locking before multiple WIDI processes can write the same sessionsRoot.
    // TODO: Add extension persistence once extension lifecycle and storage boundaries are defined.
    return this.sessionRepo.create({
      id: options.agentId,
      cwd: this._cwd,
      parentSessionPath: options.parentSessionPath,
    });
  }

  private async _createEphemeralAgentSession(agentId: AgentId): Promise<Session<SessionMetadata>> {
    return this._memorySessionRepo.create({ id: agentId });
  }
}
