import { readFileSync } from "node:fs";
import { THINKING_LEVELS } from "../core/model-registry.ts";

const USAGE = `widi [options] [@files...] [prompt...]

Modes
  --mode tui|rpc|print       Front end to run. Default: tui, or print when
                             stdin or stdout is not a terminal.
  -p, --print [prompt]       Shorthand for --mode print. A following token that
                             is neither a flag nor an @file becomes a prompt.

Runtime (all modes)
  --cwd <dir>                Directory the run works in. Default: this one.
  --agent-dir <dir>          Agent configuration directory.
  --profile <id>             Profile new agents start under.
  --profiles <a,b,c>         Narrow the selectable profile set.
  --model <provider/id>      Model new agents start under.
  --thinking <level>         One of ${THINKING_LEVELS.join(", ")}.
  --session-root <dir>       Where sessions are stored.
  --approve                  Trust project-local configuration without asking.
  --no-approve               Leave project-local configuration untrusted.
  -ne, --no-extensions       Skip extension discovery entirely.
  -e, --extension <path>     Load one extension by path. Repeatable, and still
                             honoured under --no-extensions.

Print mode
  --output text|json         Event stream format. Default: text.
  --deadline <ms>            Wall-clock ceiling for the whole run.
  --quiet-ms <ms>            How long the agent tree must stay quiet before the
                             run is called done.
  --emit <json>              Send one event to the extension bus, as
                             {"name":"owner:event","payload":{}}. Repeatable.
  @file                      Attach a file to the run.
  prompt                     Positional prompts, delivered in order.

RPC mode
  --no-root                  Start with no root agent; the client spawns its own.
  --human-timeout <ms>       How long a human request waits. Unset waits forever.

General
  -h, --help                 Show this help.
  -v, --version              Show the version.
`;

export function formatHelp(): string {
	return USAGE;
}

/**
 * Read from the package manifest rather than baked in at build time, so the
 * published bin cannot report a version its package.json disagrees with. The
 * path is relative to this module, which puts `dist/cli/help.js` and
 * `src/cli/help.ts` the same two levels below the manifest.
 */
export function readVersion(): string {
	const manifest: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	const version =
		typeof manifest === "object" && manifest !== null ? (manifest as { version?: unknown }).version : undefined;
	return typeof version === "string" ? version : "unknown";
}
