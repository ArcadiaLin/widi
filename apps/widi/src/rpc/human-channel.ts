/**
 * The human-request half of the protocol, owned separately from the server.
 *
 * It has to be separate: `createWidiRuntime` can ask a human before the
 * orchestrator exists - the "ask" project-trust policy runs through the broker
 * during startup (`core/runtime-service.ts`) - and a channel that only came up
 * with the server would have nobody to ask. This needs no orchestrator, only
 * the outbound writer, so it is built first and handed to both.
 *
 * That mirrors what the TUI does with `StartupHumanPrompt`, minus the placeholder:
 * here the boot-phase asker and the running-phase asker are one object.
 *
 * Every request this channel abandons is announced with `human_request_withdrawn`.
 * Core's own withdrawal events (`human_request_timeout`, `_cancelled`) only cover
 * withdrawals core decided, and none of the three reaches the client when the
 * *handler* is the one giving up - which is exactly the abort, timeout and
 * shutdown paths below. Without the frame the client would hold a prompt open
 * against a request nobody will ever read an answer to.
 */

import type { HumanRequestEnvelope, HumanResponse } from "../core/human-request.ts";
import { RpcError } from "./errors.ts";
import type { RpcHumanOutboundFrame, RpcHumanResponseFrame } from "./types.ts";

interface PendingRequest {
	readonly resolve: (response: HumanResponse) => void;
	readonly reject: (error: Error) => void;
	readonly cleanup: () => void;
}

export interface RpcHumanChannelOptions {
	readonly send: (frame: RpcHumanOutboundFrame) => void;
	/**
	 * How long to hold a request open with no answer and no cancel. Unset means
	 * forever, which is right for an interactive client and wrong for a batch one
	 * that answers nothing: there the agent would wait out the whole run.
	 */
	readonly timeoutMs?: number;
}

export class RpcHumanChannel {
	private readonly _send: (frame: RpcHumanOutboundFrame) => void;
	private readonly _timeoutMs: number | undefined;
	private readonly _pending = new Map<string, PendingRequest>();

	constructor(options: RpcHumanChannelOptions) {
		this._send = options.send;
		this._timeoutMs = options.timeoutMs;
	}

	/** The `HumanRequestHandler` shape, bound so it can be passed as a value. */
	readonly request = (request: HumanRequestEnvelope, signal?: AbortSignal): Promise<HumanResponse> => {
		return new Promise<HumanResponse>((resolve, reject) => {
			const withdraw = (error: RpcError): void => {
				if (!this._pending.delete(request.id)) return;
				cleanup();
				this._send({ type: "human_request_withdrawn", requestId: request.id, reason: error.message });
				reject(error);
			};
			const onAbort = () => withdraw(new RpcError("aborted", `Human request ${request.id} was aborted.`));
			const timer =
				this._timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							withdraw(
								new RpcError("timeout", `Human request ${request.id} went unanswered for ${this._timeoutMs}ms.`),
							);
						}, this._timeoutMs);
			const cleanup = () => {
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};

			signal?.addEventListener("abort", onAbort, { once: true });
			this._pending.set(request.id, { resolve, reject, cleanup });
			this._send({ type: "human_request", request });
		});
	};

	/**
	 * Settle a parked request from an inbound frame. Returns false when the id is
	 * unknown, which the caller answers as a protocol error rather than ignoring:
	 * a client that answers a request twice has lost track of its own state.
	 */
	settle(frame: RpcHumanResponseFrame): boolean {
		const pending = this._pending.get(frame.requestId);
		if (!pending) return false;
		this._pending.delete(frame.requestId);
		pending.cleanup();
		if ("cancelled" in frame) {
			pending.reject(new RpcError("aborted", `Human request ${frame.requestId} was cancelled by the client.`));
			return true;
		}
		pending.resolve(frame.response);
		return true;
	}

	/** Abandon everything parked; used when the input stream ends. */
	closeAll(reason: string): void {
		for (const [requestId, pending] of [...this._pending]) {
			this._pending.delete(requestId);
			pending.cleanup();
			this._send({ type: "human_request_withdrawn", requestId, reason });
			pending.reject(new RpcError("shutting_down", reason));
		}
	}
}
