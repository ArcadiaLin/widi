import type { AbortResult } from "@arcadialin/agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { HumanResponse } from "../../src/core/human-request.ts";
import { RpcHumanChannel } from "../../src/rpc/human-channel.ts";
import { RpcServer } from "../../src/rpc/server.ts";
import type { RpcCommand, RpcEventFrame, RpcOutbound, RpcResponseFrame } from "../../src/rpc/types.ts";
import {
	createModelRegistry,
	createOrchestrator,
	MemoryExecutionEnv,
	requireAgentHarness,
	stubPromptRun,
} from "../helpers/orchestrator.ts";

interface Fixture {
	readonly orchestrator: AgentOrchestrator;
	readonly server: RpcServer;
	readonly frames: RpcOutbound[];
	readonly human: RpcHumanChannel;
	readonly drainGate: { open: () => void; pending: () => boolean };
}

async function createFixture(options: { readonly blockDrain?: boolean } = {}): Promise<Fixture> {
	const env = new MemoryExecutionEnv();
	const orchestrator = await createOrchestrator(env);
	const modelRegistry = await createModelRegistry(env);
	const frames: RpcOutbound[] = [];
	const send = (frame: RpcOutbound): void => {
		frames.push(frame);
	};
	const human = new RpcHumanChannel({ send });

	let release: (() => void) | undefined;
	const drainGate = {
		open: () => {
			release?.();
			release = undefined;
		},
		pending: () => release !== undefined,
	};
	const drain = options.blockDrain
		? () =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		: undefined;

	const server = new RpcServer({ orchestrator, modelRegistry, human, send, drain });
	orchestrator.registerClient(server);
	return { orchestrator, server, frames, human, drainGate };
}

/** Run one command and wait for its answering frame. */
async function call(fixture: Fixture, command: RpcCommand): Promise<RpcResponseFrame> {
	fixture.server.handleCommand(command);
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const answer = fixture.frames.find(
			(frame): frame is RpcResponseFrame => frame.type === "response" && frame.id === command.id,
		);
		if (answer) return answer;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`No response for ${command.cmd}`);
}

function eventFrames(fixture: Fixture): RpcEventFrame[] {
	return fixture.frames.filter((frame): frame is RpcEventFrame => frame.type === "event");
}

describe("RpcServer command dispatch", () => {
	it("spawns, lists and inspects an agent by explicit id", async () => {
		const fixture = await createFixture();
		const spawned = await call(fixture, { id: "1", cmd: "spawn", origin: { kind: "new" } });
		if (!spawned.ok || spawned.cmd !== "spawn") throw new Error("spawn failed");
		// Narrowing on `cmd` narrows `data`: no assertion needed to read it.
		const agentId = spawned.data.agentId;
		expect(agentId).toBeTruthy();

		const listed = await call(fixture, { id: "2", cmd: "list_agents" });
		if (!listed.ok || listed.cmd !== "list_agents") throw new Error("list_agents failed");
		expect(listed.data.agents.map((agent) => agent.agentId)).toContain(agentId);

		const inspected = await call(fixture, { id: "3", cmd: "inspect", agentId });
		if (!inspected.ok || inspected.cmd !== "inspect") throw new Error("inspect failed");
		expect(inspected.data.agentId).toBe(agentId);

		await fixture.orchestrator.disposeAll("test");
	});

	it("answers a dispose with the agents it removed", async () => {
		const fixture = await createFixture();
		const spawned = await call(fixture, { id: "1", cmd: "spawn", origin: { kind: "new" } });
		if (!spawned.ok || spawned.cmd !== "spawn") throw new Error("spawn failed");
		const agentId = spawned.data.agentId;

		const disposed = await call(fixture, { id: "2", cmd: "dispose", agentId, reason: "test" });
		if (!disposed.ok || disposed.cmd !== "dispose") throw new Error("dispose failed");
		expect(disposed.data.agentIds).toEqual([agentId]);
	});

	it("refuses an unknown command instead of reporting an empty success", async () => {
		const fixture = await createFixture();
		const answer = await call(fixture, { id: "1", cmd: "bogus" } as unknown as RpcCommand);
		expect(answer.ok).toBe(false);
		if (answer.ok) return;
		expect(answer.error).toContain("Unknown command: bogus");
	});
});

