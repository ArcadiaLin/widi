/**
 * Command line to front-end invocation.
 *
 * Pure: nothing here reads `process`, the filesystem or the clock, and a bad
 * argument comes back as a `usage-error` result rather than an exception. The
 * entry point turns that into one line on stderr and an exit code; a stack
 * trace is never the answer to a typo.
 *
 * Mode ownership lives here too. A flag only one front end can act on is
 * refused outright in the others, because the alternative - accepting it and
 * dropping it - is what made `--no-root --mode tui` a no-op.
 */

import { resolve } from "node:path";
import type { ThinkingLevel } from "@arcadialin/agent-core";
import type { RuntimeEntryOptions } from "../core/entry-options.ts";
import { parseThinkingLevel, THINKING_LEVELS } from "../core/model-registry.ts";
import type { PrintExtensionEmit, PrintOutputFormat, WidiPrintOptions } from "../print/types.ts";
import type { WidiRpcOptions } from "../rpc/index.ts";
import type { WidiTuiOptions } from "../tui/application.ts";
import type { JsonValue } from "../utils/json.ts";

export type EntryMode = "tui" | "rpc" | "print";

export type CliInvocation =
	| { readonly mode: "tui"; readonly options: WidiTuiOptions }
	| { readonly mode: "rpc"; readonly options: WidiRpcOptions }
	| { readonly mode: "print"; readonly options: WidiPrintOptions };

export interface CliParseEnvironment {
	/** The directory the command was typed in; relative paths mean this. */
	readonly cwd: string;
	readonly stdinIsTty: boolean;
	readonly stdoutIsTty: boolean;
}

export type CliParseResult =
	| { readonly kind: "run"; readonly invocation: CliInvocation }
	| { readonly kind: "help" }
	| { readonly kind: "version" }
	| { readonly kind: "usage-error"; readonly message: string };

/** Flags whose only reader is one front end, and which one. */
const FLAG_MODE_OWNER = new Map<string, EntryMode>([
	["--output", "print"],
	["--deadline", "print"],
	["--quiet-ms", "print"],
	["--emit", "print"],
	["--no-root", "rpc"],
	["--human-timeout", "rpc"],
]);

class UsageError extends Error {}

export function parseCliArgs(argv: readonly string[], env: CliParseEnvironment): CliParseResult {
	try {
		return parseOrThrow(argv, env);
	} catch (error) {
		if (error instanceof UsageError) return { kind: "usage-error", message: error.message };
		throw error;
	}
}

function parseOrThrow(argv: readonly string[], env: CliParseEnvironment): CliParseResult {
	let explicitMode: EntryMode | undefined;
	let cwd = env.cwd;
	let agentDir: string | undefined;
	let profileId: string | undefined;
	let enabledProfileIds: readonly string[] | undefined;
	let model: string | undefined;
	let thinkingLevel: ThinkingLevel | undefined;
	let sessionRoot: string | undefined;
	let trustOverride: boolean | undefined;
	let noExtensions = false;
	let noRoot = false;
	let humanTimeoutMs: number | undefined;
	let output: PrintOutputFormat = "text";
	let deadlineMs: number | undefined;
	let quietMs: number | undefined;
	const extensionPaths: string[] = [];
	const emit: PrintExtensionEmit[] = [];
	const prompts: string[] = [];
	const fileArgs: string[] = [];
	const seenFlags: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument.startsWith("-")) seenFlags.push(argument);
		switch (argument) {
			case "-h":
			case "--help":
				return { kind: "help" };
			case "-v":
			case "--version":
				return { kind: "version" };
			case "--mode":
				explicitMode = requireMode(requireValue(argv, ++index, argument), explicitMode);
				break;
			case "-p":
			case "--print": {
				explicitMode = requireMode("print", explicitMode);
				// pi's rule: a prompt may ride along, but a flag or an `@file` after
				// the shorthand is its own argument and must not be swallowed.
				const next: string | undefined = argv[index + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					prompts.push(next);
					index++;
				}
				break;
			}
			case "--cwd":
				cwd = resolve(env.cwd, requireValue(argv, ++index, argument));
				break;
			case "--agent-dir":
				agentDir = resolve(env.cwd, requireValue(argv, ++index, argument));
				break;
			case "--profile":
				profileId = requireValue(argv, ++index, argument);
				break;
			case "--profiles":
				enabledProfileIds = requireProfileList(requireValue(argv, ++index, argument));
				break;
			case "--model":
				model = requireModelReference(requireValue(argv, ++index, argument));
				break;
			case "--thinking":
				thinkingLevel = requireThinkingLevel(requireValue(argv, ++index, argument));
				break;
			case "--session-root":
				sessionRoot = resolve(env.cwd, requireValue(argv, ++index, argument));
				break;
			case "--approve":
				trustOverride = true;
				break;
			case "--no-approve":
				trustOverride = false;
				break;
			case "-ne":
			case "--no-extensions":
				noExtensions = true;
				break;
			case "-e":
			case "--extension":
				extensionPaths.push(resolve(env.cwd, requireValue(argv, ++index, argument)));
				break;
			case "--output":
				output = requireOutputFormat(requireValue(argv, ++index, argument));
				break;
			case "--deadline":
				deadlineMs = requirePositiveInteger(requireValue(argv, ++index, argument), argument);
				break;
			case "--quiet-ms":
				quietMs = requireNonNegativeInteger(requireValue(argv, ++index, argument), argument);
				break;
			case "--emit":
				emit.push(requireEmitRequest(requireValue(argv, ++index, argument), emit.length + 1));
				break;
			case "--no-root":
				noRoot = true;
				break;
			case "--human-timeout":
				humanTimeoutMs = requirePositiveInteger(requireValue(argv, ++index, argument), argument);
				break;
			default:
				if (argument.startsWith("@")) {
					fileArgs.push(argument.slice(1));
					break;
				}
				if (argument.startsWith("-")) throw new UsageError(`Unknown argument: ${argument}`);
				prompts.push(argument);
				break;
		}
	}

	// A shell that piped anything in or out did not ask for a full-screen
	// terminal, so an unstated mode becomes print rather than hanging on a TUI
	// nobody can see. Same rule as pi's resolveAppMode().
	const mode: EntryMode = explicitMode ?? (env.stdinIsTty && env.stdoutIsTty ? "tui" : "print");
	for (const flag of seenFlags) {
		const owner = FLAG_MODE_OWNER.get(flag);
		if (owner !== undefined && owner !== mode) {
			throw new UsageError(`${flag} is only valid with --mode ${owner}`);
		}
	}
	if (mode !== "print" && (prompts.length > 0 || fileArgs.length > 0)) {
		throw new UsageError("Prompts and @files are only valid with --mode print (or -p)");
	}

	const entry: RuntimeEntryOptions = {
		cwd,
		agentDir,
		profileId,
		enabledProfileIds,
		model,
		thinkingLevel,
		sessionRoot,
		trustOverride,
		noExtensions,
		extensionPaths,
	};

	switch (mode) {
		case "tui":
			return { kind: "run", invocation: { mode, options: entry } };
		case "rpc":
			return { kind: "run", invocation: { mode, options: { ...entry, noRoot, humanTimeoutMs } } };
		case "print": {
			// A run with nothing to say is a hang waiting to happen. Piped stdin
			// counts as something to say: the print front end reads it, and
			// `echo ... | widi -p` names no prompt anywhere else.
			const hasPrompt = prompts.some((prompt) => prompt.trim() !== "");
			if (!hasPrompt && fileArgs.length === 0 && emit.length === 0 && env.stdinIsTty) {
				throw new UsageError("Print mode needs a prompt, an @file, --emit, or input on stdin");
			}
			return {
				kind: "run",
				invocation: { mode, options: { ...entry, prompts, fileArgs, emit, output, deadlineMs, quietMs } },
			};
		}
	}
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
	const value: string | undefined = argv[index];
	if (value === undefined) throw new UsageError(`Missing value for ${flag}`);
	return value;
}

