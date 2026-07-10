/**
 * Stateful stdout writer for interleaved assistant content streams.
 *
 * Pi content indexes may remain open concurrently, so a delayed
 * `thinking_end` does not necessarily arrive before the first text delta.
 * This writer keeps the linear CLI markers balanced as the active content
 * switches between thinking and text.
 */
export class CliStreamWriter {
	private readonly _write: (text: string) => void;
	private _lineOpen = false;
	private _thinkingOpen = false;

	constructor(write: (text: string) => void) {
		this._write = write;
	}

	writeLine(text: string): void {
		this.endThinking();
		this._writeLine(text);
	}

	writeTextDelta(text: string): void {
		this.endThinking();
		this._writeDelta(text);
	}

	startThinking(): void {
		if (this._thinkingOpen) return;
		this._writeLine("[thinking]");
		this._thinkingOpen = true;
	}

	writeThinkingDelta(text: string): void {
		this.startThinking();
		this._writeDelta(text);
	}

	endThinking(): void {
		if (!this._thinkingOpen) return;
		this._writeLine("[/thinking]");
		this._thinkingOpen = false;
	}

	endMessage(): void {
		this.endThinking();
	}

	private _writeLine(text: string): void {
		if (this._lineOpen) {
			this._write("\n");
			this._lineOpen = false;
		}
		this._write(`${text}\n`);
	}

	private _writeDelta(text: string): void {
		this._lineOpen = true;
		this._write(text);
	}
}
