import { type JsonValue, normalizeJsonValue } from "../../utils/json.ts";
import { utf8ByteLength } from "../../utils/text.ts";
import type { DiagnosticSeverity } from "../diagnostics.ts";

export const MAX_EXTENSION_OUTPUT_BYTES = 65_536;
export const MAX_EXTENSION_NOTIFICATION_BYTES = 4_096;
export const MAX_EXTENSION_STATUS_KEY_BYTES = 128;
export const MAX_EXTENSION_STATUS_TEXT_BYTES = 4_096;
export const MAX_EXTENSION_STATUS_ICON_BYTES = 32;
export const MAX_EXTENSION_MESSAGE_TITLE_BYTES = 4_096;
export const MAX_EXTENSION_MESSAGE_CONTENT_BYTES = 65_536;
export const MAX_EXTENSION_MESSAGE_BYTES = 65_536;
export const MAX_EXTENSION_MESSAGE_LANGUAGE_BYTES = 32;
export const MAX_EXTENSION_MESSAGE_PATH_BYTES = 4_096;
export const MAX_EXTENSION_MESSAGE_CELL_BYTES = 1_024;
export const MAX_EXTENSION_MESSAGE_TABLE_COLUMNS = 12;
export const MAX_EXTENSION_MESSAGE_TABLE_ROWS = 200;
export const MAX_EXTENSION_MESSAGE_FIELDS = 64;
export const MAX_EXTENSION_DIAGNOSTIC_CODE_BYTES = 128;
export const MAX_EXTENSION_DIAGNOSTIC_MESSAGE_BYTES = 4_096;

export const EXTENSION_MESSAGE_KINDS = ["text", "markdown", "code", "table", "fields", "diff", "banner"] as const;

export type ExtensionMessageKind = (typeof EXTENSION_MESSAGE_KINDS)[number];

/**
 * Semantic emphasis, never a color: core has no palette and no terminal.
 * Clients map a tone onto their own theme, and a client that has no notion of
 * emphasis may ignore it entirely.
 */
export const EXTENSION_TONES = ["neutral", "info", "success", "warning", "danger"] as const;

export type ExtensionTone = (typeof EXTENSION_TONES)[number];

export const EXTENSION_TABLE_ALIGNMENTS = ["left", "right"] as const;

export type ExtensionTableAlignment = (typeof EXTENSION_TABLE_ALIGNMENTS)[number];

export interface ExtensionTableColumn {
	readonly label: string;
	readonly align?: ExtensionTableAlignment;
}

export interface ExtensionMessageField {
	readonly label: string;
	readonly value: string;
	readonly tone?: ExtensionTone;
}

export interface ExtensionTextMessage {
	readonly kind: "text" | "markdown";
	readonly title?: string;
	readonly content: string;
}

export interface ExtensionCodeMessage {
	readonly kind: "code";
	readonly title?: string;
	readonly content: string;
	readonly language?: string;
}

export interface ExtensionTableMessage {
	readonly kind: "table";
	readonly title?: string;
	readonly columns: readonly ExtensionTableColumn[];
	readonly rows: readonly (readonly string[])[];
}

export interface ExtensionFieldsMessage {
	readonly kind: "fields";
	readonly title?: string;
	readonly fields: readonly ExtensionMessageField[];
}

export interface ExtensionDiffMessage {
	readonly kind: "diff";
	readonly title?: string;
	readonly path?: string;
	readonly patch: string;
}

export interface ExtensionBannerMessage {
	readonly kind: "banner";
	readonly title?: string;
	readonly severity: ExtensionTone;
	readonly content: string;
}

/**
 * Durable presentation content an extension publishes into an agent.
 *
 * The structured kinds exist so an extension can hand a client a report
 * instead of pre-rendered text: core never formats, it only bounds the shape a
 * client can rely on. A client that cannot render a kind still has `title` and
 * a degraded textual fallback available.
 */
export type ExtensionMessage =
	| ExtensionTextMessage
	| ExtensionCodeMessage
	| ExtensionTableMessage
	| ExtensionFieldsMessage
	| ExtensionDiffMessage
	| ExtensionBannerMessage;

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