/** Failures a client branches on, one per class. `error` text is not asserted. */
describe("RpcServer failure codes", () => {
	async function codeOf(fixture: Fixture, command: RpcCommand): Promise<string> {
		const answer = await call(fixture, command);
		if (answer.ok) throw new Error(`Expected ${command.cmd} to fail`);
		return answer.code;
	}

	it("distinguishes an unknown agent from a disposed one", async () => {
		const fixture = await createFixture();
		expect(await codeOf(fixture, { id: "1", cmd: "inspect", agentId: "no-such-agent" })).toBe("unknown_agent");

		const spawned = await call(fixture, { id: "2", cmd: "spawn", origin: { kind: "new" } });
		if (!spawned.ok || spawned.cmd !== "spawn") throw new Error("spawn failed");
		const agentId = spawned.data.agentId;
		await call(fixture, { id: "3", cmd: "dispose", agentId, reason: "test" });
		// Gone, not never-existed: the id was real and nothing will make it work again.
		expect(await codeOf(fixture, { id: "4", cmd: "inspect", agentId })).toBe("agent_unavailable");
	});

	it("separates a bad model reference from an unregistered one", async () => {
		const fixture = await createFixture();
		expect(await codeOf(fixture, { id: "1", cmd: "spawn", origin: { kind: "new" }, model: "no-slash" })).toBe(
			"invalid_command",
		);
		expect(
			await codeOf(fixture, { id: "2", cmd: "spawn", origin: { kind: "new" }, model: "test-provider/no-such-model" }),
		).toBe("model_unavailable");
	});

	it("reports a busy target as retryable", async () => {
		const fixture = await createFixture();
		const spawned = await call(fixture, { id: "1", cmd: "spawn", origin: { kind: "new" } });
		if (!spawned.ok || spawned.cmd !== "spawn") throw new Error("spawn failed");
		const agentId = spawned.data.agentId;
		const run = stubPromptRun(requireAgentHarness(fixture.orchestrator, agentId));

		fixture.server.handleCommand({ id: "2", cmd: "prompt", agentId, body: "first" });
		await vi.waitFor(() => expect(run.prompt).toHaveBeenCalledTimes(1));
		expect(await codeOf(fixture, { id: "3", cmd: "prompt", agentId, body: "second" })).toBe("agent_busy");

		run.resolve({} as AssistantMessage);
	});

	it("classifies a malformed command frame", async () => {
		const fixture = await createFixture();
		expect(await codeOf(fixture, { id: "1", cmd: "bogus" } as unknown as RpcCommand)).toBe("invalid_command");
	});
});

