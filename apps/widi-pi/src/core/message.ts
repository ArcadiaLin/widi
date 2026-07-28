/**
 * Agent message domain.
 *
 * Everything an agent reads as user input is a message: human text, an
 * agent-to-agent message, a background job result (t1), or a system notice.
 * This module owns what a message is, how extensions may transform or reject
 * it, how its model-facing text is rendered, and in what order concurrent
 * messages reach one target's harness.
 *
 * It deliberately owns no runtime state beyond per-target delivery order. The
 * agent registry, harness references, extension runners, and session
 * persistence stay in the orchestrator and are injected as ports, so the
 * dependency edge runs one way: orchestrator -> message.
 */

import { AgentHarnessError } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentId, PromptExpansion } from "./types.ts";

/**
 * Trusted origin of a message. Never derived from model-supplied arguments:
 * a tool call carries only its target and body, and the caller identity is
 * injected from the tool adapter context so an agent cannot forge a sender.
 */
export type MessageSource =
	| {
			readonly kind: "human";
			/** Interaction-layer inline expansion recorded alongside the prompt. */
			readonly expansion?: PromptExpansion;
	  }
	| { readonly kind: "agent"; readonly agentId: AgentId }
	| {
			readonly kind: "background_job";
			readonly ownerAgentId: AgentId;
			readonly jobId: string;
	  }
	| { readonly kind: "system"; readonly name: string };

/**
 * Caller intent, not a harness method. The harness method is chosen at delivery
 * time from the target's live phase: `next_turn` never preempts the reasoning
 * of a turn already in flight, `interrupt` does.
 */
export type MessageDeliveryMode = "next_turn" | "interrupt";

export interface MessageDraft {
	readonly source: MessageSource;
	readonly targetAgentId: AgentId;
	/** Semantic body, before any source attribution is rendered onto it. */
	readonly body: string;
	readonly images?: readonly ImageContent[];
	readonly mode: MessageDeliveryMode;
}

/**
 * Delivery-relevant state of a target, which `AgentLifecycleStatus` alone
 * cannot express: its `running` covers both an agent loop that consumes queued
 * input and maintenance work (compaction, branch summary) that does not. The
 * harness tracks this precisely in its private `phase`, but exposes no getter,
 * so the orchestrator derives it from the operations it starts.
 */
export type MessageDeliveryPhase =
	| "idle"
	| "turn"
	| "maintenance"
	| "creating"
	| "gone";

export type MessageDeliveryMethod = "prompt" | "follow_up" | "steer";

export type MessageDeliveryDecision =
	| { readonly kind: "deliver"; readonly method: MessageDeliveryMethod }
	| { readonly kind: "defer" }
	| { readonly kind: "reject"; readonly reason: string };

/**
 * Result of running the extension input pipeline over a message. Structurally
 * the extension runner's own run type minus its diagnostics, so the
 * orchestrator can pass its run straight through without translation.
 */
export type MessageInterceptRun =
	| { readonly kind: "pass" }
	| {
			readonly kind: "transform";
			readonly text: string;
			readonly images?: readonly ImageContent[];
			readonly transformedBy: readonly string[];
	  }
	| {
			readonly kind: "block";
			readonly reason?: string;
			readonly blockedBy: string;
	  };

export interface MessageInterceptEvent {
	readonly type: "input";
	readonly source: MessageSource;
	readonly targetAgentId: AgentId;
	readonly text: string;
	readonly images?: readonly ImageContent[];
}

export type MessageTransformOutcome =
	| {
			readonly kind: "pass";
			readonly text: string;
			readonly images?: readonly ImageContent[];
	  }
	| {
			readonly kind: "transform";
			readonly text: string;
			readonly images?: readonly ImageContent[];
			readonly transformedBy: readonly string[];
	  }
	| {
			readonly kind: "block";
			readonly reason?: string;
			readonly blockedBy: string;
	  };

/**
 * What a `block` from the input pipeline means for this source.
 *
 * `enforce` ends the message: the human sees a blocked input, an agent sees its
 * tool call fail. `ignore` is reserved for background job results, where the
 * model already holds the job handle from t0 and is waiting for exactly one
 * result; dropping it would strand the model forever. There, a block degrades
 * to a diagnostic and the original body is delivered.
 */