export const EXTENSION_DIAGNOSTIC_SEVERITIES = ["warning", "error"] as const satisfies readonly DiagnosticSeverity[];

export interface ExtensionDiagnosticDraft {
	readonly severity: DiagnosticSeverity;
	readonly code: string;
	readonly message: string;
}

export interface ExtensionStatusProgress {
	readonly completed: number;
	readonly total?: number;
}

export const EXTENSION_STATUS_REGIONS = ["panel", "footer", "agent-strip"] as const;

export type ExtensionStatusRegion = (typeof EXTENSION_STATUS_REGIONS)[number];

export interface ExtensionStatus {
	readonly text: string;
	readonly progress?: ExtensionStatusProgress;
	/** Where a client should surface the status; defaults to "panel". */
	readonly region?: ExtensionStatusRegion;
	/** A single grapheme a client may show in place of, or before, the text. */
	readonly icon?: string;
	readonly tone?: ExtensionTone;
}

export interface ExtensionStatusSnapshot {
	readonly agentId: string;
	readonly extensionId: string;
	readonly key: string;
	readonly status: ExtensionStatus;
	readonly updatedAt: string;
}

export function assertExtensionOutputText(text: string): void {
	if (typeof text !== "string" || text.length === 0) {
		throw new TypeError("Extension output text must be a non-empty string.");
	}
	const size = utf8ByteLength(text);
	if (size > MAX_EXTENSION_OUTPUT_BYTES) {
		throw new RangeError(`Extension output text exceeds ${MAX_EXTENSION_OUTPUT_BYTES} UTF-8 bytes.`);
	}
}

export function assertExtensionNotificationText(text: string): void {
	assertBoundedNonBlankText(text, "Extension notification text", MAX_EXTENSION_NOTIFICATION_BYTES);
}

export function assertExtensionStatusKey(key: string): void {
	assertBoundedNonBlankText(key, "Extension status key", MAX_EXTENSION_STATUS_KEY_BYTES);
}

export function validateExtensionStatus(status: ExtensionStatus): ExtensionStatus {
	if (typeof status !== "object" || status === null) {
		throw new TypeError("Extension status must be an object.");
	}
	assertBoundedNonBlankText(status.text, "Extension status text", MAX_EXTENSION_STATUS_TEXT_BYTES);
	const result: {
		text: string;
		progress?: ExtensionStatusProgress;
		region?: ExtensionStatusRegion;
		icon?: string;
		tone?: ExtensionTone;
	} = { text: status.text };
	const progress = status.progress;
	if (progress !== undefined) {
		if (typeof progress !== "object" || progress === null) {
			throw new TypeError("Extension status progress must be an object.");
		}
		assertNonNegativeInteger(progress.completed, "Extension status progress completed");
		if (progress.total === undefined) {
			result.progress = { completed: progress.completed };
		} else {
			assertNonNegativeInteger(progress.total, "Extension status progress total");
			if (progress.completed > progress.total) {
				throw new RangeError("Extension status progress completed cannot exceed total.");
			}
			result.progress = { completed: progress.completed, total: progress.total };
		}
	}
	if (status.region !== undefined) {
		if (!(EXTENSION_STATUS_REGIONS as readonly string[]).includes(status.region)) {
			throw new TypeError(`Extension status region must be one of: ${EXTENSION_STATUS_REGIONS.join(", ")}.`);
		}
		result.region = status.region;
	}
	if (status.icon !== undefined) {
		result.icon = validateStatusIcon(status.icon);
	}
	if (status.tone !== undefined) {
		result.tone = validateTone(status.tone, "Extension status tone");
	}
	return result;
}

const statusIconSegmenter = new Intl.Segmenter();

/**
 * Icons share a line with text a client already lays out, so core admits
 * exactly one grapheme cluster - one user-perceived character, emoji sequences
 * included. Core has no font metrics and does not measure display columns; a
 * client that cares truncates to its own budget (two columns in the TUI).
 */