describe("RpcServer deadlines and cancel", () => {
	/** An agent mid-turn whose run only ends when the harness is aborted. */
	async function busyAgent(fixture: Fixture): Promise<string> {
		const spawned = await call(fixture, { id: "spawn", cmd: "spawn", origin: { kind: "new" } });
		if (!spawned.ok || spawned.cmd !== "spawn") throw new Error("spawn failed");
		const agentId = spawned.data.agentId;
		const harness = requireAgentHarness(fixture.orchestrator, agentId);
		const run = stubPromptRun(harness);
		vi.spyOn(harness, "abort").mockImplementation(async () => {
			run.resolve({ stopReason: "aborted" } as AssistantMessage);
			return { clearedSteer: [], clearedFollowUp: [] } satisfies AbortResult;
		});
		return agentId;
	}

	it("times out a prompt, and has settled the agent before it says so", async () => {
		const fixture = await createFixture();
		const agentId = await busyAgent(fixture);

		const answer = await call(fixture, { id: "p", cmd: "prompt", agentId, body: "work", deadlineMs: 20 });
		if (answer.ok) throw new Error("expected a timeout");
		expect(answer.code).toBe("timeout");
		// The abort ran and the aborted run was awaited, so the agent is idle by the
		// time the client reads the answer - not still streaming into the next sample.
		expect(fixture.orchestrator.isAgentIdle(agentId)).toBe(true);
	});

	it("times out a wait_idle without touching the agent", async () => {
		const fixture = await createFixture();
		const agentId = await busyAgent(fixture);
		fixture.server.handleCommand({ id: "p", cmd: "prompt", agentId, body: "work" });
		await vi.waitFor(() => expect(fixture.orchestrator.isAgentIdle(agentId)).toBe(false));

		const answer = await call(fixture, { id: "w", cmd: "wait_idle", agentId, deadlineMs: 20 });
		if (answer.ok) throw new Error("expected a timeout");
		expect(answer.code).toBe("timeout");
		expect(fixture.orchestrator.isAgentIdle(agentId)).toBe(false);

		await fixture.orchestrator.abortAgent(agentId, "human");
	});

	it("cancels a prompt in flight by its command id", async () => {
		const fixture = await createFixture();
		const agentId = await busyAgent(fixture);
		fixture.server.handleCommand({ id: "p", cmd: "prompt", agentId, body: "work" });
		await vi.waitFor(() => expect(fixture.orchestrator.isAgentIdle(agentId)).toBe(false));

		const cancelled = await call(fixture, { id: "c", cmd: "cancel", commandId: "p" });
		if (!cancelled.ok || cancelled.cmd !== "cancel") throw new Error("cancel failed");
		expect(cancelled.data.cancelled).toBe(true);

		const answer = await vi.waitFor(() => {
			const frame = fixture.frames.find((f): f is RpcResponseFrame => f.type === "response" && f.id === "p");
			if (!frame) throw new Error("no answer for the cancelled prompt");
			return frame;
		});
		if (answer.ok) throw new Error("expected a cancellation");
		expect(answer.code).toBe("aborted");
	});

	it("reports a cancel for nothing in flight rather than failing", async () => {
		const fixture = await createFixture();
		const answer = await call(fixture, { id: "c", cmd: "cancel", commandId: "never-ran" });
		if (!answer.ok || answer.cmd !== "cancel") throw new Error("cancel failed");
		expect(answer.data.cancelled).toBe(false);
	});

	it("refuses a second command reusing an id still in flight", async () => {
		const fixture = await createFixture();
		const agentId = await busyAgent(fixture);
		fixture.server.handleCommand({ id: "p", cmd: "prompt", agentId, body: "work" });
		await vi.waitFor(() => expect(fixture.orchestrator.isAgentIdle(agentId)).toBe(false));

		// Not `agent_busy`: the client's own correlation is broken, and answering two
		// different commands under one id is what it would cost to accept this.
		const answer = await call(fixture, { id: "p", cmd: "wait_idle", agentId });
		if (answer.ok) throw new Error("expected a refusal");
		expect(answer.code).toBe("invalid_command");
		expect(answer.error).toContain("already in flight");

		await fixture.orchestrator.abortAgent(agentId, "human");
	});

	it("rejects a deadline that is not a positive number of milliseconds", async () => {
		const fixture = await createFixture();
		const answer = await call(fixture, { id: "w", cmd: "wait_idle", agentId: "any", deadlineMs: 0 });
		if (answer.ok) throw new Error("expected a refusal");
		expect(answer.code).toBe("invalid_command");
	});
});

