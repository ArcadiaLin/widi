/**
 * Core capabilities exposed to extensions in ME stage 0: session reads,
 * context usage, structured input presentation, and the small read-only
 * getters. The pi-extensions ecosystem survey (chat_notes/tui-extension-host.md
 * section 4) is what picked these four.
 */

import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentHarnessEvent, AgentMessage } from "@widi/agent-core";
import { describe, expect, it } from "vitest";
import type { AgentOrchestrator, OrchestratorEvent } from "../../src/core/agent-orchestrator.ts";
import type { ExtensionInputPresentation, ExtensionObservedEventName } from "../../src/core/extension/api.ts";
import { EXTENSION_OBSERVED_EVENT_NAMES } from "../../src/core/extension/index.ts";
import { EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE } from "../../src/core/session-manager.ts";
import {
	createOrchestrator,
	defaultModel,
	defaultProfile,
	MemoryExecutionEnv,
	requireAgentHarness,
	requireAgentRecord,
} from "../helpers/orchestrator.ts";

// Same private-access precedent as the orchestrator suite: a real settled fact
// requires a full model run, which unit tests never perform.
async function emitSettled(orchestrator: AgentOrchestrator, agentId: string): Promise<void> {
	await (
		orchestrator as unknown as { _handleAgentHarnessEvent(agentId: string, event: AgentHarnessEvent): Promise<void> }
	)._handleAgentHarnessEvent(agentId, { type: "settled", nextTurnCount: 0 });
}

async function emitQueueUpdate(
	orchestrator: AgentOrchestrator,
	agentId: string,
	queues: { steer?: UserMessage[]; followUp?: UserMessage[]; nextTurn?: AgentMessage[] },
): Promise<void> {
	await (
		orchestrator as unknown as { _handleAgentHarnessEvent(agentId: string, event: AgentHarnessEvent): Promise<void> }
	)._handleAgentHarnessEvent(agentId, {
		type: "queue_update",
		steer: queues.steer ?? [],
		followUp: queues.followUp ?? [],
		nextTurn: queues.nextTurn ?? [],
	});
}

function assistantMessage(totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "turn" }],
		api: defaultModel.api,
		provider: defaultModel.provider,
		model: defaultModel.id,
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

/**
 * A trusted project with one persistent agent, so the cross-session readers
 * have real JSONL sessions to find and the trust gate is open by default.
 */
