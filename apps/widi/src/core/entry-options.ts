import type { ThinkingLevel } from "@arcadialin/agent-core";

/**
 * What a shell can say about a run, whichever front end serves it.
 *
 * Every front end's option type extends this instead of restating it, so a flag
 * that reaches only one of them has to be declared on that one. `--no-root` was
 * dropped in silence for exactly as long as the TUI and RPC option types were
 * written independently of each other.
 */
export interface RuntimeEntryOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly profileId?: string;
	readonly enabledProfileIds?: readonly string[];
	/** `provider/id`, resolved against the model registry during startup. */
	readonly model?: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly sessionRoot?: string;
	readonly trustOverride?: boolean;
	readonly noExtensions?: boolean;
	readonly extensionPaths?: readonly string[];
}
