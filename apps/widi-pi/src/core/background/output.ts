/**
 * The output stream of a background job: one append-only byte stream with two
 * bounded windows over it.
 *
 * A backgrounded tool has nowhere to put its output - its tool call is already
 * closed - so it feeds the bytes here instead. Two consumers want different
 * things from that one stream, and neither may grow without bound, which is why
 * the windows are separate rather than one shared buffer.
 */

/** Default rolling cap for a background job's output tail: 1 MiB. */
export const DEFAULT_BACKGROUND_JOB_OUTPUT_MAX_BYTES = 1024 * 1024;

/**
 * Default cap on the unforwarded progress-increment buffer: 1 MiB. Bounds the
 * bytes held between two progress drains so a producer that outpaces the emit
 * pump cannot grow memory without limit; overflow drops from the head and is
 * counted as `progressDroppedBytes`, leaving a detectable gap in the byte
 * stream.
 */
export const DEFAULT_BACKGROUND_JOB_INCREMENT_MAX_BYTES = 1024 * 1024;

/**
 * Default cooperative circuit-breaker ceiling on the total output a single
 * background job streams through `context.job.output`: 16 MiB. Since the
 * rolling tail and increment buffer are both bounded, memory is already safe;
 * this ceiling instead requests termination of a runaway producer (for example
 * a command stuck streaming forever) that would otherwise burn CPU
 * indefinitely. It cannot limit output a tool does not append here, nor the
 * size of the tool's eventual result.
 */
export const DEFAULT_BACKGROUND_JOB_OUTPUT_CEILING_BYTES = 16 * 1024 * 1024;

/**
 * A drained progress increment: the contiguous run of new output bytes since
 * the previous drain, addressed by absolute byte offsets into the job's total
 * output stream. When the increment buffer overflowed and dropped from the head
 * between drains, `startByte` jumps past the previous `endByte`; the gap size is
 * reflected in the monotonically growing `progressDroppedBytes`.
 */
export interface BackgroundJobOutputIncrement {
	/**
	 * Retained output bytes for this increment, encoded as Base64. Decoding this
	 * value yields exactly `endByte - startByte` bytes; consumers must not treat
	 * each increment as an independently decodable UTF-8 string because a
	 * character may span two increments.
	 */
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
 * Bounded rolling tail plus a bounded forward increment of a background job's
 * output.
 *
 * A backgrounded tool feeds its output straight in via {@link append}. Two
 * independent windows are maintained over that one stream:
 *
 * - the rolling tail ({@link read}) is the last `maxBytes` bytes, a point-in-time
 *   peek for read_job; older bytes are dropped from the head to stay in budget.
 * - the increment buffer ({@link drainIncrement}) is the run of bytes not yet
 *   forwarded to progress listeners; it is drained (and cleared) on each emit,
 *   and capped separately so a fast producer between drains cannot grow memory
 *   without bound.
 *
 * The rolling tail can slice a UTF-8 character mid-sequence at a head drop; that
 * is acceptable for a progress peek, and decoding emits a replacement character
 * rather than throwing. Progress increments remain byte-exact because they are
 * returned as Base64 rather than decoded independently.
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

/**
 * Trim `chunks` from the head until the running byte total is back within
 * `maxBytes`, slicing the boundary chunk rather than pinning an oversized parent
 * allocation. Returns the new total.
 */
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
		// Dropping the whole head would fall under the cap; keep just its tail so
		// the buffer holds exactly the last maxBytes bytes. Copy instead of
		// subarray: a view would pin the full parent allocation of an oversized
		// chunk for as long as it stays at the head of a quiet job.
		const overflow = byteLength - maxBytes;
		chunks[0] = Buffer.from(head.subarray(overflow));
		byteLength -= overflow;
		break;
	}
	return byteLength;
}
