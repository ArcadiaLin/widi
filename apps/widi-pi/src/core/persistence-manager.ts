/**
 * persistence manager is responsible for create and rebuild session repo
 *  
 * a persistence dir structure example:
 * .widi/
 *  sessions/
 *   --home-user-project--/
 *     <timestamp>_<sessionId>/
 *       <main_profile>.jsonl
 *       subagents/
 *         <profile>_<subagentId>.jsonl
 *         agent_map.json  -- if spawned subagents
 *         mailbox.jsonl  -- if spawned agents team
 * 
 * for each session.jsonl
 *   - the first line is its profile, resources and tool registry snapshot
 */

import {
  InMemorySessionRepo,
  JsonlSessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  DEFAULT_AGENT_DIR,
  DEFAULT_AGENT_PERSISTENCE_DIR,
} from "./constants/config.ts";

export interface PersistenceManagerConfigs {
  cwd: string;
  agentDir?: string;
}

export class PersistenceManager {
  private _cwd: string;
  private _agentDir!: string;
  private repos: Map<string, JsonlSessionRepo> = new Map();

  constructor(config: PersistenceManagerConfigs) {
    this._cwd = config.cwd;
    this._agentDir = config.agentDir ?? DEFAULT_AGENT_DIR;
  }

  
}