export type MessageBlockPolicy = "enforce" | "ignore";

export function messageBlockPolicy(source: MessageSource): MessageBlockPolicy {
	return source.kind === "background_job" ? "ignore" : "enforce";
}

/**
 * Result of accepting a message. A block is a normal outcome, not a failure:
 * the caller decides how to say so - a surface shows a notice, a tool call
 * fails. Sources whose block policy is `ignore` never produce it.
 */
export type MessageSendOutcome =
	| { readonly kind: "accepted" }
	| {
			readonly kind: "blocked";
			readonly inputId: string;
			readonly reason?: string;
			readonly blockedBy: string;
	  };

export type MessageErrorCode =
	| "message_invalid"
	| "target_unavailable"
	| "delivery_rejected";

export class MessageError extends Error {
	readonly code: MessageErrorCode;

	constructor(code: MessageErrorCode, message: string) {
		super(message);
		this.name = "MessageError";
		this.code = code;
	}
}

export function assertMessageBody(body: string): void {
	if (typeof body !== "string" || body.trim().length === 0) {
		throw new MessageError(
			"message_invalid",
			"Message body must be a non-empty string.",
		);
	}
}

/**
 * Render the model-facing text for a message. Applied after interception, so
 * extensions see the semantic body and cannot forge an attribution prefix.
 */
export function renderMessageEnvelope(
	source: MessageSource,
	text: string,
): string {
	switch (source.kind) {
		case "human":
			// Human input is the model's baseline user message: no prefix, so
			// existing sessions and prompt behavior are unchanged.
			return text;
		case "agent":
			return `[Message from ${source.agentId}]\n\n${text}`;
		case "background_job":
			// Job results already carry their own job id, tool, and status header.
			return text;
		case "system":
			return `[Message from ${source.name}]\n\n${text}`;
	}
}

/**
 * Body of a task assignment. The task id is the owner's background job id, so
 * completion is a settlement of that job rather than a second message protocol.
 */
export function formatAgentTaskMessageBody(input: {
	readonly ownerAgentId: AgentId;
	readonly taskId: string;
	readonly task: string;
}): string {
	return (
		`Task ${input.taskId} assigned to you.\n\n${input.task}\n\n` +
		`When the work is complete, settle task ${input.taskId} for ` +
		`${input.ownerAgentId}. An ordinary message does not complete it.`
	);
}

export interface MessageTransformPorts {
	/**
	 * Run the target's extension input pipeline. Returns `pass` when the target
	 * has no live extension runtime.
	 */
	readonly intercept: (
		event: MessageInterceptEvent,
	) => Promise<MessageInterceptRun>;
}

/**
 * Apply the extension input pipeline to a draft and resolve the block policy
 * for its source. An ignored block keeps the original body: the pipeline
 * reports no text for a run it ended, and earlier handlers' rewrites are not
 * partially applied.
 */
export async function transformMessage(
	draft: MessageDraft,
	ports: MessageTransformPorts,
): Promise<MessageTransformOutcome> {
	const run = await ports.intercept({
		type: "input",
		source: draft.source,
		targetAgentId: draft.targetAgentId,
		text: draft.body,
		images: draft.images,
	});
	if (run.kind === "transform") {
		return {
			kind: "transform",
			text: run.text,
			images: run.images ?? draft.images,
			transformedBy: run.transformedBy,
		};
	}
	if (run.kind === "block" && messageBlockPolicy(draft.source) === "enforce") {
		return { kind: "block", reason: run.reason, blockedBy: run.blockedBy };
	}
	return { kind: "pass", text: draft.body, images: draft.images };
}

/**
 * Choose how a message reaches the target, given its live phase.
 *
 * `requiresIdle` marks a delivery whose caller awaits the resulting assistant
 * message: it can only be a fresh prompt, so a busy target is a rejection
 * rather than a queued follow-up.
 */
