import { AgentHarnessError } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
	backgroundResultMergeKey,
	decideMessageDelivery,
	formatAgentTaskMessageBody,
	type MessageDeliveryPhase,
	type MessageDeliveryPorts,
	MessageDeliveryQueue,
	type MessageDeliveryReceipt,
	type MessageDraft,
	MessageError,
	type MessageInterceptRun,
	messageBlockPolicy,
	renderMessageEnvelope,
	transformMessage,
} from "../../src/core/message.ts";

function createDeferred<T = void>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function createDraft(overrides: Partial<MessageDraft> = {}): MessageDraft {
	return {
		source: { kind: "agent", agentId: "agent-source" },
		targetAgentId: "agent-target",
		body: "please review",
		mode: "next_turn",
		...overrides,
	};
}

interface QueueFixture {
	readonly queue: MessageDeliveryQueue;
	readonly phases: Map<string, MessageDeliveryPhase>;
	readonly delivered: Array<{ method: string; text: string }>;
	readonly deliver: ReturnType<typeof vi.fn>;
}

function createQueue(
	options: {
		phase?: MessageDeliveryPhase;
		/** Mirror the harness: an accepted prompt puts the target into a turn. */
		promptStartsTurn?: boolean;
		onDeliver?: (method: string, text: string) => void | Promise<void>;
	} = {},
): QueueFixture {
	const phases = new Map<string, MessageDeliveryPhase>([
		["agent-target", options.phase ?? "idle"],
	]);
	const delivered: Array<{ method: string; text: string }> = [];
	const handler: MessageDeliveryPorts["deliver"] = async (request) => {
		await options.onDeliver?.(request.method, request.text);
		delivered.push({ method: request.method, text: request.text });
		if (request.method === "prompt" && options.promptStartsTurn !== false) {
			phases.set(request.agentId, "turn");
		}
		return { method: request.method };
	};
	const deliver = vi.fn(handler);
	const queue = new MessageDeliveryQueue({
		resolvePhase: (agentId) => phases.get(agentId) ?? "gone",
		deliver,
	});
	return { queue, phases, delivered, deliver };
}

function enqueue(
	fixture: QueueFixture,
	input: {
		text: string;
		mode?: "next_turn" | "interrupt";
		mergeKey?: string;
		requiresIdle?: boolean;
		retryOnFailure?: boolean;
		onDeferredFailure?: (error: unknown) => void;
	},
): Promise<MessageDeliveryReceipt> {
	return fixture.queue.enqueue({
		targetAgentId: "agent-target",
		text: input.text,
		mode: input.mode ?? "next_turn",
		requiresIdle: input.requiresIdle ?? false,
		humanInterrupt: false,
		mergeKey: input.mergeKey,
		awaited: false,
		retryOnFailure: input.retryOnFailure ?? false,
		onDeferredFailure: input.onDeferredFailure,
	});
}

describe("message envelopes", () => {
	it("attributes cross-agent and system messages, leaving self-describing text alone", () => {
		expect(renderMessageEnvelope({ kind: "human" }, "hello")).toBe("hello");
		expect(
			renderMessageEnvelope({ kind: "agent", agentId: "agent-7" }, "hello"),
		).toBe("[Message from agent-7]\n\nhello");
		expect(
			renderMessageEnvelope({ kind: "system", name: "watchdog" }, "hello"),
		).toBe("[Message from watchdog]\n\nhello");
		// A job result already carries its own job id, tool, and status header.
		expect(
			renderMessageEnvelope(
				{ kind: "background_job", ownerAgentId: "agent-1", jobId: "job-2" },
				"Background job job-2 completed",
			),
		).toBe("Background job job-2 completed");
	});

	it("tells the worker which job id completes its task", () => {
		const body = formatAgentTaskMessageBody({
			ownerAgentId: "agent-main",
			taskId: "job-12",
			task: "Inspect the router.",
		});
		expect(body).toContain("Task job-12 assigned to you.");
		expect(body).toContain("Inspect the router.");
		expect(body).toContain("settle task job-12 for agent-main");
	});
});

