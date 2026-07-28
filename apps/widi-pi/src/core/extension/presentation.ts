import type { JsonValue } from "../background/index.ts";
import type { DiagnosticSeverity } from "../diagnostics.ts";

export const MAX_EXTENSION_OUTPUT_BYTES = 65_536;
export const MAX_EXTENSION_NOTIFICATION_BYTES = 4_096;
export const MAX_EXTENSION_STATUS_KEY_BYTES = 128;
export const MAX_EXTENSION_STATUS_TEXT_BYTES = 4_096;
export const MAX_EXTENSION_MESSAGE_TITLE_BYTES = 4_096;
export const MAX_EXTENSION_MESSAGE_CONTENT_BYTES = 65_536;
export const MAX_EXTENSION_DIAGNOSTIC_CODE_BYTES = 128;
export const MAX_EXTENSION_DIAGNOSTIC_MESSAGE_BYTES = 4_096;

export const EXTENSION_MESSAGE_KINDS = ["text", "markdown", "code"] as const;

export type ExtensionMessageKind = (typeof EXTENSION_MESSAGE_KINDS)[number];

export interface ExtensionMessage {
	readonly kind: ExtensionMessageKind;
	readonly title?: string;
	readonly content: string;
}

export const MAX_EXTENSION_PRESENTATION_TYPE_BYTES = 128;
export const MAX_EXTENSION_PRESENTATION_DETAILS_BYTES = 65_536;

/**
 * How a client should render a message an extension sent into an agent.
 *
 * The message itself stays ordinary model context - this rides alongside it as
 * a separate record, the same dual-record discipline as command expansion and
 * input transform. Core never interprets `details`; it validates that the value
 * is JSON-serializable and bounded, then keeps a normalized detached copy.
 *
 * `customType` is not namespaced in the string: the persisted entry and the
 * published event both carry `extensionId` next to it, so two extensions may
 * use the same local type without colliding and a renderer keys on the pair.
 */
export interface ExtensionInputPresentation {
	readonly customType: string;
	readonly title?: string;
	readonly details?: JsonValue;
}

export const EXTENSION_DIAGNOSTIC_SEVERITIES = [
	"warning",
	"error",
] as const satisfies readonly DiagnosticSeverity[];

export interface ExtensionDiagnosticDraft {
	readonly severity: DiagnosticSeverity;
	readonly code: string;
	readonly message: string;
}

export interface ExtensionStatusProgress {
	readonly completed: number;
	readonly total?: number;
}

export interface ExtensionStatus {
	readonly text: string;
	readonly progress?: ExtensionStatusProgress;
}

export interface ExtensionStatusSnapshot {
	readonly agentId: string;
	readonly extensionId: string;
	readonly key: string;
	readonly status: ExtensionStatus;
	readonly updatedAt: string;
}

const utf8Encoder = new TextEncoder();

export function assertExtensionOutputText(text: string): void {
	if (typeof text !== "string" || text.length === 0) {
		throw new TypeError("Extension output text must be a non-empty string.");
	}
	const size = utf8Encoder.encode(text).byteLength;
	if (size > MAX_EXTENSION_OUTPUT_BYTES) {
		throw new RangeError(
			`Extension output text exceeds ${MAX_EXTENSION_OUTPUT_BYTES} UTF-8 bytes.`,
		);
	}
}

export function assertExtensionNotificationText(text: string): void {
	assertBoundedNonBlankText(
		text,
		"Extension notification text",
		MAX_EXTENSION_NOTIFICATION_BYTES,
	);
}

export function assertExtensionStatusKey(key: string): void {
	assertBoundedNonBlankText(
		key,
		"Extension status key",
		MAX_EXTENSION_STATUS_KEY_BYTES,
	);
}

export function validateExtensionStatus(
	status: ExtensionStatus,
): ExtensionStatus {
	if (typeof status !== "object" || status === null) {
		throw new TypeError("Extension status must be an object.");
	}
	assertBoundedNonBlankText(
		status.text,
		"Extension status text",
		MAX_EXTENSION_STATUS_TEXT_BYTES,
	);
	const progress = status.progress;
	if (progress === undefined) {
		return { text: status.text };
	}
	if (typeof progress !== "object" || progress === null) {
		throw new TypeError("Extension status progress must be an object.");
	}
	assertNonNegativeInteger(
		progress.completed,
		"Extension status progress completed",
	);
	if (progress.total === undefined) {
		return {
			text: status.text,
			progress: { completed: progress.completed },
		};
	}
	assertNonNegativeInteger(progress.total, "Extension status progress total");
	if (progress.completed > progress.total) {
		throw new RangeError(
			"Extension status progress completed cannot exceed total.",
		);
	}
	return {
		text: status.text,
		progress: {
			completed: progress.completed,
			total: progress.total,
		},
	};
}

export function validateExtensionMessage(
	message: ExtensionMessage,
): ExtensionMessage {
	if (typeof message !== "object" || message === null) {
		throw new TypeError("Extension message must be an object.");
	}
	if (!(EXTENSION_MESSAGE_KINDS as readonly string[]).includes(message.kind)) {
		throw new TypeError(
			`Extension message kind must be one of: ${EXTENSION_MESSAGE_KINDS.join(", ")}.`,
		);
	}
	if (typeof message.content !== "string" || message.content.length === 0) {
		throw new TypeError(
			"Extension message content must be a non-empty string.",
		);
	}
	const contentSize = utf8Encoder.encode(message.content).byteLength;
	if (contentSize > MAX_EXTENSION_MESSAGE_CONTENT_BYTES) {
		throw new RangeError(
			`Extension message content exceeds ${MAX_EXTENSION_MESSAGE_CONTENT_BYTES} UTF-8 bytes.`,
		);
	}
	if (message.title === undefined) {
		return { kind: message.kind, content: message.content };
	}
	assertBoundedNonBlankText(
		message.title,
		"Extension message title",
		MAX_EXTENSION_MESSAGE_TITLE_BYTES,
	);
	return {
		kind: message.kind,
		title: message.title,
		content: message.content,
	};
}