async function createHarness() {
	const env = new MemoryExecutionEnv();
	const orchestrator = await createOrchestrator(env);
	await orchestrator.settingManager.setProjectTrusted(true);
	orchestrator.registerExtension("sample", () => {});
	const agentId = await orchestrator.spawnAgent();
	const stored = await orchestrator.sessionManager.createAgentSession({ agentId, agentProfile: defaultProfile });
	const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
	if (!runner) throw new Error("Expected extension runner.");
	const context = runner.createContext("sample");
	return { env, orchestrator, agentId, actions: context.actions, session: context.session, stored };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function emitHarnessMessageEnd(
	orchestrator: AgentOrchestrator,
	agentId: string,
	message: AgentMessage,
): Promise<void> {
	const harness = requireAgentHarness(orchestrator, agentId);
	await (
		harness as unknown as { handleAgentEvent(event: { type: "message_end"; message: AgentMessage }): Promise<void> }
	).handleAgentEvent({ type: "message_end", message });
}

type ExtensionInputPresentedEvent = Extract<OrchestratorEvent, { type: "extension_input_presented" }>;

function waitForQueuedFollowUp(orchestrator: AgentOrchestrator, agentId: string): Promise<AgentMessage> {
	return new Promise((resolve) => {
		let unsubscribe = () => {};
		unsubscribe = orchestrator.subscribe((event) => {
			if (event.type !== "agent_harness_event" || event.agentId !== agentId || event.event.type !== "queue_update") {
				return;
			}
			const message = event.event.followUp.at(-1);
			if (!message) return;
			unsubscribe();
			resolve(message);
		});
	});
}

function waitForInputPresentation(
	orchestrator: AgentOrchestrator,
	agentId: string,
): Promise<ExtensionInputPresentedEvent> {
	return new Promise((resolve) => {
		let unsubscribe = () => {};
		unsubscribe = orchestrator.subscribe((event) => {
			if (event.type !== "extension_input_presented" || event.agentId !== agentId) {
				return;
			}
			unsubscribe();
			resolve(event);
		});
	});
}

async function commitPresentedFollowUp(
	harness: Harness,
	text: string,
	presentation: ExtensionInputPresentation,
): Promise<ExtensionInputPresentedEvent> {
	const agentHarness = requireAgentHarness(harness.orchestrator, harness.agentId);
	(agentHarness as unknown as { phase: "turn" }).phase = "turn";
	const queued = waitForQueuedFollowUp(harness.orchestrator, harness.agentId);
	const presented = waitForInputPresentation(harness.orchestrator, harness.agentId);
	await harness.actions.followUp(text, { presentation });
	await emitHarnessMessageEnd(harness.orchestrator, harness.agentId, await queued);
	return await presented;
}

describe("extension session reads", () => {
	it("exposes the agent's own session snapshot, tree, and leaf", async () => {
		const { agentId, session, stored } = await createHarness();
		await stored.appendMessage({ role: "user", content: "hi", timestamp: 1 });

		const snapshot = await session.getSnapshot();
		const tree = await session.getTree();
		const leafId = await session.getLeafId();

		expect(snapshot.id).toBe(agentId);
		expect(tree.entries.length).toBeGreaterThan(0);
		expect(leafId).toBe(snapshot.leafId);
		expect(tree.pathToRoot).toEqual(snapshot.pathToRoot);
		// Identity and conversation only: no filesystem layout reaches the author.
		expect(snapshot).not.toHaveProperty("metadata");
		expect(snapshot).not.toHaveProperty("path");
		expect(snapshot).not.toHaveProperty("cwd");
	});

	it("lists the project's sessions and reads one back by its opaque ref", async () => {
		const { agentId, session, stored } = await createHarness();
		await stored.appendMessage({ role: "user", content: "remembered", timestamp: 1 });

		const sessions = await session.listSessions();
		const own = sessions.find((candidate) => candidate.id === agentId);
		expect(own).toBeDefined();
		if (!own) throw new Error("Expected the agent's own session to be listed.");

		// A candidate carries a ref, never the path it stands for.
		expect(own).not.toHaveProperty("path");
		expect(own).not.toHaveProperty("cwd");
		expect(own).not.toHaveProperty("parentSessionPath");
		expect(own.ref).toEqual(expect.any(String));
		expect(own.ref).not.toContain("/");

		const read = await session.readSession(own.ref);
		expect(read.id).toBe(agentId);
		expect(read.entries.length).toBeGreaterThan(0);
		// The agent's own session answers under the same ref either way.
		expect((await session.getSnapshot()).ref).toBe(own.ref);
	});

	it("refuses a session ref it never handed out", async () => {
		const { session } = await createHarness();

		await expect(session.readSession("/sessions/somewhere.jsonl")).rejects.toThrow(/Unknown session handle/);
	});

	it("reads a live session through its open handle rather than a stale reopen", async () => {
		const { agentId, session, stored } = await createHarness();
		const sessions = await session.listSessions();
		const own = sessions.find((candidate) => candidate.id === agentId);
		if (!own) throw new Error("Expected the agent's own session to be listed.");

		await stored.appendMessage({ role: "user", content: "written after listing", timestamp: 1 });

		const read = await session.readSession(own.ref);
		expect(read.leafId).toBe(await stored.getLeafId());
	});

	it("gates cross-session reads on project trust but leaves the own session open", async () => {
		const { orchestrator, session } = await createHarness();
		await orchestrator.settingManager.setProjectTrusted(false);

		await expect(session.listSessions()).rejects.toThrow(/may not list the project's sessions/);
		await expect(session.readSession("whatever")).rejects.toThrow(/may not read another session/);
		// The extension already runs inside this session, so reading it needs no
		// further permission.
		await expect(session.getSnapshot()).resolves.toBeDefined();
	});

	it("reports a cross-session read denial as an attributed action failure", async () => {
		const { orchestrator, session } = await createHarness();
		await orchestrator.settingManager.setProjectTrusted(false);
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await expect(session.listSessions()).rejects.toThrow();

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					extensionId: "sample",
					message: expect.stringContaining("action 'listSessions' failed"),
				}),
			}),
		);
	});

	it("returns detached entries that cannot mutate the live session", async () => {
		const { session, stored } = await createHarness();
		await stored.appendMessage({ role: "user", content: "stored text", timestamp: 1 });

		const firstRead = await session.getTree();
		const userEntry = firstRead.pathToRoot.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (userEntry?.type !== "message" || userEntry.message.role !== "user") {
			throw new Error("Expected a user message.");
		}
		userEntry.message.content = "mutated through the read API";

		const secondRead = await session.getTree();
		const storedUserEntry = secondRead.pathToRoot.find(
			(entry) => entry.type === "message" && entry.message.role === "user",
		);
		expect(
			storedUserEntry?.type === "message" && storedUserEntry.message.role === "user"
				? storedUserEntry.message.content
				: undefined,
		).toBe("stored text");
	});
});

