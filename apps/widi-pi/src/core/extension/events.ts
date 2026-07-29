import { type JsonValue, normalizeJsonValue } from "../../utils/json.ts";
import { utf8ByteLength } from "../../utils/text.ts";
import type { AgentId } from "../types.ts";

export const MAX_EXTENSION_EVENT_NAME_BYTES = 128;
export const MAX_EXTENSION_EVENT_PAYLOAD_BYTES = 65_536;

/**
 * How deep one extension event may cascade before the runtime stops relaying.
 *
 * A handler that emits is legitimate (that is how two extensions negotiate),
 * but two handlers answering each other would otherwise spin forever inside a
 * single `emitExtensionEvent` call.
 */
export const MAX_EXTENSION_EVENT_DISPATCH_DEPTH = 8;

/**
 * One extension-to-extension event as its subscribers see it.
 *
 * The bus is runtime-level: every live extension runtime receives the event,
 * including the sender's own, because coordination between two instances of the
 * same extension in different agents is a first-class case. Attribution is
 * carried rather than enforced - `sourceExtensionId` and `sourceAgentId` are
 * injected by core and cannot be forged by the emitter.
 */
export interface ExtensionEventEnvelope {
	readonly name: string;
	readonly payload?: JsonValue;
	readonly sourceExtensionId: string;
	readonly sourceAgentId: AgentId;
	readonly emittedAt: string;
}

// Same character set as an input presentation's customType: the ecosystem's
// convention for these names is `owner:event` (`herdr:blocked`), so ':' is part
// of the contract rather than a namespace core imposes.
const EXTENSION_EVENT_NAME_PATTERN = /^[a-zA-Z0-9._:-]+$/;

export function validateExtensionEventName(name: string): string {
	if (typeof name !== "string" || !EXTENSION_EVENT_NAME_PATTERN.test(name)) {
		throw new TypeError(
			"Extension event name must contain only letters, numbers, '.', '_', ':', and '-'.",
		);
	}
	if (utf8ByteLength(name) > MAX_EXTENSION_EVENT_NAME_BYTES) {
		throw new RangeError(
			`Extension event name exceeds ${MAX_EXTENSION_EVENT_NAME_BYTES} UTF-8 bytes.`,
		);
	}
	return name;
}

/**
 * Bound the payload and detach it from the emitter. Every subscriber shares
 * this one copy, so it must not stay reachable from the code that sent it.
 */
export function validateExtensionEventPayload(
	payload: JsonValue | undefined,
): JsonValue | undefined {
	if (payload === undefined) return undefined;
	return normalizeJsonValue(
		payload,
		"Extension event payload",
		MAX_EXTENSION_EVENT_PAYLOAD_BYTES,
	);
}
