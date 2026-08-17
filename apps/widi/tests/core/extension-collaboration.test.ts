/**
 * The cross-agent half of the extension contract: `precede`, the five
 * collaboration actions, addressing another agent from the four injection
 * paths, and which observed events reach a tree rather than one agent.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { AgentStop, ExtensionActions, ExtensionObservedEvent } from "../../src/core/extension/api.ts";
import { messageBindingFor } from "../../src/core/message.ts";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import {
	createOrchestrator,
	harnessEventDriver,
	MemoryExecutionEnv,
	requireAgentHarness,
	requireLiveAgent,
	stubPromptRun,
} from "../helpers/orchestrator.ts";

function requireActions(orchestrator: AgentOrchestrator, agentId: string, extensionId = "collab"): ExtensionActions {
	const runner = requireLiveAgent(orchestrator, agentId).extensionRunner;
	if (!runner) throw new Error("Expected extension runner.");
	return runner.createContext(extensionId).actions;
}

async function createHarness() {
	const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
	orchestrator.registerExtension("collab", () => {});
	const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
	return { orchestrator, agentId, actions: requireActions(orchestrator, agentId) };
}

async function branchText(orchestrator: AgentOrchestrator, agentId: string): Promise<string> {
	return JSON.stringify((await orchestrator.getAgentSession(agentId)).pathToRoot);
}

describe("extension precede", () => {
	it("puts model-readable text on the branch without starting a turn", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		const run = stubPromptRun(requireAgentHarness(orchestrator, agentId));

		await actions.precede("read this before you begin");

		expect(run.prompt).not.toHaveBeenCalled();
		expect(orchestrator.isAgentIdle(agentId)).toBe(true);
		expect(await branchText(orchestrator, agentId)).toContain("read this before you begin");
	});

	it("lands while the agent is busy, where prompt would be refused", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		const harness = requireAgentHarness(orchestrator, agentId);
		// Same private-access precedent the helpers use: delivery is chosen from
		// the phase, and driving a real turn to reach one would need a model run.
		(harness as unknown as { phase: string }).phase = "turn";

		// No phase gate at all: the only one of the four that a running turn
		// cannot refuse, defer, or queue.
		await expect(actions.precede("context for later")).resolves.toBeUndefined();
		await expect(
			orchestrator.promptAgent(
				{ targetAgentId: agentId, body: "work", mode: "next_turn" },
				messageBindingFor({ kind: "human" }),
			),
		).rejects.toThrow(/cannot accept a prompt while turn/);

		// Accepted is not the same as visible: it joins no queue the agent drains,
		// and the harness holds the write until the running operation's save point.
		expect(orchestrator.agentHasPendingMessages(agentId)).toBe(false);
		expect(await branchText(orchestrator, agentId)).not.toContain("context for later");
	});
});

describe("extension prompt", () => {
	it("answers with the assistant message the run ended on", async () => {
		const { orchestrator, actions } = await createHarness();
		const childId = await actions.spawnAgent({ origin: { kind: "new" } });
		const run = stubPromptRun(requireAgentHarness(orchestrator, childId));
		// The usage rides on this message, which is what makes one prompt of a
		// single-turn agent a step an extension can put a price on.
		const message = {
			role: "assistant",
			stopReason: "stop",
			usage: {
				input: 12,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as AssistantMessage;

		const outcome = actions.prompt("do the step", { target: childId });
		await vi.waitFor(() => expect(run.prompt).toHaveBeenCalledTimes(1));
		run.resolve(message);

		await expect(outcome).resolves.toEqual({ kind: "completed", message });
	});

	it("reports an input policy's refusal as an outcome rather than a failure", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		orchestrator.registerExtension("collab", () => {});
		orchestrator.registerExtension("gate", (api) => {
			api.intercept("input", (event) =>
				event.text.includes("refuse") ? { block: true, reason: "policy" } : undefined,
			);
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await expect(requireActions(orchestrator, agentId).prompt("please refuse this")).resolves.toMatchObject({
			kind: "blocked",
			reason: "policy",
			blockedBy: "gate",
		});
	});

	it("refuses a busy target instead of queueing behind its run", async () => {
		const { orchestrator, actions } = await createHarness();
		const childId = await actions.spawnAgent({ origin: { kind: "new" } });
		const run = stubPromptRun(requireAgentHarness(orchestrator, childId));

		const first = actions.prompt("first", { target: childId });
		await vi.waitFor(() => expect(run.prompt).toHaveBeenCalledTimes(1));
		await expect(actions.prompt("second", { target: childId })).rejects.toThrow(/cannot accept a prompt while turn/);

		run.resolve({} as AssistantMessage);
		await first;
	});
});

describe("extension readReport and waitForStop", () => {
	it("reads back what a child agent said in its last run", async () => {
		const { orchestrator, actions } = await createHarness();
		const childId = await actions.spawnAgent({ origin: { kind: "new" } });
		// Written straight to the branch because a real run is what would otherwise
		// put it there, and the point under test is what the reader scans, not what
		// a model would have produced.
		const harness = requireAgentHarness(orchestrator, childId);
		await harness.appendMessage({ role: "user", content: "question", timestamp: 1 });
		await harness.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "the answer" }],
			timestamp: 2,
		} as AssistantMessage);

		await expect(actions.readReport(childId)).resolves.toBe("the answer");
	});

	it("has nothing to read once the agent that said it is gone", async () => {
		const { actions } = await createHarness();
		const childId = await actions.spawnAgent({ origin: { kind: "new" } });
		await actions.disposeAgent(childId, { scope: "agent", reason: "done" });

		// Not undefined: "said nothing" and "cannot be asked" are different answers,
		// and collapsing them would make `dispose` then `readReport` look workable.
		await expect(actions.readReport(childId)).rejects.toThrow(/is gone/);
	});

	it("refuses both reads for an agent in another tree", async () => {
		const { orchestrator, actions } = await createHarness();
		const outsider = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await expect(actions.readReport(outsider)).rejects.toThrow(/outside/);
		await expect(actions.waitForStop(outsider)).rejects.toThrow(/outside/);
	});

	it("waits for the next stop rather than the idle it started from", async () => {
		const { orchestrator, actions } = await createHarness();
		const childId = await actions.spawnAgent({ origin: { kind: "new" } });
		const run = stubPromptRun(requireAgentHarness(orchestrator, childId));

		// The child is idle right now. Level-triggered would answer here, and a
		// caller that just handed over work would read its own starting state as
		// the end of it.
		expect(orchestrator.isAgentIdle(childId)).toBe(true);
		let stop: AgentStop | undefined;
		const stopped = actions.waitForStop(childId).then((result) => {
			stop = result;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(stop).toBeUndefined();

		const prompted = actions.prompt("work", { target: childId });
		await vi.waitFor(() => expect(run.prompt).toHaveBeenCalledTimes(1));
		run.resolve({} as AssistantMessage);

		await stopped;
		expect(stop).toEqual({ reason: "settled" });
		await prompted;
	});

	it("carries the abort origin, so a stop is not read as a completion", async () => {
		const { orchestrator, actions } = await createHarness();
		const childId = await actions.spawnAgent({ origin: { kind: "new" } });
		const run = stubPromptRun(requireAgentHarness(orchestrator, childId));
		const stopped = actions.waitForStop(childId);

		const prompted = actions.prompt("work", { target: childId });
		await vi.waitFor(() => expect(run.prompt).toHaveBeenCalledTimes(1));
		// Not awaited here: the abort itself waits for the harness to leave the
		// turn, which is what resolving the stubbed run below does.
		const aborting = orchestrator.abortAgent(childId, "extension");
		run.resolve({} as AssistantMessage);

		await expect(stopped).resolves.toEqual({ reason: "aborted", abortedBy: "extension" });
		await aborting;
		await prompted;
	});

	it("ends an in-flight wait when the waiting extension's own agent is disposed", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		const childId = await actions.spawnAgent({ origin: { kind: "new" } });
		const stopped = actions.waitForStop(childId);

		// The runtime that would receive the answer is the one being torn down, so
		// the wait cannot be left standing.
		await orchestrator.disposeAgent(agentId, { intent: "removed", scope: "agent" });

		await expect(stopped).rejects.toThrow(/is gone/);
	});
});

describe("extension cross-agent actions", () => {
	it("parents a spawned agent under the extension's own", async () => {
		const { agentId, actions } = await createHarness();

		const childId = await actions.spawnAgent({ origin: { kind: "new" } });

		const listing = await actions.listAgents();
		expect(listing.entries).toHaveLength(1);
		const root = listing.entries[0];
		expect(root).toMatchObject({ status: "running", agentId });
		expect(root?.children.map((child) => (child.status === "running" ? child.agentId : undefined))).toEqual([childId]);
	});

	it("builds a role out of fields, which the agent host's origin cannot", async () => {
		const { orchestrator, actions } = await createHarness();

		const childId = await actions.spawnAgent({
			// `persist: false` because a role assembled here has no profile file to
			// be resumed from; the point is that `systemPrompt` is settable at all,
			// which the agent host's origin has no field for.
			origin: {
				kind: "new",
				profileOverride: { label: "Assembled", systemPrompt: "assembled prompt", persist: false },
			},
		});

		expect(actions.describeAgent(childId)?.label).toBe("Assembled");
		await expect(orchestrator.getAgentSystemPrompt(childId)).resolves.toContain("assembled prompt");
	});

	it("refuses to dispose the agent it is bound to", async () => {
		const { agentId, actions } = await createHarness();

		await expect(actions.disposeAgent(agentId, { scope: "agent", reason: "self" })).resolves.toEqual({ kind: "self" });
	});

	it("refuses an agent in another tree", async () => {
		const { orchestrator, actions } = await createHarness();
		const outsider = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await expect(actions.disposeAgent(outsider, { scope: "agent", reason: "reach" })).resolves.toEqual({
			kind: "outside_tree",
		});
	});

	it("disposes an agent it spawned", async () => {
		const { actions } = await createHarness();
		const childId = await actions.spawnAgent({ origin: { kind: "new" } });

		await expect(actions.disposeAgent(childId, { scope: "agent", reason: "done" })).resolves.toEqual({
			kind: "disposed",
			agentIds: [childId],
		});
		expect(actions.describeAgent(childId)).toBeUndefined();
	});

	it("lists only its own tree", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		await orchestrator.spawnAgent({ origin: { kind: "new" } });

		const listing = await actions.listAgents();

		expect(listing.entries.map((entry) => (entry.status === "running" ? entry.agentId : undefined))).toEqual([agentId]);
	});

	it("lists the profiles agents choose from", async () => {
		const { actions } = await createHarness();

		await expect(actions.listProfiles()).resolves.toMatchObject([
			{ id: "main", label: "Main Agent" },
			{ id: "worker", label: "Worker Agent" },
		]);
	});
});

describe("extension message target", () => {
	it("delivers to another agent while still speaking as the extension", async () => {
		const { orchestrator, actions } = await createHarness();
		const peer = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		await actions.precede("for the peer", { target: peer });

		expect(await branchText(orchestrator, peer)).toContain("for the peer");
		expect(await branchText(orchestrator, peer)).toContain("collab");
	});

	it("reports and rethrows when the target is gone", async () => {
		const { orchestrator, actions } = await createHarness();
		const peer = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		await orchestrator.disposeAgent(peer, { intent: "removed" });
		const diagnostics: string[] = [];
		orchestrator.subscribe((event: OrchestratorEvent) => {
			if (event.type === "diagnostic") diagnostics.push(event.diagnostic.code);
		});

		await expect(actions.followUp("nobody home", { target: peer })).rejects.toThrow();
		expect(diagnostics).toContain("extension.action_failed");
	});
});

describe("extension observed event scope", () => {
	async function createTree() {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const seen = new Map<string, ExtensionObservedEvent[]>();
		orchestrator.registerExtension("watcher", (api) => {
			for (const name of ["agent_spawned", "agent_disposed", "agent_idle", "agent_harness_event"] as const) {
				api.observe(name, (event, context) => {
					const bucket = seen.get(context.agentId);
					if (bucket) bucket.push(event);
					else seen.set(context.agentId, [event]);
				});
			}
		});
		const rootId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		return { orchestrator, rootId, seen };
	}

	it("tells an agent's tree that a sibling arrived", async () => {
		const { orchestrator, rootId, seen } = await createTree();

		const childId = await orchestrator.spawnAgent({ origin: { kind: "new" }, parent: rootId });

		const spawned = (seen.get(rootId) ?? []).filter((event) => event.type === "agent_spawned");
		expect(spawned.map((event) => (event.type === "agent_spawned" ? event.agentId : undefined))).toContain(childId);
	});

	it("tells an agent's tree that a sibling is gone", async () => {
		const { orchestrator, rootId, seen } = await createTree();
		const childId = await orchestrator.spawnAgent({ origin: { kind: "new" }, parent: rootId });
		seen.clear();

		await orchestrator.disposeAgent(childId, { intent: "removed" });

		expect(
			(seen.get(rootId) ?? []).filter((event) => event.type === "agent_disposed" && event.agentId === childId),
		).toHaveLength(1);
	});

	it("does not cross into another tree", async () => {
		const { orchestrator, rootId, seen } = await createTree();
		seen.clear();

		await orchestrator.spawnAgent({ origin: { kind: "new" } });

		expect(seen.get(rootId) ?? []).toHaveLength(0);
	});

	it("keeps the raw harness stream to the agent it is about", async () => {
		const { orchestrator, rootId, seen } = await createTree();
		const childId = await orchestrator.spawnAgent({ origin: { kind: "new" }, parent: rootId });
		seen.clear();

		await harnessEventDriver(orchestrator)(childId, { type: "settled", nextTurnCount: 0 });

		expect((seen.get(rootId) ?? []).filter((event) => event.type === "agent_harness_event")).toHaveLength(0);
		expect((seen.get(childId) ?? []).filter((event) => event.type === "agent_harness_event").length).toBeGreaterThan(0);
	});
});

describe("agent_spawned origin", () => {
	it("tells a fork apart from a fresh profile", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const origins: string[] = [];
		orchestrator.subscribe((event: OrchestratorEvent) => {
			if (event.type === "agent_spawned") origins.push(event.origin);
		});

		const sourceId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		await orchestrator.spawnAgent({ origin: { kind: "fork", sourceAgentId: sourceId } });

		expect(origins).toEqual(["new", "fork"]);
	});
});