describe("extension context usage", () => {
	it("has no measurement before the branch carries an assistant usage", async () => {
		const { orchestrator, agentId, actions } = await createHarness();

		await emitSettled(orchestrator, agentId);

		expect(actions.getContextUsage()).toBeUndefined();
	});

	it("measures the branch on settled and publishes the change once", async () => {
		const { orchestrator, agentId, actions, stored } = await createHarness();
		// The default reserve exceeds defaultModel's 1000-token window, so any
		// usage would trip auto-compaction. This is the gauge's test, not the
		// trigger's: measure without compacting.
		orchestrator.settingManager.setCompactionEnabled(false);
		// 250 of a 1000-token window is a quarter full.
		await stored.appendMessage(assistantMessage(250));
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await emitSettled(orchestrator, agentId);
		// A second settled measuring the same branch is not news.
		await emitSettled(orchestrator, agentId);

		expect(actions.getContextUsage()).toEqual({
			tokens: 250,
			contextWindow: 1000,
			percent: 25,
			model: `${defaultModel.provider}/${defaultModel.id}`,
		});
		const usageEvents = events.filter((event) => event.type === "agent_context_usage_changed");
		expect(usageEvents).toEqual([
			expect.objectContaining({
				type: "agent_context_usage_changed",
				agentId,
				usage: expect.objectContaining({ tokens: 250, percent: 25 }),
			}),
		]);
	});

	it("reports percent on Pi's 0-100 scale so ported thresholds still fire", async () => {
		const { orchestrator, agentId, actions, stored } = await createHarness();
		orchestrator.settingManager.setCompactionEnabled(false);
		// 960 of a 1000-token window is the kind of level a ported extension
		// checks with `percent >= 95`.
		await stored.appendMessage(assistantMessage(960));

		await emitSettled(orchestrator, agentId);

		expect(actions.getContextUsage()?.percent).toBe(96);
	});

	it("drops the measurement when the model, and so the window, changes", async () => {
		const { orchestrator, agentId, actions, stored } = await createHarness();
		orchestrator.settingManager.setCompactionEnabled(false);
		await stored.appendMessage(assistantMessage(250));
		await emitSettled(orchestrator, agentId);
		expect(actions.getContextUsage()?.model).toBe(`${defaultModel.provider}/${defaultModel.id}`);

		await orchestrator.setAgentModel(agentId, { ...defaultModel, id: "wide-model", contextWindow: 100_000 });

		// Never report the old window, or the old model's name, as current.
		expect(actions.getContextUsage()).toBeUndefined();
	});

	it("drops the measurement when the branch no longer has one", async () => {
		const { orchestrator, agentId, actions, stored } = await createHarness();
		orchestrator.settingManager.setCompactionEnabled(false);
		const measuredLeafId = await stored.getLeafId();
		await stored.appendMessage(assistantMessage(250));
		await emitSettled(orchestrator, agentId);
		expect(actions.getContextUsage()).toBeDefined();

		// Move back to a branch point with no assistant usage on it.
		await stored.moveTo(measuredLeafId);
		await emitSettled(orchestrator, agentId);

		expect(actions.getContextUsage()).toBeUndefined();
	});

	it("invalidates on a real tree move but not on a no-op navigation", async () => {
		const { orchestrator, agentId, actions, stored } = await createHarness();
		orchestrator.settingManager.setCompactionEnabled(false);
		const measuredEntryId = await stored.appendMessage(assistantMessage(250));
		await emitSettled(orchestrator, agentId);

		await orchestrator.navigateAgentTree(agentId, measuredEntryId);
		expect(actions.getContextUsage()).toBeDefined();

		await stored.appendMessage({ role: "user", content: "later branch", timestamp: 3 });
		await orchestrator.navigateAgentTree(agentId, measuredEntryId);
		expect(actions.getContextUsage()).toBeUndefined();
	});

	it("clears a stale measurement when refreshing the branch fails", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		requireAgentRecord(orchestrator, agentId).contextUsage = {
			tokens: 10,
			contextWindow: 100,
			percent: 10,
			model: "test/model",
		};
		Object.assign(orchestrator.sessionManager, {
			getAgentSessionSnapshot: async () => {
				throw new Error("session read failed");
			},
		});

		await emitSettled(orchestrator, agentId);

		expect(actions.getContextUsage()).toBeUndefined();
	});

	it("drops the measurement after compaction instead of reporting the old branch", async () => {
		const { orchestrator, agentId, actions, stored } = await createHarness();
		orchestrator.settingManager.setCompactionEnabled(false);
		await stored.appendMessage(assistantMessage(250));
		await emitSettled(orchestrator, agentId);
		expect(actions.getContextUsage()).toBeDefined();

		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		Object.assign(orchestrator, {
			_runMaintenanceOperation: async () => ({ summary: "s", firstKeptEntryId: "e", tokensBefore: 250 }),
		});

		await orchestrator.compactAgent(agentId);

		expect(actions.getContextUsage()).toBeUndefined();
		expect(events).toContainEqual(
			expect.objectContaining({ type: "agent_context_usage_changed", agentId, usage: undefined }),
		);
	});

	it("returns detached usage and exposes it in the agent snapshot", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		const record = requireAgentRecord(orchestrator, agentId);
		record.contextUsage = { tokens: 10, contextWindow: 100, percent: 10, model: "test/model" };

		const usage = actions.getContextUsage();
		if (!usage) throw new Error("Expected context usage.");
		(usage as { tokens: number }).tokens = 99;

		expect(actions.getContextUsage()?.tokens).toBe(10);
		expect(orchestrator.inspectAgent(agentId)).toMatchObject({
			contextUsage: { tokens: 10, contextWindow: 100, percent: 10, model: "test/model" },
		});
	});
});

