import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { journalPath } from "../flow/discover.ts";
import type { Flow, FlowJournalRecord } from "../flow/document.ts";
import type { FlowValue } from "../flow/schema.ts";

/**
 * A flow's own JSONL, beside its file rather than on the session branch.
 *
 * Session entries replay into a model's context on every resume and fork into
 * every child session; a run's record wants neither. It wants to be appended
 * once, read by whatever consumes the results, and kept as long as the person
 * keeps the file.
 */
export class RunJournal {
	private readonly _path: string;
	private readonly _records: readonly FlowJournalRecord[];
	private _ready = false;

	constructor(path: string, records: readonly FlowJournalRecord[]) {
		this._path = path;
		this._records = records;
	}

	/** Absent when the flow declared no journal, or when the project is not trusted. */
	static of(flow: Flow, trusted: boolean): RunJournal | undefined {
		const path = journalPath(flow);
		if (flow.journal === undefined || path === undefined || !trusted) return undefined;
		return new RunJournal(path, flow.journal.records);
	}

	get path(): string {
		return this._path;
	}

	async write(record: FlowJournalRecord, fields: { readonly [key: string]: FlowValue }): Promise<void> {
		if (!this._records.includes(record)) return;
		if (!this._ready) {
			await mkdir(dirname(this._path), { recursive: true });
			this._ready = true;
		}
		await appendFile(this._path, `${JSON.stringify({ record, at: new Date().toISOString(), ...fields })}\n`, "utf8");
	}
}
