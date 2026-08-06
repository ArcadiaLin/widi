import type { ToolRegistry } from "../../tool-registry.ts";
import type { ToolSource } from "../types.ts";
import { createDisposeAgentToolDefinition } from "./dispose-agent.ts";
import { createListAgentProfilesToolDefinition } from "./list-agent-profiles.ts";
import { createListAgentsToolDefinition } from "./list-agents.ts";
import { createSendMessageToolDefinition } from "./send-message.ts";
import { createSpawnAgentToolDefinition } from "./spawn-agent.ts";

const coreBuiltinToolSource: ToolSource = { kind: "core", id: "builtin" };

/**
 * Register the core built-in agent collaboration tools: discovery, creation,
 * messaging (including task delegation and completion), and disposal.
 *
 * They are registered unconditionally, like every other core group. Profile
 * tool visibility decides which collaboration verbs an agent may invoke.
 * Discovery and lifecycle management are additionally scoped to its spawn
 * tree, while exact-id messaging is the deliberate soft cross-tree bridge.
 * A profile that lists no tools grants the full group, including to spawned
 * workers, so worker profiles should still list their tools explicitly.
 *
 * Task observation and cancellation reuse the job tools: a task is a background
 * job in the assigning agent's table, so `wait_for_jobs`, `read_job`, and
 * `kill_job` already work on task ids.
 */
export function registerCoreAgentTools(registry: ToolRegistry): void {
	registry.defineTool(createListAgentProfilesToolDefinition(), coreBuiltinToolSource);
	registry.defineTool(createListAgentsToolDefinition(), coreBuiltinToolSource);
	registry.defineTool(createSpawnAgentToolDefinition(), coreBuiltinToolSource);
	registry.defineTool(createSendMessageToolDefinition(), coreBuiltinToolSource);
	registry.defineTool(createDisposeAgentToolDefinition(), coreBuiltinToolSource);
}