describe("message interception", () => {
	async function run(
		draft: MessageDraft,
		intercepted: MessageInterceptRun,
	): Promise<ReturnType<typeof transformMessage>> {
		return await transformMessage(draft, {
			intercept: async () => intercepted,
		});
	}

	it("passes the source and target to the interceptor", async () => {
		const intercept = vi.fn(
			async () => ({ kind: "pass" }) as MessageInterceptRun,
		);
		await transformMessage(createDraft(), { intercept });
		expect(intercept).toHaveBeenCalledWith({
			type: "input",
			source: { kind: "agent", agentId: "agent-source" },
			targetAgentId: "agent-target",
			text: "please review",
			images: undefined,
		});
	});

	it("applies a rewrite and keeps the current images when none are returned", async () => {
		const images = [
			{ type: "image" as const, data: "aGk=", mimeType: "image/png" },
		];
		const outcome = await run(createDraft({ images }), {
			kind: "transform",
			text: "rewritten",
			transformedBy: ["policy"],
		});
		expect(outcome).toEqual({
			kind: "transform",
			text: "rewritten",
			images,
			transformedBy: ["policy"],
		});
	});

	it("enforces a block for every source that can be told about it", async () => {
		expect(messageBlockPolicy({ kind: "human" })).toBe("enforce");
		expect(messageBlockPolicy({ kind: "agent", agentId: "agent-1" })).toBe(
			"enforce",
		);
		expect(messageBlockPolicy({ kind: "system", name: "watchdog" })).toBe(
			"enforce",
		);
		const outcome = await run(createDraft(), {
			kind: "block",
			reason: "denied",
			blockedBy: "guard",
		});
		expect(outcome).toEqual({
			kind: "block",
			reason: "denied",
			blockedBy: "guard",
		});
	});

	// The model already holds this job's t0 handle and is waiting for exactly one
	// result. Dropping it would strand the model, so the block is not enforced.
	it("delivers a blocked background job result anyway", async () => {
		const source = {
			kind: "background_job" as const,
			ownerAgentId: "agent-1",
			jobId: "job-2",
		};
		expect(messageBlockPolicy(source)).toBe("ignore");
		const outcome = await run(createDraft({ source, body: "job done" }), {
			kind: "block",
			blockedBy: "guard",
		});
		expect(outcome).toEqual({
			kind: "pass",
			text: "job done",
			images: undefined,
		});
	});
});

describe("delivery decisions", () => {
	const decide = (
		phase: MessageDeliveryPhase,
		mode: "next_turn" | "interrupt" = "next_turn",
		requiresIdle = false,
	) =>
		decideMessageDelivery({
			phase,
			mode,
			requiresIdle,
			targetAgentId: "agent-target",
		});

	it("prompts an idle target and queues onto a running turn", () => {
		expect(decide("idle")).toEqual({ kind: "deliver", method: "prompt" });
		expect(decide("turn")).toEqual({ kind: "deliver", method: "follow_up" });
		expect(decide("turn", "interrupt")).toEqual({
			kind: "deliver",
			method: "steer",
		});
	});

	// Compaction and branch summary hold the harness without running an agent
	// loop: a steer accepted here would sit in a queue nothing drains.
	it("defers while the target cannot consume input yet", () => {
		expect(decide("maintenance")).toEqual({ kind: "defer" });
		expect(decide("maintenance", "interrupt")).toEqual({ kind: "defer" });
		expect(decide("creating")).toEqual({ kind: "defer" });
	});

	it("rejects a gone target and a busy target the caller is waiting on", () => {
		expect(decide("gone").kind).toBe("reject");
		expect(decide("turn", "next_turn", true).kind).toBe("reject");
		expect(decide("idle", "next_turn", true)).toEqual({
			kind: "deliver",
			method: "prompt",
		});
	});
});