describe("extension input presentation", () => {
	it("persists the presentation with core-injected attribution and publishes it", async () => {
		const harness = await createHarness();
		const { orchestrator, agentId } = harness;
		const presented = await commitPresentedFollowUp(harness, "task 7 finished", {
			customType: "subagent-result",
			title: "Task 7",
			details: { taskId: 7, status: "ok" },
		});
		expect(presented).toMatchObject({
			type: "extension_input_presented",
			agentId,
			extensionId: "sample",
			presentation: { customType: "subagent-result", title: "Task 7", details: { taskId: 7, status: "ok" } },
		});
		const tree = await orchestrator.getAgentSessionTree(agentId);
		expect(tree.entries).toContainEqual(
			expect.objectContaining({
				id: presented.entryId,
				type: "custom",
				customType: EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE,
				data: expect.objectContaining({
					messageEntryId: presented.messageEntryId,
					// Attribution is injected by core, never taken from the caller.
					extensionId: "sample",
				}),
			}),
		);
		expect(tree.entries).toContainEqual(
			expect.objectContaining({
				id: presented.messageEntryId,
				type: "message",
				message: expect.objectContaining({ role: "user", content: [{ type: "text", text: "task 7 finished" }] }),
			}),
		);
	});

	it("commits a prompt presentation only after its user message lands", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		const presented = waitForInputPresentation(orchestrator, agentId);
		Object.assign(orchestrator, {
			_startAgentPrompt: async (
				targetAgentId: string,
				text: string,
			): Promise<{ method: "prompt"; completed: Promise<AssistantMessage> }> => {
				await emitHarnessMessageEnd(orchestrator, targetAgentId, { role: "user", content: text, timestamp: 1 });
				return { method: "prompt", completed: Promise.resolve(assistantMessage(1)) };
			},
		});

		await actions.prompt("prompt text", { presentation: { customType: "note" } });

		const event = await presented;
		const tree = await orchestrator.getAgentSessionTree(agentId);
		expect(tree.entries.find((entry) => entry.id === event.messageEntryId)).toMatchObject({
			type: "message",
			message: { role: "user", content: "prompt text" },
		});
	});

	// A blocked prompt is a returned outcome, not a rejection, so a wrapper that
	// only caught throws left a presentation describing a message that never
	// existed. Routing prompt through the message pipeline means the block
	// returns before any session write.
	it("records nothing when an interceptor blocks the prompt it described", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		orchestrator.registerExtension("sample", (api) => {
			api.intercept("input", () => ({ block: true, reason: "policy" }));
		});
		const agentId = await orchestrator.spawnAgent();
		await orchestrator.sessionManager.createAgentSession({ agentId, agentProfile: defaultProfile });
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await runner.createContext("sample").actions.prompt("blocked text", { presentation: { customType: "note" } });

		expect(events.some((event) => event.type === "extension_input_presented")).toBe(false);
		const tree = await orchestrator.getAgentSessionTree(agentId);
		expect(
			tree.entries.some(
				(entry) => entry.type === "custom" && entry.customType === EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE,
			),
		).toBe(false);
	});

	it("records no presentation when direct delivery fails", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		Object.assign(orchestrator, {
			steerAgent: async () => {
				throw new Error("harness rejected the steer");
			},
		});
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await expect(actions.steer("never lands", { presentation: { customType: "note" } })).rejects.toThrow(
			"harness rejected the steer",
		);

		const tree = await orchestrator.getAgentSessionTree(agentId);
		expect(
			tree.pathToRoot.some(
				(entry) => entry.type === "custom" && entry.customType === EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE,
			),
		).toBe(false);
		// And nothing was announced: an event cannot be taken back the way the
		// branch can, so it waits until the harness owns the text.
		expect(events.some((event) => event.type === "extension_input_presented")).toBe(false);
	});

	it("drops a presentation when abort clears its accepted queued message", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		const harness = requireAgentHarness(orchestrator, agentId);
		(harness as unknown as { phase: "turn" }).phase = "turn";
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});

		await actions.followUp("queued then aborted", { presentation: { customType: "note" } });
		await orchestrator.abortAgent(agentId);

		const tree = await orchestrator.getAgentSessionTree(agentId);
		expect(
			tree.pathToRoot.some(
				(entry) => entry.type === "custom" && entry.customType === EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE,
			),
		).toBe(false);
		expect(events.some((event) => event.type === "extension_input_presented")).toBe(false);
	});

	it("rejects a presentation core could not store or attribute", async () => {
		const { orchestrator, actions } = await createHarness();
		Object.assign(orchestrator, { followUpAgent: async () => {} });

		await expect(actions.followUp("text", { presentation: { customType: "bad/type" } })).rejects.toThrow(
			/customType must contain only/,
		);
		await expect(actions.followUp("text", { presentation: { customType: "ok", title: "   " } })).rejects.toThrow(
			/title must be a non-blank string/,
		);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		await expect(
			actions.followUp("text", {
				presentation: {
					customType: "ok",
					// Extensions load untyped, so the runtime guard is what protects
					// the session file, not the JsonValue annotation.
					details: cyclic as never,
				},
			}),
		).rejects.toThrow(/details must be JSON serializable/);
	});

	it("stores a detached, JSON-normalized copy of details", async () => {
		const harness = await createHarness();
		const { orchestrator, agentId } = harness;

		const details: Record<string, unknown> = { kept: "yes", dropped: undefined };
		const presented = await commitPresentedFollowUp(harness, "text", { customType: "ok", details: details as never });
		// Mutating after the call must not reach anything core already recorded.
		details.kept = "mutated";

		// The published value is the same one the JSONL will round-trip to:
		// `undefined` is already gone, so live and hydrated views agree.
		expect(presented.presentation.details).toEqual({ kept: "yes" });
		const tree = await orchestrator.getAgentSessionTree(agentId);
		const entry = tree.entries.find(
			(candidate) => candidate.type === "custom" && candidate.customType === EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE,
		);
		expect(entry).toMatchObject({ data: { presentation: { details: { kept: "yes" } } } });
	});

	it("does not let a live event mutate the persisted presentation", async () => {
		const harness = await createHarness();
		const { orchestrator, agentId } = harness;
		const presented = await commitPresentedFollowUp(harness, "queued", {
			customType: "note",
			details: { value: "stored" },
		});
		const details = presented.presentation.details;
		if (typeof details !== "object" || details === null || Array.isArray(details)) {
			throw new Error("Expected object details.");
		}
		(details as { value: string }).value = "mutated by client";

		const tree = await orchestrator.getAgentSessionTree(agentId);
		const entry = tree.entries.find(
			(candidate) => candidate.type === "custom" && candidate.customType === EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE,
		);
		expect(entry).toMatchObject({ data: { presentation: { details: { value: "stored" } } } });
	});

	it("leaves messages sent without a presentation unrecorded", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		Object.assign(orchestrator, { followUpAgent: async () => {} });

		await actions.followUp("plain text");

		const tree = await orchestrator.getAgentSessionTree(agentId);
		expect(
			tree.entries.some(
				(entry) => entry.type === "custom" && entry.customType === EXTENSION_INPUT_PRESENTATION_CUSTOM_TYPE,
			),
		).toBe(false);
	});
});