function validateStatusIcon(icon: string): string {
	if (typeof icon !== "string" || icon.length === 0) {
		throw new TypeError("Extension status icon must be a non-empty string.");
	}
	if (utf8ByteLength(icon) > MAX_EXTENSION_STATUS_ICON_BYTES) {
		throw new RangeError(`Extension status icon exceeds ${MAX_EXTENSION_STATUS_ICON_BYTES} UTF-8 bytes.`);
	}
	if (CONTROL_CHARACTER_PATTERN.test(icon)) {
		throw new TypeError("Extension status icon must not contain control characters.");
	}
	const segments = [...statusIconSegmenter.segment(icon)];
	if (segments.length !== 1) {
		throw new TypeError("Extension status icon must be a single character.");
	}
	return icon;
}

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

function validateTone(tone: ExtensionTone, label: string): ExtensionTone {
	if (!(EXTENSION_TONES as readonly string[]).includes(tone)) {
		throw new TypeError(`${label} must be one of: ${EXTENSION_TONES.join(", ")}.`);
	}
	return tone;
}

/**
 * Validate a published message and return a deep copy core owns alone.
 *
 * The structured kinds carry arrays, so rebuilding the top-level object is no
 * longer enough to detach: every row, cell and field is copied out of the
 * extension's reach before core persists or republishes it.
 */
export function validateExtensionMessage(message: ExtensionMessage): ExtensionMessage {
	if (typeof message !== "object" || message === null) {
		throw new TypeError("Extension message must be an object.");
	}
	if (!(EXTENSION_MESSAGE_KINDS as readonly string[]).includes(message.kind)) {
		throw new TypeError(`Extension message kind must be one of: ${EXTENSION_MESSAGE_KINDS.join(", ")}.`);
	}
	const title = validateMessageTitle(message.title);
	const validated = validateMessageBody(message, title);
	const size = utf8ByteLength(JSON.stringify(validated));
	if (size > MAX_EXTENSION_MESSAGE_BYTES) {
		throw new RangeError(`Extension message exceeds ${MAX_EXTENSION_MESSAGE_BYTES} UTF-8 bytes.`);
	}
	deepFreeze(validated);
	return validated;
}

function validateMessageTitle(title: string | undefined): string | undefined {
	if (title === undefined) return undefined;
	assertBoundedNonBlankText(title, "Extension message title", MAX_EXTENSION_MESSAGE_TITLE_BYTES);
	return title;
}

function validateMessageBody(message: ExtensionMessage, title: string | undefined): ExtensionMessage {
	switch (message.kind) {
		case "text":
		case "markdown":
			return { kind: message.kind, title, content: validateMessageContent(message.content) };
		case "code":
			return {
				kind: "code",
				title,
				content: validateMessageContent(message.content),
				language: validateMessageLanguage(message.language),
			};
		case "table":
			return validateTableMessage(message, title);
		case "fields":
			return validateFieldsMessage(message, title);
		case "diff":
			return {
				kind: "diff",
				title,
				path:
					message.path === undefined
						? undefined
						: assertBoundedNonBlankText(message.path, "Extension message path", MAX_EXTENSION_MESSAGE_PATH_BYTES),
				patch: validateMessageContent(message.patch, "Extension message patch"),
			};
		case "banner":
			return {
				kind: "banner",
				title,
				severity: validateTone(message.severity, "Extension message banner severity"),
				content: validateMessageContent(message.content),
			};
	}
}

function validateMessageContent(content: string, label = "Extension message content"): string {
	if (typeof content !== "string" || content.length === 0) {
		throw new TypeError(`${label} must be a non-empty string.`);
	}
	if (utf8ByteLength(content) > MAX_EXTENSION_MESSAGE_CONTENT_BYTES) {
		throw new RangeError(`${label} exceeds ${MAX_EXTENSION_MESSAGE_CONTENT_BYTES} UTF-8 bytes.`);
	}
	return content;
}

