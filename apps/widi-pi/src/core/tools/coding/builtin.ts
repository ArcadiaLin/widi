import type { ToolRegistry } from "../../tool-registry.ts";
import type { ToolSource } from "../types.ts";
import { createEditToolDefinition } from "./edit.ts";
import { createReadToolDefinition } from "./read.ts";
import { createWriteToolDefinition } from "./write.ts";

/** Registration owner for runtime built-in tools. */
export const coreBuiltinToolSource: ToolSource = {
	kind: "core",
	id: "builtin",
};

/**
 * Register the core built-in coding tools.
 *
 * The definitions default to local filesystem operations regardless of the
 * runtime ExecutionEnv; delegating tool backends to other environments is an
 * operations-injection or extension patchTool concern, not a registration
 * concern.
 */
export function registerCoreCodingTools(
	registry: ToolRegistry,
	cwd: string,
): void {
	registry.defineTool(createReadToolDefinition(cwd), coreBuiltinToolSource);
	registry.defineTool(createWriteToolDefinition(cwd), coreBuiltinToolSource);
	registry.defineTool(createEditToolDefinition(cwd), coreBuiltinToolSource);
}
