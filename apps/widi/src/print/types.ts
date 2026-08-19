/**
 * The print front end's entry contract.
 *
 * Kept in its own module so the CLI can route into print without depending on
 * the implementation: `cli.ts` owns argument parsing, `print/session.ts` owns
 * the run. Both sides are written against this file.
 */

import type { ThinkingLevel } from "@arcadialin/agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { JsonValue } from "../utils/json.ts";

/** `text` is for a person reading a terminal; `json` is for a benchmark driver. */
export type PrintOutputFormat = "text" | "json";

/**
 * The extension a bus event is attributed to when the driver does not name one.
 * Print speaks for itself the way an RPC client speaks for the id it declares.
 */
export const PRINT_EXTENSION_ID = "print";

/**
 * One extension bus event emitted on the root agent's behalf, before any prompt.
 *
 * RPC has `emit_extension_event` and print had nothing like it, which made how
 * an extension can be driven a property of the front end rather than of the
 * extension. This closes that: an extension reachable over the bus is reachable
 * from either mode, with or without a model deciding to reach it.
 *
 * Attribution is the addressing. `sourceAgentId` on the envelope is the root
 * agent, which is how a handler bound to one agent knows the event is for it, so
 * these go out after the root exists and are never attributed to anyone else.
 *
 * The fields are `AgentOrchestrator.emitExtensionEvent`'s own arguments.
 */
export interface PrintExtensionEmit {
	/** Who the envelope says it came from. Defaults to {@link PRINT_EXTENSION_ID}. */
	readonly extensionId?: string;
	/** `owner:event`, validated by the bus. */
	readonly name: string;
	readonly payload?: JsonValue;
}

export interface WidiPrintOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly profileId?: string;
	readonly enabledProfileIds?: readonly string[];
	/** `provider/id`, validated against the registry once the runtime is up. */
	readonly model?: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly sessionRoot?: string;
	readonly trustOverride?: boolean;
	readonly noExtensions?: boolean;
	readonly extensionPaths?: readonly string[];
	/**
	 * Delivered in order, each awaited before the next. May be empty when
	 * {@link emit} is not: a run that only drives an extension over the bus
	 * carries no prompt at all, and measuring that extension is the point of it.
	 */
	readonly prompts: readonly string[];
	/**
	 * `@file` arguments, unread. The CLI only sorts arguments; reading them and
	 * folding them into the first prompt belongs to print, which is where the
	 * rules about what a file may contain live.
	 */
	readonly fileArgs?: readonly string[];
	/** Bus events emitted once the root exists and before the first prompt. */
	readonly emit?: readonly PrintExtensionEmit[];
	readonly images?: readonly ImageContent[];
	readonly output: PrintOutputFormat;
	/** Wall-clock ceiling for the whole run. Unset runs until the tree settles. */
	readonly deadlineMs?: number;
	/** How long the agent tree must stay quiet before the run is called done. */
	readonly quietMs?: number;
}

/**
 * Process exit code.
 *
 * - `0` every prompt was delivered, every bus event accepted, and the agent tree
 *   settled on its own.
 * - `1` the run failed: the runtime refused to start, startup reported an error
 *   diagnostic, the root could not be spawned, a bus event was rejected, or a
 *   prompt was refused or blocked.
 * - `2` the run hit `deadlineMs`. The report and the summary are still written -
 *   a timed-out sample is the one a benchmark most needs the numbers for.
 *
 * Stated as `number` rather than a union so a caller can pass it straight to
 * `process.exitCode`.
 */
export type PrintExitCode = number;