const EXTENSION_MESSAGE_LANGUAGE_PATTERN = /^[a-zA-Z0-9._+#-]+$/;

function validateMessageLanguage(language: string | undefined): string | undefined {
	if (language === undefined) return undefined;
	if (typeof language !== "string" || !EXTENSION_MESSAGE_LANGUAGE_PATTERN.test(language)) {
		throw new TypeError("Extension message language must contain only letters, numbers, '.', '_', '+', '#', and '-'.");
	}
	if (utf8ByteLength(language) > MAX_EXTENSION_MESSAGE_LANGUAGE_BYTES) {
		throw new RangeError(`Extension message language exceeds ${MAX_EXTENSION_MESSAGE_LANGUAGE_BYTES} UTF-8 bytes.`);
	}
	return language;
}

function validateTableMessage(message: ExtensionTableMessage, title: string | undefined): ExtensionTableMessage {
	if (!Array.isArray(message.columns) || message.columns.length === 0) {
		throw new TypeError("Extension message columns must be a non-empty array.");
	}
	if (message.columns.length > MAX_EXTENSION_MESSAGE_TABLE_COLUMNS) {
		throw new RangeError(`Extension message columns exceed ${MAX_EXTENSION_MESSAGE_TABLE_COLUMNS} entries.`);
	}
	const columns = mapDenseArray(message.columns, "Extension message columns", (column): ExtensionTableColumn => {
		if (typeof column !== "object" || column === null) {
			throw new TypeError("Extension message column must be an object.");
		}
		assertBoundedText(column.label, "Extension message column label", MAX_EXTENSION_MESSAGE_CELL_BYTES);
		if (column.align !== undefined && !(EXTENSION_TABLE_ALIGNMENTS as readonly string[]).includes(column.align)) {
			throw new TypeError(`Extension message column align must be one of: ${EXTENSION_TABLE_ALIGNMENTS.join(", ")}.`);
		}
		return { label: column.label, align: column.align };
	});
	if (!Array.isArray(message.rows)) {
		throw new TypeError("Extension message rows must be an array.");
	}
	if (message.rows.length > MAX_EXTENSION_MESSAGE_TABLE_ROWS) {
		throw new RangeError(`Extension message rows exceed ${MAX_EXTENSION_MESSAGE_TABLE_ROWS} entries.`);
	}
	// A ragged row leaves a renderer guessing which column a cell belongs to,
	// which is exactly the guess this kind exists to remove.
	const rows = mapDenseArray(message.rows, "Extension message rows", (row) => {
		if (!Array.isArray(row) || row.length !== columns.length) {
			throw new TypeError(`Extension message row must be an array of ${columns.length} cells.`);
		}
		return mapDenseArray(row, "Extension message row", (cell) => {
			assertBoundedText(cell, "Extension message cell", MAX_EXTENSION_MESSAGE_CELL_BYTES);
			return cell;
		});
	});
	return { kind: "table", title, columns, rows };
}

function validateFieldsMessage(message: ExtensionFieldsMessage, title: string | undefined): ExtensionFieldsMessage {
	if (!Array.isArray(message.fields) || message.fields.length === 0) {
		throw new TypeError("Extension message fields must be a non-empty array.");
	}
	if (message.fields.length > MAX_EXTENSION_MESSAGE_FIELDS) {
		throw new RangeError(`Extension message fields exceed ${MAX_EXTENSION_MESSAGE_FIELDS} entries.`);
	}
	const fields = mapDenseArray(message.fields, "Extension message fields", (field): ExtensionMessageField => {
		if (typeof field !== "object" || field === null) {
			throw new TypeError("Extension message field must be an object.");
		}
		assertBoundedNonBlankText(field.label, "Extension message field label", MAX_EXTENSION_MESSAGE_CELL_BYTES);
		assertBoundedText(field.value, "Extension message field value", MAX_EXTENSION_MESSAGE_CELL_BYTES);
		return {
			label: field.label,
			value: field.value,
			tone: field.tone === undefined ? undefined : validateTone(field.tone, "Extension message field tone"),
		};
	});
	return { kind: "fields", title, fields };
}

/**
 * Array.prototype.map skips empty slots, which would turn into null when the
 * accepted message is serialized. Visit indices explicitly so every admitted
 * array has the same shape before and after persistence.
 */
function mapDenseArray<TInput, TOutput>(
	values: readonly TInput[],
	label: string,
	transform: (value: TInput) => TOutput,
): TOutput[] {
	const result: TOutput[] = [];
	for (let index = 0; index < values.length; index += 1) {
		if (!Object.hasOwn(values, index)) {
			throw new TypeError(`${label} must not contain empty slots.`);
		}
		result.push(transform(values[index] as TInput));
	}
	return result;
}

function deepFreeze(value: unknown): void {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return;
	}
	for (const child of Object.values(value)) deepFreeze(child);
	Object.freeze(value);
}