describe("extension read-only runtime getters", () => {
	it("reports project trust as the gate its own actions are checked against", async () => {
		const { orchestrator, actions } = await createHarness();
		expect(actions.isProjectTrusted()).toBe(true);

		await orchestrator.settingManager.setProjectTrusted(false);

		expect(actions.isProjectTrusted()).toBe(false);
	});

	it("reads the effective system prompt including extension sections", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		orchestrator.registerExtension("sample", (api) => {
			api.appendSystemPrompt("extension guidance section");
		});
		const agentId = await orchestrator.spawnAgent();
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");

		const prompt = await runner.createContext("sample").actions.getSystemPrompt();

		expect(prompt).toContain(defaultProfile.systemPrompt);
		expect(prompt).toContain("extension guidance section");
	});

	/**
	 * Scoped steer/followUp hand text straight to the harness, which keeps its
	 * queues private and reports them only through `queue_update`. Checking the
	 * orchestrator's own queue alone therefore answered "nothing pending" for
	 * text an extension had just handed over. Driving the harness event bridge
	 * is the same precedent as `emitSettled`: a real queued follow-up needs a
	 * running model turn, which unit tests never perform.
	 */
	it("counts messages sitting in the harness queue as pending", async () => {
		const { orchestrator, agentId, actions } = await createHarness();
		expect(actions.hasPendingMessages()).toBe(false);

		await emitQueueUpdate(orchestrator, agentId, {
			followUp: [{ role: "user", content: "read this next", timestamp: 1 }],
		});
		expect(actions.hasPendingMessages()).toBe(true);

		// Drained by the agent loop: pending again becomes false.
		await emitQueueUpdate(orchestrator, agentId, {});
		expect(actions.hasPendingMessages()).toBe(false);
	});
});

describe("extension observer delivery", () => {
	// The observed-event set is declared as a type; this is the check that the
	// dispatcher actually routes every name in it.
	it("delivers every declared observable event name to registered observers", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const observed: string[] = [];
		orchestrator.registerExtension("sample", (api) => {
			for (const name of Object.keys(EXTENSION_OBSERVED_EVENT_NAMES) as ExtensionObservedEventName[]) {
				api.observe(name, (event) => {
					observed.push(event.type);
				});
			}
		});
		const agentId = await orchestrator.spawnAgent();
		const stored = await orchestrator.sessionManager.createAgentSession({ agentId, agentProfile: defaultProfile });
		orchestrator.settingManager.setCompactionEnabled(false);
		await stored.appendMessage(assistantMessage(250));

		await emitSettled(orchestrator, agentId);

		expect(observed).toContain("agent_context_usage_changed");
	});
});
