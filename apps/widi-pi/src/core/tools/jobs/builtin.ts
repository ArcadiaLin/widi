import type { ToolRegistry } from "../../tool-registry.ts";
import type { ToolSource } from "../types.ts";
import { createWaitForJobsToolDefinition } from "./wait-for-jobs.ts";

const coreBuiltinToolSource: ToolSource = {
	kind: "core",
	id: "builtin",
};

/**
 * Register the core built-in job-control tools: primitives that operate on the
 * per-agent background job registry. They are a separate group from the coding
 * and interaction tools so profiles can grant pseudo-async job control
 * independently.
 */
export function registerCoreJobTools(registry: ToolRegistry): void {
	registry.defineTool(createWaitForJobsToolDefinition(), coreBuiltinToolSource);
}