describe("MessageDeliveryQueue", () => {
	it("serializes concurrent sends so only one claims the idle target", async () => {
		const fixture = createQueue({ phase: "idle" });

		const first = enqueue(fixture, { text: "first" });
		const second = enqueue(fixture, { text: "second" });
		await Promise.all([first, second]);

		expect(fixture.delivered).toEqual([
			{ method: "prompt", text: "first" },
			{ method: "follow_up", text: "second" },
		]);
	});

	it("merges adjacent results sharing a key into one user message", async () => {
		const fixture = createQueue({ phase: "turn" });
		const mergeKey = backgroundResultMergeKey("next_turn");

		await Promise.all([
			enqueue(fixture, { text: "job-1 done", mergeKey }),
			enqueue(fixture, { text: "job-2 done", mergeKey }),
			enqueue(fixture, { text: "a message" }),
		]);

		expect(fixture.delivered).toEqual([
			{ method: "follow_up", text: "job-1 done\n\njob-2 done" },
			{ method: "follow_up", text: "a message" },
		]);
	});

	it("holds a message through maintenance and delivers it on the next wake", async () => {
		const fixture = createQueue({ phase: "maintenance" });

		const accepted = enqueue(fixture, { text: "queued" });
		await Promise.resolve();
		await Promise.resolve();
		expect(fixture.deliver).not.toHaveBeenCalled();

		fixture.phases.set("agent-target", "idle");
		fixture.queue.wake("agent-target");
		await accepted;
		expect(fixture.delivered).toEqual([{ method: "prompt", text: "queued" }]);
	});

	it("retries a busy race at the next wake without spinning", async () => {
		let attempts = 0;
		const fixture = createQueue({
			phase: "idle",
			promptStartsTurn: false,
			onDeliver: () => {
				attempts += 1;
				if (attempts === 1) throw new AgentHarnessError("busy", "busy");
			},
		});

		const accepted = enqueue(fixture, { text: "queued" });
		await vi.waitFor(() => expect(attempts).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 0));
		// No inline retry: the queue waits to be told the phase moved.
		expect(attempts).toBe(1);
		expect(fixture.queue.hasPending("agent-target")).toBe(true);

		fixture.queue.wake("agent-target");
		await accepted;
		expect(fixture.delivered).toEqual([{ method: "prompt", text: "queued" }]);
	});

	it("rejects an unexpected failure the sender is still waiting on", async () => {
		const fixture = createQueue({
			phase: "idle",
			onDeliver: () => {
				throw new Error("session write failed");
			},
		});

		await expect(enqueue(fixture, { text: "queued" })).rejects.toThrow(
			"session write failed",
		);
		expect(fixture.queue.hasPending("agent-target")).toBe(false);
	});

	// A background job result has no sender left to tell, so losing it would
	// leave the model waiting forever for a t1 that never arrives.
	it("keeps an unexpected failure queued when its sender has moved on", async () => {
		let attempts = 0;
		const fixture = createQueue({
			phase: "idle",
			promptStartsTurn: false,
			onDeliver: () => {
				attempts += 1;
				if (attempts === 1) throw new Error("session write failed");
			},
		});
		const deferred: unknown[] = [];

		const accepted = enqueue(fixture, {
			text: "job-1 done",
			retryOnFailure: true,
			onDeferredFailure: (error) => deferred.push(error),
		});
		await vi.waitFor(() => expect(deferred).toHaveLength(1));
		expect(fixture.queue.hasPending("agent-target")).toBe(true);

		fixture.queue.wake("agent-target");
		await accepted;
		expect(fixture.delivered).toEqual([
			{ method: "prompt", text: "job-1 done" },
		]);
	});

	// The batch has already left the queue array while the harness call is in
	// flight. If cancel could not reach it, its senders would wait on a promise
	// nothing is left to settle.
	it("settles a batch that was mid-delivery when the target was cancelled", async () => {
		const stuck = createDeferred<void>();
		const fixture = createQueue({
			phase: "idle",
			onDeliver: async () => await stuck.promise,
		});

		const accepted = enqueue(fixture, { text: "in flight" });
		await vi.waitFor(() => expect(fixture.deliver).toHaveBeenCalledTimes(1));
		expect(fixture.queue.hasPending("agent-target")).toBe(true);

		fixture.queue.cancel("agent-target", "agent disposed");
		await expect(accepted).rejects.toThrow("agent disposed");
		expect(fixture.queue.hasPending("agent-target")).toBe(false);

		// The late failure of the abandoned call must not resurrect the batch.
		stuck.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fixture.queue.hasPending("agent-target")).toBe(false);
	});

	it("does not requeue a retryable failure onto a queue that was cancelled", async () => {
		const attempt = createDeferred<void>();
		const fixture = createQueue({
			phase: "idle",
			onDeliver: async () => {
				await attempt.promise;
				throw new AgentHarnessError("busy", "busy");
			},
		});

		const accepted = enqueue(fixture, {
			text: "in flight",
			retryOnFailure: true,
		});
		await vi.waitFor(() => expect(fixture.deliver).toHaveBeenCalledTimes(1));
		fixture.queue.cancel("agent-target", "agent disposed");
		attempt.resolve();

		await expect(accepted).rejects.toThrow("agent disposed");
		expect(fixture.queue.hasPending("agent-target")).toBe(false);
	});

	it("rejects a gone target and fails everything still queued on cancel", async () => {
		const gone = createQueue({ phase: "gone" });
		await expect(enqueue(gone, { text: "lost" })).rejects.toBeInstanceOf(
			MessageError,
		);

		const held = createQueue({ phase: "maintenance" });
		const pending = enqueue(held, { text: "pending" });
		await Promise.resolve();
		held.queue.cancel("agent-target", "agent disposed");
		await expect(pending).rejects.toThrow("agent disposed");
		expect(held.queue.hasPending("agent-target")).toBe(false);
	});
});
