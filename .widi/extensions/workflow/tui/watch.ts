import type { WidiTuiExtensionApi } from "../../../../apps/widi/src/tui/extension-host/index.ts";
import { readFinished, readStarted, WORKFLOW_EVENT, type WorkflowFinishedPayload } from "../protocol.ts";

/** How long a trigger may go unanswered before it is treated as unheard. */
const ACKNOWLEDGE_MS = 5_000;

interface Pending {
	readonly workflow: string;
	acknowledge(): void;
	settle(finished: WorkflowFinishedPayload): void;
}

/**
 * Turns the two outbound events back into one awaited answer.
 *
 * One subscription, because the TUI half can only subscribe at activation time,
 * and one pending run, because the core half refuses a second one anyway.
 */
export class WorkflowWatch {
	private _pending: Pending | undefined;

	constructor(api: WidiTuiExtensionApi) {
		api.onExtensionEvent(WORKFLOW_EVENT.started, (event) => {
			if (readStarted(event.payload)?.workflow === this._pending?.workflow) this._pending?.acknowledge();
		});
		api.onExtensionEvent(WORKFLOW_EVENT.finished, (event) => {
			const finished = readFinished(event.payload);
			if (finished !== undefined) this._pending?.settle(finished);
		});
	}

	watch(workflow: string): Promise<WorkflowFinishedPayload> {
		if (this._pending !== undefined) {
			return Promise.reject(new Error(`A ${this._pending.workflow} run is already being watched.`));
		}
		return new Promise<WorkflowFinishedPayload>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = (finish: () => void): void => {
				if (timer !== undefined) clearTimeout(timer);
				this._pending = undefined;
				finish();
			};
			// Nothing answers when no runtime loaded the extension, or when the agent
			// the trigger was attributed to is not the one that has it. Say so rather
			// than waiting out a run that was never started.
			timer = setTimeout(() => {
				settle(() => reject(new Error(`No agent runtime acknowledged the ${workflow} run.`)));
			}, ACKNOWLEDGE_MS);
			this._pending = {
				workflow,
				acknowledge: () => {
					if (timer !== undefined) clearTimeout(timer);
					timer = undefined;
				},
				settle: (finished) => {
					if (finished.workflow === workflow) settle(() => resolve(finished));
				},
			};
		});
	}
}
