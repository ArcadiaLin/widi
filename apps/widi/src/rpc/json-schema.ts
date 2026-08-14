/**
 * The published contract for everything a client sends, built from the same
 * definitions the runtime validates against.
 *
 * A hand-written schema file is a second statement of the protocol and drifts
 * from the first; this one cannot, because there is only one. `docs/rpc.md`
 * remains the specification - this says what is accepted, not what any of it
 * means.
 *
 * Inbound only, for the reason given in `schema.ts`.
 */

import { RPC_COMMAND_SCHEMAS, RPC_HUMAN_RESPONSE_SCHEMA } from "./schema.ts";
import { RPC_PROTOCOL_VERSION } from "./types.ts";

export const RPC_SCHEMA_FILENAME = "rpc-inbound.schema.json";

export function buildRpcInboundJsonSchema(): Record<string, unknown> {
	const commands = Object.keys(RPC_COMMAND_SCHEMAS).sort();
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: `https://github.com/ArcadiaLin/widi/blob/main/apps/widi/docs/${RPC_SCHEMA_FILENAME}`,
		title: "WIDI RPC inbound frames",
		description: `Everything a client may write to a \`widi --mode rpc\` process. Protocol version ${RPC_PROTOCOL_VERSION}; see apps/widi/docs/rpc.md.`,
		oneOf: [...commands.map((name) => ({ $ref: `#/$defs/${name}` })), { $ref: "#/$defs/human_response" }],
		$defs: {
			...Object.fromEntries(
				commands.map((name) => [name, RPC_COMMAND_SCHEMAS[name as keyof typeof RPC_COMMAND_SCHEMAS]]),
			),
			human_response: RPC_HUMAN_RESPONSE_SCHEMA,
		},
	};
}

/** What the checked-in file holds, newline-terminated so it reads as a text file. */
export function serializeRpcInboundJsonSchema(): string {
	return `${JSON.stringify(buildRpcInboundJsonSchema(), null, "\t")}\n`;
}
