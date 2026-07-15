import type { ToolRegistry } from "../../tool-registry.ts";
import type { ToolSource } from "../types.ts";
import { createBashToolDefinition } from "./bash.ts";
import { createEditToolDefinition } from "./edit.ts";
import { createFindToolDefinition } from "./find.ts";
import { createGrepToolDefinition } from "./grep.ts";
import { createLsToolDefinition } from "./ls.ts";
import { createReadToolDefinition } from "./read.ts";
import { createWriteToolDefinition } from "./write.ts";

/** Registration owner for runtime built-in tools. */
export const coreBuiltinToolSource: ToolSource = {
	kind: "core",
	id: "builtin",
};

export interface CoreCodingToolOptions {
	/** Explicit shell path for the bash tool. */
	shellPath?: string;
	/** Command prefix prepended to every bash command. */
	shellCommandPrefix?: string;
	/** Explicit ripgrep executable path for the grep and find tools. */
	rgPath?: string;
	/** Default: true. Resize images read by the read tool to inline limits. */
	autoResizeImages?: boolean;
	/** Default: false. The read tool returns text-only notes for images. */
	blockImages?: boolean;
}

/**
 * Register the core built-in coding tools.
 *
 * The definitions default to local filesystem and shell operations regardless
 * of the runtime ExecutionEnv; delegating tool backends to other environments
 * is an operations-injection or extension patchTool concern, not a registration
 * concern.
 */
export function registerCoreCodingTools(
	registry: ToolRegistry,
	cwd: string,
	options: CoreCodingToolOptions = {},
): void {
	registry.defineTool(
		createReadToolDefinition(cwd, {
			autoResizeImages: options.autoResizeImages,
			blockImages: options.blockImages,
		}),
		coreBuiltinToolSource,
	);
	registry.defineTool(
		createBashToolDefinition(cwd, {
			shellPath: options.shellPath,
			commandPrefix: options.shellCommandPrefix,
		}),
		coreBuiltinToolSource,
	);
	registry.defineTool(createEditToolDefinition(cwd), coreBuiltinToolSource);
	registry.defineTool(createWriteToolDefinition(cwd), coreBuiltinToolSource);
	registry.defineTool(
		createGrepToolDefinition(cwd, { rgPath: options.rgPath }),
		coreBuiltinToolSource,
	);
	registry.defineTool(
		createFindToolDefinition(cwd, { rgPath: options.rgPath }),
		coreBuiltinToolSource,
	);
	registry.defineTool(createLsToolDefinition(cwd), coreBuiltinToolSource);
}
