/**
 * SessionManager owns session repositories used by AgentOrchestrator.
 *
 * The local JSONL adapter keeps Pi session tree semantics intact and only
 * extends the session header with metadata needed to rebuild harness context.
 */

import type {
  FileSystem,
  Session,
  SessionMetadata,
} from "@earendil-works/pi-agent-core";
import {
  InMemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
	JsonlSessionRepo,
  type ExtendedJsonlSessionMetadata,
  type JsonlSessionPathLayout,
} from "../storage/jsonl-repo.ts";
import type {
  AgentId,
} from "./types.ts";
import type {
  AgentProfile,
} from "./agent-profile.ts";
import {
  toAgentProfileReference,
} from "./agent-profile.ts";

export type AgentSessionMetadata = SessionMetadata | ExtendedJsonlSessionMetadata;

export interface SessionManagerConfigs {
  fs: FileSystem;
  cwd: string;
  sessionsRoot: string;
  sessionPathLayout?: JsonlSessionPathLayout;
}

type CreateAgentSessionOptions = {
  agentId: AgentId;
  agentProfile: AgentProfile;
  parentSessionPath?: string;
}

type ResumeAgentSessionOptions = {
  agentId: AgentId;
  metadata: ExtendedJsonlSessionMetadata;
}

export class SessionManager {
  readonly sessionRepo: JsonlSessionRepo;
  private readonly _cwd: string;
  private readonly _agentSessions: Map<AgentId, Session<AgentSessionMetadata>> = new Map();
  private readonly _memorySessionRepo: InMemorySessionRepo = new InMemorySessionRepo();

  constructor(config: SessionManagerConfigs) {
    this._cwd = config.cwd;
    this.sessionRepo = new JsonlSessionRepo({
      fs: config.fs,
      sessionsRoot: config.sessionsRoot,
      pathLayout: config.sessionPathLayout,
    });
  }

  async createAgentSession(options: CreateAgentSessionOptions): Promise<Session<AgentSessionMetadata>> {
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

  async resumeAgentSession(options: ResumeAgentSessionOptions): Promise<Session<AgentSessionMetadata>> {
    const cachedSession = this._agentSessions.get(options.agentId);
    if (cachedSession) {
      return cachedSession;
    }
    const session = await this.sessionRepo.open(options.metadata);
    this._agentSessions.set(options.agentId, session);
    return session;
  }

  private async _createPersistentAgentSession(options: CreateAgentSessionOptions): Promise<Session<ExtendedJsonlSessionMetadata>> {
    // TODO: Add file locking before multiple WIDI processes can write the same sessionsRoot.
    // TODO: Add extension persistence once extension lifecycle and storage boundaries are defined.
    return this.sessionRepo.create({
      id: options.agentId,
      cwd: this._cwd,
      parentSessionPath: options.parentSessionPath,
      metadata: {
        profile: toAgentProfileReference(options.agentProfile),
      },
    });
  }

  private async _createEphemeralAgentSession(agentId: AgentId): Promise<Session<SessionMetadata>> {
    return this._memorySessionRepo.create({ id: agentId });
  }
}
