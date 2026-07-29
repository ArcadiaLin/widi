import type { JsonValue } from "../background/index.ts";

const utf8Encoder = new TextEncoder();

/**
 * Bound an opaque extension-supplied JSON value and return a detached copy.
 *
 * Core never reads these payloads - input presentation details and extension
 * event payloads are both written by one extension for another consumer to
 * interpret - so the only contract it can enforce is that the value survives a
 * JSON round-trip.
 *
 * The round-trip is the validation *and* the result: keeping the caller's
 * object would let a function, `undefined`, or `NaN` reach a live consumer as
 * one value and come back from JSONL as another, and would leave core holding a
 * reference the extension can still mutate after the value was published.
 *
 * Not narrowed to the declared type: extensions load as untyped modules, so a
 * function can still arrive here, and JSON.stringify answers `undefined` for
 * one.
 */
export function normalizeExtensionJsonValue(
	value: JsonValue,
	label: string,
	maxBytes: number,
): JsonValue {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch (error) {
		throw new TypeError(
			`${label} must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (serialized === undefined) {
		throw new TypeError(`${label} must be JSON serializable.`);
	}
	if (utf8Encoder.encode(serialized).byteLength > maxBytes) {
		throw new RangeError(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
	}
	return JSON.parse(serialized) as JsonValue;
}