const EXTENSION_PRESENTATION_TYPE_PATTERN = /^[a-zA-Z0-9._:-]+$/;

export function validateExtensionInputPresentation(
	presentation: ExtensionInputPresentation,
): ExtensionInputPresentation {
	if (typeof presentation !== "object" || presentation === null) {
		throw new TypeError("Extension input presentation must be an object.");
	}
	const customType = presentation.customType;
	if (
		typeof customType !== "string" ||
		!EXTENSION_PRESENTATION_TYPE_PATTERN.test(customType)
	) {
		throw new TypeError(
			"Extension input presentation customType must contain only letters, numbers, '.', '_', ':', and '-'.",
		);
	}
	if (
		utf8Encoder.encode(customType).byteLength >
		MAX_EXTENSION_PRESENTATION_TYPE_BYTES
	) {
		throw new RangeError(
			`Extension input presentation customType exceeds ${MAX_EXTENSION_PRESENTATION_TYPE_BYTES} UTF-8 bytes.`,
		);
	}
	const result: {
		customType: string;
		title?: string;
		details?: JsonValue;
	} = { customType };
	if (presentation.title !== undefined) {
		assertBoundedNonBlankText(
			presentation.title,
			"Extension input presentation title",
			MAX_EXTENSION_MESSAGE_TITLE_BYTES,
		);
		result.title = presentation.title;
	}
	if (presentation.details !== undefined) {
		// Core stores and republishes details without reading them, so the only
		// contract it can enforce is that the value survives the session file.
		//
		// The round-trip is the validation *and* the result: keeping the caller's
		// object would let a function, `undefined`, or `NaN` reach a live
		// consumer as one value and come back from JSONL as another - and would
		// leave core holding a reference the extension can still mutate after
		// the entry is written.
		// Not narrowed to string: extensions load as untyped modules, so a
		// function can still arrive here, and JSON.stringify answers `undefined`
		// for one.
		let serialized: string | undefined;
		try {
			serialized = JSON.stringify(presentation.details);
		} catch (error) {
			throw new TypeError(
				`Extension input presentation details must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (serialized === undefined) {
			throw new TypeError(
				"Extension input presentation details must be JSON serializable.",
			);
		}
		if (
			utf8Encoder.encode(serialized).byteLength >
			MAX_EXTENSION_PRESENTATION_DETAILS_BYTES
		) {
			throw new RangeError(
				`Extension input presentation details exceed ${MAX_EXTENSION_PRESENTATION_DETAILS_BYTES} UTF-8 bytes.`,
			);
		}
		result.details = JSON.parse(serialized) as JsonValue;
	}
	return result;
}

export function cloneExtensionInputPresentation(
	presentation: ExtensionInputPresentation,
): ExtensionInputPresentation {
	return structuredClone(presentation);
}

const EXTENSION_DIAGNOSTIC_CODE_PATTERN = /^[a-zA-Z0-9_.-]+$/;

export function validateExtensionDiagnosticDraft(
	draft: ExtensionDiagnosticDraft,
): ExtensionDiagnosticDraft {
	if (typeof draft !== "object" || draft === null) {
		throw new TypeError("Extension diagnostic draft must be an object.");
	}
	if (
		!(EXTENSION_DIAGNOSTIC_SEVERITIES as readonly string[]).includes(
			draft.severity,
		)
	) {
		throw new TypeError(
			`Extension diagnostic severity must be one of: ${EXTENSION_DIAGNOSTIC_SEVERITIES.join(", ")}.`,
		);
	}
	if (
		typeof draft.code !== "string" ||
		!EXTENSION_DIAGNOSTIC_CODE_PATTERN.test(draft.code)
	) {
		throw new TypeError(
			"Extension diagnostic code must contain only letters, numbers, '.', '_', and '-'.",
		);
	}
	if (
		utf8Encoder.encode(draft.code).byteLength >
		MAX_EXTENSION_DIAGNOSTIC_CODE_BYTES
	) {
		throw new RangeError(
			`Extension diagnostic code exceeds ${MAX_EXTENSION_DIAGNOSTIC_CODE_BYTES} UTF-8 bytes.`,
		);
	}
	assertBoundedNonBlankText(
		draft.message,
		"Extension diagnostic message",
		MAX_EXTENSION_DIAGNOSTIC_MESSAGE_BYTES,
	);
	return {
		severity: draft.severity,
		code: draft.code,
		message: draft.message,
	};
}

export function cloneExtensionStatus(status: ExtensionStatus): ExtensionStatus {
	return {
		text: status.text,
		progress: status.progress
			? {
					completed: status.progress.completed,
					total: status.progress.total,
				}
			: undefined,
	};
}

function assertBoundedNonBlankText(
	value: string,
	label: string,
	maxBytes: number,
): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${label} must be a non-blank string.`);
	}
	const size = utf8Encoder.encode(value).byteLength;
	if (size > maxBytes) {
		throw new RangeError(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
	}
}

function assertNonNegativeInteger(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new RangeError(`${label} must be a non-negative integer.`);
	}
}
