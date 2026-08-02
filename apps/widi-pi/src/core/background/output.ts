/**
 * The output stream of a background job: one append-only byte stream with two
 * bounded windows over it. A backgrounded tool has nowhere else to put its
 * output - its tool call is already closed - and the two consumers of that
 * stream want different things from it, neither of them unbounded.
 */

/** Default rolling cap for a background job's output tail: 1 MiB. */
export const DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES = 1024 * 1024;

/**
 * Default cap on the unforwarded progress-increment buffer: 1 MiB. Overflow
 * drops from the head and is counted, leaving a detectable gap.
 */
export const DEFAULT_BACKGROUND_JOB_INCREMENT_MAX_BYTES = 1024 * 1024;

/**
 * Default cooperative circuit-breaker ceiling on one job's total output: 16 MiB.
 * Both windows are already bounded, so this is about a runaway producer burning
 * CPU, not about memory. It cannot limit output a tool never appends here.
 */
export const DEFAULT_BACKGROUND_JOB_OUTPUT_CEILING_BYTES = 16 * 1024 * 1024;

/**
 * A drained progress increment: the run of new output bytes since the previous
 * drain, at absolute offsets into the job's stream. After a head drop
 * `startByte` jumps past the previous `endByte`.
 */
export interface BackgroundJobOutputIncrement {
	/** Base64; a UTF-8 character may span two increments, so decode in order. */
	readonly chunk: string;
	/** Absolute offset of the first byte in `chunk`. */
	readonly startByte: number;
	/** Absolute offset just past the last byte in `chunk` (equals totalBytesSeen). */
	readonly endByte: number;
	/** Total bytes ever appended to the job at drain time. */
	readonly totalBytesSeen: number;
	/** Cumulative bytes dropped from the increment buffer and never forwarded. */
	readonly progressDroppedBytes: number;
}

/**
 * Two independent windows over one appended stream: the rolling tail
 * ({@link read}) is the last `maxBytes` bytes, a point-in-time peek; the
 * increment buffer ({@link drainIncrement}) is the run not yet forwarded to
 * progress listeners, cleared on each emit and capped separately.
 *
 * A head drop can slice the tail mid-character, which is acceptable for a peek.
 * Increments stay byte-exact because they are returned as Base64.
 */
export class BackgroundJobOutput {
	private readonly _chunks: Buffer[] = [];
	private _byteLength = 0;
	private readonly _maxBytes: number;

	private readonly _incChunks: Buffer[] = [];
	private _incByteLength = 0;
	private _incStartOffset = 0;
	private readonly _incMaxBytes: number;

	private _totalBytesSeen = 0;
	private _progressDroppedBytes = 0;
	private readonly _onAppend?: () => void;

	constructor(
		maxBytes: number = DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES,
		options: {
			onAppend?: () => void;
			incrementMaxBytes?: number;
		} = {},
	) {
		this._maxBytes = maxBytes;
		this._incMaxBytes =
			options.incrementMaxBytes ?? DEFAULT_BACKGROUND_JOB_INCREMENT_MAX_BYTES;
		this._onAppend = options.onAppend;
	}

	/** Total bytes ever appended, including bytes since dropped from either window. */
	get totalBytesSeen(): number {
		return this._totalBytesSeen;
	}

	/** Total bytes dropped from the rolling tail to keep it within its cap. */
	get tailDroppedBytes(): number {
		return this._totalBytesSeen - this._byteLength;
	}

	/** Cumulative bytes dropped from the progress buffer and never forwarded. */
	get progressDroppedBytes(): number {
		return this._progressDroppedBytes;
	}

	/**
	 * @deprecated Use {@link progressDroppedBytes}. Kept while existing event
	 * consumers migrate to the two explicit counters.
	 */
	get droppedBytes(): number {
		return this.progressDroppedBytes;
	}

	/** Append a chunk of output, feeding both the rolling tail and the increment. */
	append(chunk: Buffer | string): void {
		const buffer =
			typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
		if (buffer.length === 0) return;
		this._totalBytesSeen += buffer.length;

		this._chunks.push(buffer);
		this._byteLength += buffer.length;
		this._byteLength = trimHead(this._chunks, this._byteLength, this._maxBytes);

		if (this._incByteLength === 0) {
			this._incStartOffset = this._totalBytesSeen - buffer.length;
		}
		this._incChunks.push(buffer);
		this._incByteLength += buffer.length;
		const beforeTrim = this._incByteLength;
		this._incByteLength = trimHead(
			this._incChunks,
			this._incByteLength,
			this._incMaxBytes,
		);
		const dropped = beforeTrim - this._incByteLength;
		if (dropped > 0) {
			this._incStartOffset += dropped;
			this._progressDroppedBytes += dropped;
		}

		this._onAppend?.();
	}

	/** Current tail decoded as UTF-8. */
	read(): string {
		return Buffer.concat(this._chunks, this._byteLength).toString("utf-8");
	}

	/**
	 * Drain and clear the unforwarded increment. Returns undefined when nothing
	 * new has been appended since the previous drain, so a progress pump can skip
	 * emitting an empty event.
	 */
	drainIncrement(): BackgroundJobOutputIncrement | undefined {
		if (this._incByteLength === 0) return undefined;
		const startByte = this._incStartOffset;
		const chunk = Buffer.concat(this._incChunks, this._incByteLength).toString(
			"base64",
		);
		const endByte = startByte + this._incByteLength;
		this._incChunks.length = 0;
		this._incByteLength = 0;
		this._incStartOffset = endByte;
		return {
			chunk,
			startByte,
			endByte,
			totalBytesSeen: this._totalBytesSeen,
			progressDroppedBytes: this._progressDroppedBytes,
		};
	}
}

/** Trim from the head back within `maxBytes`, returning the new total. */
function trimHead(
	chunks: Buffer[],
	byteLength: number,
	maxBytes: number,
): number {
	while (byteLength > maxBytes) {
		const head = chunks[0];
		if (byteLength - head.length >= maxBytes) {
			chunks.shift();
			byteLength -= head.length;
			continue;
		}
		// Keep just the head chunk's tail, copied rather than sliced: a view would
		// pin the whole parent allocation for as long as it sits at the head.
		const overflow = byteLength - maxBytes;
		chunks[0] = Buffer.from(head.subarray(overflow));
		byteLength -= overflow;
		break;
	}
	return byteLength;
}