function requireMode(value: string, previous: EntryMode | undefined): EntryMode {
	const mode = value === "tui" || value === "rpc" || value === "print" ? value : undefined;
	if (mode === undefined) throw new UsageError(`Unknown mode: ${value}. Expected 'tui', 'rpc' or 'print'.`);
	if (previous !== undefined && previous !== mode) {
		throw new UsageError(`Conflicting modes: ${previous} and ${mode}`);
	}
	return mode;
}

function requireProfileList(value: string): readonly string[] {
	const ids = value
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id !== "");
	if (ids.length === 0) throw new UsageError("--profiles expects a comma-separated list of profile ids");
	return ids;
}

/** Format only. Which models exist is the registry's answer, and it is not up yet. */
function requireModelReference(value: string): string {
	if (!/^[^/]+\/.+$/.test(value.trim())) {
		throw new UsageError(`--model expects provider/id, got: ${value}`);
	}
	return value.trim();
}

function requireThinkingLevel(value: string): ThinkingLevel {
	const level = parseThinkingLevel(value);
	if (!level) throw new UsageError(`--thinking expects one of ${THINKING_LEVELS.join(", ")}, got: ${value}`);
	return level;
}

function requireOutputFormat(value: string): PrintOutputFormat {
	if (value === "text" || value === "json") return value;
	throw new UsageError(`--output expects 'text' or 'json', got: ${value}`);
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireEmitRequest(value: string, ordinal: number): PrintExtensionEmit {
	let parsed: JsonValue;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new UsageError(`--emit #${ordinal} is not valid JSON: ${error instanceof Error ? error.message : error}`);
	}
	if (!isJsonObject(parsed)) {
		throw new UsageError(`--emit #${ordinal} must be a JSON object, for example {"name":"owner:event","payload":{}}`);
	}
	// `name`, spelled the way RPC's `emit_extension_event` spells it: the two
	// front ends reach the same bus, and one event described two ways would make
	// the description a property of the mode it was typed into.
	const name = parsed.name;
	if (typeof name !== "string" || name.trim() === "") {
		throw new UsageError(`--emit #${ordinal} needs a non-empty string "name"`);
	}
	// The payload's shape belongs to whichever extension subscribes to the event;
	// a CLI that validated it would be a second, wrong source of truth. The name
	// is not checked either - the bus owns the `owner:event` rule.
	return "payload" in parsed ? { name, payload: parsed.payload } : { name };
}

function requirePositiveInteger(value: string, flag: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new UsageError(`${flag} expects a positive whole number of milliseconds, got: ${value}`);
	}
	return parsed;
}

function requireNonNegativeInteger(value: string, flag: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new UsageError(`${flag} expects a whole number of milliseconds, got: ${value}`);
	}
	return parsed;
}
