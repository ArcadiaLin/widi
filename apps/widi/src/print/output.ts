/**
 * Where a run's frames go, and the one thing the session knows about output.
 *
 * The session produces frames and nothing else; a format decides what a frame
 * looks like. That split is what keeps `--output text` from being a second
 * description of the run: both formats see the same frames in the same order,
 * so a text run and a json run can never disagree about what happened.
 *
 * `drain` is not cosmetic. It is the same coupling RPC relies on: the write tail
 * is awaited after every frame, so a consumer that reads slowly throttles the
 * model loop instead of growing a queue in this process.
 */

import { serializeJsonLine } from "../rpc/jsonl.ts";
import type { PrintFrame } from "./frames.ts";

/** A text sink with backpressure. `ProtocolStdout` is one. */
export interface PrintWriter {
	write(text: string): void;
	drain(): Promise<void>;
}

export interface PrintOutput {
	emit(frame: PrintFrame): void;
	drain(): Promise<void>;
}

/** JSONL: one frame per line, which is the format a driver parses. */
export class PrintJsonOutput implements PrintOutput {
	private readonly _writer: PrintWriter;

	constructor(writer: PrintWriter) {
		this._writer = writer;
	}

	emit(frame: PrintFrame): void {
		this._writer.write(serializeJsonLine(frame));
	}

	async drain(): Promise<void> {
		await this._writer.drain();
	}
}
