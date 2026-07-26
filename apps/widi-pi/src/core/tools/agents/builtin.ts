import type { ToolRegistry } from "../../tool-registry.ts";
import type { ToolSource } from "../types.ts";
import { createDisposeAgentToolDefinition } from "./dispose-agent.ts";
import { createListAgentProfilesToolDefinition } from "./list-agent-profiles.ts";
import { createListAgentsToolDefinition } from "./list-agents.ts";
import { createSendMessageToolDefinition } from "./send-message.ts";
import { createSpawnAgentToolDefinition } from "./spawn-agent.ts";

const coreBuiltinToolSource: ToolSource = {
	kind: "core",
	id: "builtin",
};

/**
 * Register the core built-in agent collaboration tools: discovery, creation,
 * messaging (including task delegation and completion), and disposal.
 *
 * They are registered unconditionally, like every other core group. Who may
 * collaborate is decided by profile tool visibility alone - there is no second
 * capability policy - so a profile that lists no tools grants all of these,
 * including to spawned workers. Worker profiles should list their tools
 * explicitly; the runtime's live-agent limit is only the backstop against
 * runaway recursion.
 *
 * Task observation and cancellation reuse the job tools: a task is a background
 * job in the assigning agent's table, so `wait_for_jobs`, `read_job`, and
 * `kill_job` already work on task ids.
 */
export function registerCoreAgentTools(registry: ToolRegistry): void {
	registry.defineTool(
		createListAgentProfilesToolDefinition(),
		coreBuiltinToolSource,
	);
	registry.defineTool(createListAgentsToolDefinition(), coreBuiltinToolSource);
	registry.defineTool(createSpawnAgentToolDefinition(), coreBuiltinToolSource);
	registry.defineTool(createSendMessageToolDefinition(), coreBuiltinToolSource);
	registry.defineTool(
		createDisposeAgentToolDefinition(),
		coreBuiltinToolSource,
	);
}