describe("RpcServer human requests", () => {
	it("emits a request frame and resolves from the client's answer", async () => {
		const fixture = await createFixture();
		const asked = fixture.orchestrator.requestHuman({ source: { kind: "system" }, kind: "confirm", title: "Proceed?" });

		let frame = fixture.frames.find((f) => f.type === "human_request");
		for (let attempt = 0; attempt < 50 && !frame; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			frame = fixture.frames.find((f) => f.type === "human_request");
		}
		if (!frame || frame.type !== "human_request") throw new Error("no human_request frame");

		const response: HumanResponse = { kind: "confirm", confirmed: true };
		expect(fixture.human.settle({ type: "human_response", requestId: frame.request.id, response })).toBe(true);
		await expect(asked).resolves.toEqual(response);
	});

	it("rejects the caller when the client withdraws", async () => {
		const fixture = await createFixture();
		const asked = fixture.orchestrator.requestHuman({ source: { kind: "system" }, kind: "input", title: "Name?" });
		let frame = fixture.frames.find((f) => f.type === "human_request");
		for (let attempt = 0; attempt < 50 && !frame; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			frame = fixture.frames.find((f) => f.type === "human_request");
		}
		if (!frame || frame.type !== "human_request") throw new Error("no human_request frame");

		fixture.human.settle({ type: "human_response", requestId: frame.request.id, cancelled: true });
		await expect(asked).rejects.toThrow();
	});

	it("reports an answer to a request it is not holding", async () => {
		const fixture = await createFixture();
		expect(
			fixture.human.settle({
				type: "human_response",
				requestId: "never-asked",
				response: { kind: "confirm", confirmed: true },
			}),
		).toBe(false);
	});

	it("withdraws an unanswered request once its timeout passes", async () => {
		const frames: RpcOutbound[] = [];
		const channel = new RpcHumanChannel({ send: (frame) => frames.push(frame), timeoutMs: 20 });
		const asked = channel.request({
			id: "r1",
			source: { kind: "system" },
			kind: "confirm",
			title: "?",
			createdAt: "now",
		});

		await expect(asked).rejects.toThrow(/unanswered/);
		// The client is told, or it would hold a prompt open on a request whose
		// answer nobody will ever read.
		expect(frames.map((frame) => frame.type)).toEqual(["human_request", "human_request_withdrawn"]);
	});

	it("withdraws everything still parked when the channel closes", async () => {
		const frames: RpcOutbound[] = [];
		const channel = new RpcHumanChannel({ send: (frame) => frames.push(frame) });
		const asked = channel.request({
			id: "r1",
			source: { kind: "system" },
			kind: "input",
			title: "?",
			createdAt: "now",
		});

		channel.closeAll("input stream ended");
		await expect(asked).rejects.toThrow(/input stream ended/);
		expect(frames.at(-1)).toEqual({ type: "human_request_withdrawn", requestId: "r1", reason: "input stream ended" });
	});

	it("answers a request that has not timed out yet", async () => {
		const frames: RpcOutbound[] = [];
		const channel = new RpcHumanChannel({ send: (frame) => frames.push(frame), timeoutMs: 5_000 });
		const asked = channel.request({
			id: "r1",
			source: { kind: "system" },
			kind: "confirm",
			title: "?",
			createdAt: "now",
		});

		expect(
			channel.settle({ type: "human_response", requestId: "r1", response: { kind: "confirm", confirmed: true } }),
		).toBe(true);
		await expect(asked).resolves.toEqual({ kind: "confirm", confirmed: true });
		// The timer was cleared with the request; nothing follows the ask.
		expect(frames.map((frame) => frame.type)).toEqual(["human_request"]);
	});
});

describe("RpcServer backpressure", () => {
	it("does not finish receiving an event until the outbound drain resolves", async () => {
		const fixture = await createFixture({ blockDrain: true });
		let settled = false;
		const received = fixture.server
			.receive({ type: "agent_idle", agentId: "a", reason: "settled", idleAt: "now" })
			.then(() => {
				settled = true;
			});

		await new Promise((resolve) => setTimeout(resolve, 10));
		// The frame is already handed over; what is still outstanding is the drain,
		// and that is what keeps the publisher - and so the model loop - waiting.
		expect(eventFrames(fixture)).toHaveLength(1);
		expect(settled).toBe(false);

		fixture.drainGate.open();
		await received;
		expect(settled).toBe(true);
	});
});

describe("wire events survive the wire", () => {
	it("round-trips every event a real agent lifecycle produces", async () => {
		const fixture = await createFixture();
		const agentId = await fixture.orchestrator.spawnAgent({ origin: { kind: "new" } });
		await fixture.orchestrator.spawnAgent({ origin: { kind: "new" }, parent: agentId });
		await fixture.orchestrator.disposeAll("test");

		const frames = eventFrames(fixture);
		expect(frames.length).toBeGreaterThan(0);

		// The invariant the RPC protocol rests on: a projected event is exactly
		// what JSON can carry. A new event type that breaks it fails here rather
		// than in a client's parser.
		for (const frame of frames) {
			expect(JSON.parse(JSON.stringify(frame.event))).toEqual(frame.event);
		}
	});
});