export function decideMessageDelivery(input: {
	readonly phase: MessageDeliveryPhase;
	readonly mode: MessageDeliveryMode;
	readonly requiresIdle: boolean;
	readonly targetAgentId: AgentId;
}): MessageDeliveryDecision {
	const { phase, targetAgentId } = input;
	if (phase === "gone") {
		return {
			kind: "reject",
			reason: `Agent ${targetAgentId} can no longer receive messages.`,
		};
	}
	if (input.requiresIdle && phase !== "idle") {
		return {
			kind: "reject",
			reason: `Agent ${targetAgentId} cannot accept a prompt while ${phase}.`,
		};
	}
	// A spawning agent has no harness yet, and maintenance work does not run an
	// agent loop: a steer or follow-up would be accepted into a queue nothing
	// drains. Both wait for the next phase change instead.
	if (phase === "creating" || phase === "maintenance") return { kind: "defer" };
	if (phase === "idle") return { kind: "deliver", method: "prompt" };
	return {
		kind: "deliver",
		method: input.mode === "interrupt" ? "steer" : "follow_up",
	};
}

/** Outcome of one accepted delivery. */
export interface MessageDeliveryReceipt {
	readonly method: MessageDeliveryMethod;
	/**
	 * The run this delivery started, present only when it began a fresh prompt.
	 * Acceptance never waits for it: `sendMessage` resolves as soon as the
	 * harness owns the text.
	 */
	readonly completed?: Promise<AssistantMessage>;
}

export interface MessageDeliveryRequest {
	readonly agentId: AgentId;
	readonly method: MessageDeliveryMethod;
	readonly text: string;
	readonly images: readonly ImageContent[] | undefined;
	/** The batch contains input submitted directly by the human surface. */
	readonly humanInterrupt: boolean;
	/** True when the enqueuing caller awaits `receipt.completed` itself. */
	readonly awaited: boolean;
}

export interface MessageDeliveryPorts {
	/** Re-read immediately before every delivery attempt, never cached. */
	readonly resolvePhase: (agentId: AgentId) => MessageDeliveryPhase;
	readonly deliver: (
		request: MessageDeliveryRequest,
	) => Promise<MessageDeliveryReceipt>;
}

export interface MessageEnqueueInput {
	readonly targetAgentId: AgentId;
	/** Rendered, post-interception text. */
	readonly text: string;
	readonly images?: readonly ImageContent[];
	readonly mode: MessageDeliveryMode;
	readonly requiresIdle: boolean;
	/** True only for input submitted directly by the human surface. */
	readonly humanInterrupt: boolean;
	/**
	 * Messages sharing a key are merged into one user message when they are
	 * adjacent in the queue. Undefined never merges.
	 */
	readonly mergeKey?: string;
	readonly awaited: boolean;
	/**
	 * Keep the message queued when delivery fails for a reason retrying might
	 * fix, instead of rejecting acceptance. Set for messages whose sender has
	 * already moved on and would otherwise never learn the text was lost - a
	 * background job result the model is waiting for is the motivating case.
	 * A caller awaiting its own run sets it false so the error reaches it.
	 */
	readonly retryOnFailure: boolean;
	/** Notified each time such a failure defers the message. */
	readonly onDeferredFailure?: (error: unknown) => void;
	/**
	 * Internal delivery lifecycle hooks. They run around the actual harness
	 * call, not when the message merely enters this queue, so metadata that must
	 * follow a concrete user message can bind to the correct attempt.
	 */
	readonly onDeliveryStart?: (method: MessageDeliveryMethod) => void;
	readonly onDeliveryFailure?: (error: unknown) => void;
}

interface QueuedMessage {
	readonly text: string;
	readonly images: readonly ImageContent[] | undefined;
	readonly mode: MessageDeliveryMode;
	readonly requiresIdle: boolean;
	readonly humanInterrupt: boolean;
	readonly mergeKey: string | undefined;
	readonly awaited: boolean;
	readonly retryOnFailure: boolean;
	readonly onDeferredFailure: ((error: unknown) => void) | undefined;
	readonly onDeliveryStart:
		| ((method: MessageDeliveryMethod) => void)
		| undefined;
	readonly onDeliveryFailure: ((error: unknown) => void) | undefined;
	readonly resolve: (receipt: MessageDeliveryReceipt) => void;
	readonly reject: (error: unknown) => void;
	settled: boolean;
}

