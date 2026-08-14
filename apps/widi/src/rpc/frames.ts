/**
 * Inbound frame classification and validation, separate from both the server
 * and the channel.
 *
 * Routing has to work before the server exists: startup can ask a human (the
 * "ask" project-trust policy), so a `human_response` may legitimately arrive
 * while there is still no orchestrator to run commands against. Classifying
 * here lets one reader serve both phases without either side guessing.
 *
 * Classification comes first and validation second, on purpose. `cmd` decides
 * which schema a frame is checked against, so a bad payload is measured against
 * the command the client asked for - the error can then name the field. Checking
 * one union instead would only be able to report that the frame matched none of
 * seventeen shapes, which is no more useful than the cast this replaced.
 */

import type { TSchema } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import { RPC_COMMAND_SCHEMAS, RPC_HUMAN_RESPONSE_SCHEMA } from "./schema.ts";
import type { RpcCommand, RpcCommandName, RpcHumanResponseFrame } from "./types.ts";

export type ParsedInbound =
	| { readonly kind: "command"; readonly command: RpcCommand }
	| { readonly kind: "human_response"; readonly frame: RpcHumanResponseFrame }
	/**
	 * `id` and `cmd` are whatever the frame said, when it said anything usable.
	 * A refusal has to be correlatable: a client with several commands in flight
	 * cannot act on "one of them was malformed".
	 */
	| { readonly kind: "invalid"; readonly message: string; readonly id?: string; readonly cmd?: string };

export function parseInbound(line: string): ParsedInbound {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { kind: "invalid", message: `Malformed JSON frame: ${reason}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { kind: "invalid", message: "A frame must be a JSON object." };
	}

	const frame = parsed as Record<string, unknown>;
	const said = {
		...(typeof frame.id === "string" ? { id: frame.id } : undefined),
		...(typeof frame.cmd === "string" ? { cmd: frame.cmd } : undefined),
	};
	if (frame.type === "human_response") {
		const failure = validate(RPC_HUMAN_RESPONSE_SCHEMA, frame, "human_response");
		if (failure) return { ...failure, ...said };
		return { kind: "human_response", frame: frame as unknown as RpcHumanResponseFrame };
	}
	if (typeof frame.cmd !== "string") {
		return { kind: "invalid", message: "A command frame must carry a string `cmd`.", ...said };
	}
	const schema = RPC_COMMAND_SCHEMAS[frame.cmd as RpcCommandName] as (typeof RPC_COMMAND_SCHEMAS)[RpcCommandName];
	if (schema === undefined) {
		return { kind: "invalid", message: `Unknown command: ${frame.cmd}`, ...said };
	}
	const failure = validate(schema, frame, frame.cmd);
	if (failure) return { ...failure, ...said };
	return { kind: "command", command: frame as unknown as RpcCommand };
}

/**
 * Check a frame, and describe the first thing wrong with it by path.
 *
 * One place rather than all of them: a client fixes the frame and sends it
 * again, so everything after the first is about a frame that no longer exists.
 * `Check` runs first because it stops at the first failure, while `Errors`
 * always walks the whole value.
 */
function validate(
	schema: TSchema,
	frame: Record<string, unknown>,
	label: string,
): { readonly kind: "invalid"; readonly message: string } | undefined {
	if (Value.Check(schema, frame)) return undefined;
	const errors = Value.Errors(schema, frame);
	const [first] = errors;
	if (first === undefined) {
		return { kind: "invalid", message: `Invalid ${label} frame: it does not match the schema.` };
	}
	const at = first.instancePath === "" ? "" : ` at ${first.instancePath}`;
	return { kind: "invalid", message: `Invalid ${label} frame${at}: ${explain(errors, first.instancePath)}.` };
}

/**
 * Turn one place's errors into something a client can act on.
 *
 * Two of typebox's default messages are not actionable on their own, and both
 * are what a typo produces. "must be equal to constant" is emitted once per
 * branch of a literal union with the value only in `params`, so on its own it
 * names neither what was sent nor what was allowed; "must not have additional
 * properties" does not say which. Everything else already reads well enough.
 */
function explain(errors: readonly TLocalizedValidationError[], path: string): string {
	const here = errors.filter((error) => error.instancePath === path);
	const allowed = here.flatMap((error) => (error.keyword === "const" ? [error.params.allowedValue] : []));
	if (allowed.length > 0) return `must be one of ${allowed.map((value) => JSON.stringify(value)).join(", ")}`;
	// The first one only, unlike the constants above: those are the branches of
	// one literal union and merge into its allowed set, whereas two branches of an
	// object union each call the *other* branch's fields unknown, and joining
	// those lists would name a property that is in fact legal.
	const unknown = here.find((error) => error.keyword === "additionalProperties")?.params.additionalProperties;
	if (unknown !== undefined && unknown.length > 0) {
		return `unknown ${unknown.length === 1 ? "property" : "properties"}: ${unknown.join(", ")}`;
	}
	return here[0]?.message ?? "it does not match the schema";
}