const EXTENSION_PRESENTATION_TYPE_PATTERN = /^[a-zA-Z0-9._:-]+$/;

export function validateExtensionInputPresentation(
	presentation: ExtensionInputPresentation,
): ExtensionInputPresentation {
	if (typeof presentation !== "object" || presentation === null) {
		throw new TypeError("Extension input presentation must be an object.");
	}
	const customType = presentation.customType;
	if (typeof customType !== "string" || !EXTENSION_PRESENTATION_TYPE_PATTERN.test(customType)) {
		throw new TypeError(
			"Extension input presentation customType must contain only letters, numbers, '.', '_', ':', and '-'.",
		);
	}
	if (utf8ByteLength(customType) > MAX_EXTENSION_PRESENTATION_TYPE_BYTES) {
		throw new RangeError(
			`Extension input presentation customType exceeds ${MAX_EXTENSION_PRESENTATION_TYPE_BYTES} UTF-8 bytes.`,
		);
	}
	const result: { customType: string; title?: string; details?: JsonValue } = { customType };
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
		result.details = normalizeJsonValue(
			presentation.details,
			"Extension input presentation details",
			MAX_EXTENSION_PRESENTATION_DETAILS_BYTES,
		);
	}
	return result;
}

export function cloneExtensionInputPresentation(presentation: ExtensionInputPresentation): ExtensionInputPresentation {
	return structuredClone(presentation);
}

const EXTENSION_DIAGNOSTIC_CODE_PATTERN = /^[a-zA-Z0-9_.-]+$/;

export function validateExtensionDiagnosticDraft(draft: ExtensionDiagnosticDraft): ExtensionDiagnosticDraft {
	if (typeof draft !== "object" || draft === null) {
		throw new TypeError("Extension diagnostic draft must be an object.");
	}
	if (!(EXTENSION_DIAGNOSTIC_SEVERITIES as readonly string[]).includes(draft.severity)) {
		throw new TypeError(`Extension diagnostic severity must be one of: ${EXTENSION_DIAGNOSTIC_SEVERITIES.join(", ")}.`);
	}
	if (typeof draft.code !== "string" || !EXTENSION_DIAGNOSTIC_CODE_PATTERN.test(draft.code)) {
		throw new TypeError("Extension diagnostic code must contain only letters, numbers, '.', '_', and '-'.");
	}
	if (utf8ByteLength(draft.code) > MAX_EXTENSION_DIAGNOSTIC_CODE_BYTES) {
		throw new RangeError(`Extension diagnostic code exceeds ${MAX_EXTENSION_DIAGNOSTIC_CODE_BYTES} UTF-8 bytes.`);
	}
	assertBoundedNonBlankText(draft.message, "Extension diagnostic message", MAX_EXTENSION_DIAGNOSTIC_MESSAGE_BYTES);
	return { severity: draft.severity, code: draft.code, message: draft.message };
}

export function cloneExtensionStatus(status: ExtensionStatus): ExtensionStatus {
	return {
		text: status.text,
		progress: status.progress ? { completed: status.progress.completed, total: status.progress.total } : undefined,
		region: status.region,
		icon: status.icon,
		tone: status.tone,
	};
}

function assertBoundedNonBlankText(value: string, label: string, maxBytes: number): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${label} must be a non-blank string.`);
	}
	const size = utf8ByteLength(value);
	if (size > maxBytes) {
		throw new RangeError(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
	}
	return value;
}

// Cells and field values may be empty: a blank cell is data, unlike a blank
// title or label, which is a mistake.
function assertBoundedText(value: string, label: string, maxBytes: number): string {
	if (typeof value !== "string") {
		throw new TypeError(`${label} must be a string.`);
	}
	if (utf8ByteLength(value) > maxBytes) {
		throw new RangeError(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
	}
	return value;
}

function assertNonNegativeInteger(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new RangeError(`${label} must be a non-negative integer.`);
	}
}