/**
 * Merge key for background job results: consecutive settlements for one target
 * collapse into a single user message, which is what the previous per-agent
 * result buffer did. Other sources stay separate - a human prompt owns its own
 * run, and merging two agents' messages would blur their attribution blocks.
 */
export function backgroundResultMergeKey(mode: MessageDeliveryMode): string {
	return `background_job:${mode}`;
}

/**
 * Per-target FIFO delivery with acceptance-order serialization.
 *
 * Without it, two concurrent sends can both observe an idle target and both
 * call `prompt()`. The queue holds the run right, re-resolves the target phase
 * immediately before each attempt, and releases as soon as the harness accepts
 * the text - never waiting for the model run itself.
 *
 * Ordering is per target only. Nothing here is persisted: a runtime restart
 * drops undelivered messages by design.
 */
export class MessageDeliveryQueue {
	private readonly _ports: MessageDeliveryPorts;
	private readonly _queues = new Map<AgentId, QueuedMessage[]>();
	// The batch currently awaiting its harness call. It is no longer in the
	// queue array, so cancellation has to reach it here or its senders would
	// wait on a promise nothing can settle.
	private readonly _inFlight = new Map<AgentId, QueuedMessage[]>();
	private readonly _draining = new Set<AgentId>();
	private readonly _rerun = new Set<AgentId>();
	private readonly _scheduled = new Set<AgentId>();

	constructor(ports: MessageDeliveryPorts) {
		this._ports = ports;
	}

	/** Accept a message and resolve once the target harness owns its text. */
	enqueue(input: MessageEnqueueInput): Promise<MessageDeliveryReceipt> {
		return new Promise<MessageDeliveryReceipt>((resolve, reject) => {
			const queue = this._queues.get(input.targetAgentId) ?? [];
			queue.push({
				text: input.text,
				images: input.images,
				mode: input.mode,
				requiresIdle: input.requiresIdle,
				humanInterrupt: input.humanInterrupt,
				mergeKey: input.mergeKey,
				awaited: input.awaited,
				retryOnFailure: input.retryOnFailure,
				onDeferredFailure: input.onDeferredFailure,
				onDeliveryStart: input.onDeliveryStart,
				onDeliveryFailure: input.onDeliveryFailure,
				resolve,
				reject,
				settled: false,
			});
			this._queues.set(input.targetAgentId, queue);
			this.wake(input.targetAgentId);
		});
	}

	/**
	 * Re-examine a target's queue after a phase change. Safe to call for an
	 * unchanged phase, and the only way a deferred message resumes.
	 */
	wake(agentId: AgentId): void {
		const queue = this._queues.get(agentId);
		if (!queue || queue.length === 0) return;
		if (this._draining.has(agentId)) {
			this._rerun.add(agentId);
			return;
		}
		if (this._scheduled.has(agentId)) return;
		this._scheduled.add(agentId);
		queueMicrotask(() => {
			this._scheduled.delete(agentId);
			void this._drain(agentId);
		});
	}

	/** Whether any message is still waiting for or being handed to this target. */
	hasPending(agentId: AgentId): boolean {
		return (
			(this._queues.get(agentId)?.length ?? 0) > 0 ||
			(this._inFlight.get(agentId)?.length ?? 0) > 0
		);
	}

	/**
	 * Fail everything outstanding for a target, for example on dispose. This
	 * includes the batch already handed to the harness: its call may never
	 * settle, and its senders must not be left waiting forever.
	 */
	cancel(agentId: AgentId, reason: string): void {
		const outstanding = [
			...(this._queues.get(agentId) ?? []),
			...(this._inFlight.get(agentId) ?? []),
		];
		this._queues.delete(agentId);
		this._inFlight.delete(agentId);
		for (const message of outstanding) {
			this._fail(message, new MessageError("target_unavailable", reason));
		}
	}

