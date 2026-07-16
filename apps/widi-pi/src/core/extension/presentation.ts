export const MAX_EXTENSION_OUTPUT_BYTES = 65_536;
export const MAX_EXTENSION_STATUS_KEY_BYTES = 128;
export const MAX_EXTENSION_STATUS_TEXT_BYTES = 4_096;

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
