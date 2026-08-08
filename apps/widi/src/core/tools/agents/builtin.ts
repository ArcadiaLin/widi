import type { ToolRegistry } from "../../tool-registry.ts";
import type { ToolSource } from "../types.ts";
import { createDisposeAgentToolDefinition } from "./dispose-agent.ts";
import { createListAgentsToolDefinition } from "./list-agents.ts";
import { createSendMessageToolDefinition } from "./send-message.ts";
import { createSpawnAgentToolDefinition } from "./spawn-agent.ts";
import { createWatchAgentToolDefinition } from "./watch-agent.ts";

const coreBuiltinToolSource: ToolSource = { kind: "core", id: "builtin" };

/**
 * Register the core built-in agent collaboration tools: discovery, creation,
 * messaging, watching, and disposal.
 *
 * They are registered unconditionally, like every other core group. Profile
 * tool visibility decides which collaboration verbs an agent may invoke.
 * Discovery and lifecycle management are additionally scoped to its spawn
 * tree, while exact-id messaging is the deliberate soft cross-tree bridge.
 * A profile that lists no tools grants the full group, including to spawned
 * workers, so worker profiles should still list their tools explicitly.
 */
export function registerCoreAgentTools(registry: ToolRegistry): void {
	registry.defineTool(createListAgentsToolDefinition(), coreBuiltinToolSource);
	registry.defineTool(createSpawnAgentToolDefinition(), coreBuiltinToolSource);
	registry.defineTool(createSendMessageToolDefinition(), coreBuiltinToolSource);
	registry.defineTool(createWatchAgentToolDefinition(), coreBuiltinToolSource);
	registry.defineTool(createDisposeAgentToolDefinition(), coreBuiltinToolSource);
}