	private async _drain(agentId: AgentId): Promise<void> {
		if (this._draining.has(agentId)) return;
		this._draining.add(agentId);
		try {
			for (;;) {
				const queue = this._queues.get(agentId);
				if (!queue || queue.length === 0) break;
				const head = queue[0];
				if (head.settled) {
					queue.shift();
					continue;
				}

				const decision = decideMessageDelivery({
					phase: this._ports.resolvePhase(agentId),
					mode: head.mode,
					requiresIdle: head.requiresIdle,
					targetAgentId: agentId,
				});
				if (decision.kind === "defer") break;
				if (decision.kind === "reject") {
					queue.shift();
					this._fail(
						head,
						new MessageError("delivery_rejected", decision.reason),
					);
					continue;
				}

				const batch = this._takeMergeableBatch(queue);
				const text = batch.map((message) => message.text).join("\n\n");
				// The batch has left the queue array. Publish it so a cancel during
				// the harness call can still settle its senders.
				this._inFlight.set(agentId, batch);
				let failure: { readonly error: unknown } | undefined;
				try {
					for (const message of batch) {
						message.onDeliveryStart?.(decision.method);
					}
					const receipt = await this._ports.deliver({
						agentId,
						method: decision.method,
						text,
						images: head.images,
						humanInterrupt: batch.some((message) => message.humanInterrupt),
						awaited: batch.some((message) => message.awaited),
					});
					for (const message of batch) this._resolve(message, receipt);
				} catch (error) {
					failure = { error };
				} finally {
					if (this._inFlight.get(agentId) === batch) {
						this._inFlight.delete(agentId);
					}
				}
				if (!failure) continue;
				for (const message of batch) {
					message.onDeliveryFailure?.(failure.error);
				}

				// `busy` and `invalid_state` are expected races against a run that
				// started or ended between resolving the phase and the call, and are
				// retried silently. Anything else is unexpected, but a message whose
				// sender has moved on is still better retried than dropped: keep it
				// queued, report once, and wait for the next phase change. Never
				// retry inline - that could spin against a broken harness.
				const retryable = isRetryableDeliveryError(failure.error);
				const retried: QueuedMessage[] = [];
				for (const message of batch) {
					// A cancel during the harness call already settled this one.
					if (message.settled) continue;
					if (retryable || message.retryOnFailure) {
						retried.push(message);
					} else {
						this._fail(message, failure.error);
					}
				}
				if (retried.length === 0) continue;
				if (!retryable) {
					for (const message of retried) {
						message.onDeferredFailure?.(failure.error);
					}
				}
				// Requeue onto the target's live queue. A cancel during the call
				// detached the array this batch came from, and pushing back onto it
				// would strand these senders on a queue nothing drains.
				if (this._queues.get(agentId) === queue) {
					queue.unshift(...retried);
				} else {
					for (const message of retried) {
						this._fail(
							message,
							new MessageError(
								"target_unavailable",
								`Agent ${agentId} stopped receiving messages before the delivery could be retried.`,
							),
						);
					}
				}
				break;
			}
		} finally {
			this._draining.delete(agentId);
			const queue = this._queues.get(agentId);
			if (!queue || queue.length === 0) this._queues.delete(agentId);
			if (this._rerun.delete(agentId) && this.hasPending(agentId)) {
				this.wake(agentId);
			}
		}
	}

	/**
	 * Take the head plus every immediately following message that merges with
	 * it. Images never merge: a merged batch is one user message and a rewritten
	 * image set could not be attributed back to its own body.
	 */
	private _takeMergeableBatch(queue: QueuedMessage[]): QueuedMessage[] {
		const head = queue.shift();
		if (!head) return [];
		const batch = [head];
		if (head.mergeKey === undefined || head.images !== undefined) return batch;
		while (queue.length > 0) {
			const next = queue[0];
			if (
				next.settled ||
				next.mergeKey !== head.mergeKey ||
				next.images !== undefined ||
				next.requiresIdle
			) {
				break;
			}
			queue.shift();
			batch.push(next);
		}
		return batch;
	}

	private _resolve(
		message: QueuedMessage,
		receipt: MessageDeliveryReceipt,
	): void {
		if (message.settled) return;
		message.settled = true;
		message.resolve(receipt);
	}

	private _fail(message: QueuedMessage, error: unknown): void {
		if (message.settled) return;
		message.settled = true;
		message.reject(error);
	}
}

export function isRetryableDeliveryError(error: unknown): boolean {
	return (
		error instanceof AgentHarnessError &&
		(error.code === "busy" || error.code === "invalid_state")
	);
}
