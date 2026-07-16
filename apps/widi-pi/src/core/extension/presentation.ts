import type {
	DiagnosticDisposition,
	DiagnosticSeverity,
} from "../diagnostics.ts";

export const MAX_EXTENSION_OUTPUT_BYTES = 65_536;
export const MAX_EXTENSION_STATUS_KEY_BYTES = 128;
export const MAX_EXTENSION_STATUS_TEXT_BYTES = 4_096;
export const MAX_EXTENSION_MESSAGE_TITLE_BYTES = 4_096;
export const MAX_EXTENSION_MESSAGE_CONTENT_BYTES = 65_536;
export const MAX_EXTENSION_DIAGNOSTIC_CODE_BYTES = 128;
export const MAX_EXTENSION_DIAGNOSTIC_MESSAGE_BYTES = 4_096;
export const MAX_EXTENSION_DIAGNOSTIC_DETAILS_BYTES = 16_384;

export const EXTENSION_MESSAGE_KINDS = ["text", "markdown", "code"] as const;

export type ExtensionMessageKind = (typeof EXTENSION_MESSAGE_KINDS)[number];

export interface ExtensionMessage {
	readonly kind: ExtensionMessageKind;
	readonly title?: string;
	readonly content: string;
}

export const EXTENSION_DIAGNOSTIC_SEVERITIES = [
	"info",
	"warning",
	"error",
] as const satisfies readonly DiagnosticSeverity[];

// Authors cannot claim "blocked": that disposition is reserved for core
// decisions that actually blocked an operation.
export const EXTENSION_DIAGNOSTIC_DISPOSITIONS = [
	"reported",
	"degraded",
] as const satisfies readonly DiagnosticDisposition[];

export type ExtensionDiagnosticDisposition =
	(typeof EXTENSION_DIAGNOSTIC_DISPOSITIONS)[number];

export interface ExtensionDiagnosticDraft {
	readonly severity: DiagnosticSeverity;
	readonly disposition?: ExtensionDiagnosticDisposition;
	readonly code: string;
	readonly message: string;
	readonly details?: Record<string, unknown>;
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

const EXTENSION_DIAGNOSTIC_CODE_PATTERN = /^[a-zA-Z0-9_.-]+$/;

// Returns a normalized deep clone; `details` is round-tripped through JSON so
// the caller keeps no live reference into the published diagnostic.
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
		draft.disposition !== undefined &&
		!(EXTENSION_DIAGNOSTIC_DISPOSITIONS as readonly string[]).includes(
			draft.disposition,
		)
	) {
		throw new TypeError(
			`Extension diagnostic disposition must be one of: ${EXTENSION_DIAGNOSTIC_DISPOSITIONS.join(", ")}.`,
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
	const base: {
		severity: DiagnosticSeverity;
		disposition?: ExtensionDiagnosticDisposition;
		code: string;
		message: string;
	} = { severity: draft.severity, code: draft.code, message: draft.message };
	if (draft.disposition !== undefined) {
		base.disposition = draft.disposition;
	}
	if (draft.details === undefined) {
		return base;
	}
	if (typeof draft.details !== "object" || draft.details === null) {
		throw new TypeError("Extension diagnostic details must be an object.");
	}
	const serialized = JSON.stringify(draft.details);
	if (serialized === undefined) {
		throw new TypeError(
			"Extension diagnostic details must be JSON serializable.",
		);
	}
	if (
		utf8Encoder.encode(serialized).byteLength >
		MAX_EXTENSION_DIAGNOSTIC_DETAILS_BYTES
	) {
		throw new RangeError(
			`Extension diagnostic details exceed ${MAX_EXTENSION_DIAGNOSTIC_DETAILS_BYTES} UTF-8 bytes when serialized.`,
		);
	}
	return { ...base, details: JSON.parse(serialized) };
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
