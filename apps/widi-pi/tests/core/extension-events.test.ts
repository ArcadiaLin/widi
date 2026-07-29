/**
 * The runtime-level extension event bus (stage 0, capability C5): the channel
 * two extensions use to agree on a protocol - `herdr:blocked` and the like -
 * without either one knowing whether the other is installed.
 */

import { describe, expect, it } from "vitest";
import type {
	AgentOrchestrator,
	OrchestratorEvent,
} from "../../src/core/agent-orchestrator.ts";
import type {
	ExtensionActivationApi,
	ExtensionEventEnvelope,
} from "../../src/core/extension/api.ts";
import { MAX_EXTENSION_EVENT_DISPATCH_DEPTH } from "../../src/core/extension/index.ts";
import {
	createOrchestrator,
	MemoryExecutionEnv,
	requireAgentRecord,
} from "../helpers/orchestrator.ts";

function requireActions(orchestrator: AgentOrchestrator, agentId: string) {
	const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
	if (!runner) throw new Error("Expected extension runner.");
	return runner.createContext("sender").actions;
}

function collectDiagnostics(
	orchestrator: AgentOrchestrator,
): Extract<OrchestratorEvent, { type: "diagnostic" }>["diagnostic"][] {
	const diagnostics: Extract<
		OrchestratorEvent,
		{ type: "diagnostic" }
	>["diagnostic"][] = [];
	orchestrator.subscribe((event) => {
		if (event.type === "diagnostic") diagnostics.push(event.diagnostic);
	});
	return diagnostics;
}

describe("extension event bus", () => {
	it("delivers to every live runtime, including the sender's own", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const received: { agentId: string; envelope: ExtensionEventEnvelope }[] =
			[];
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("herdr:blocked", (envelope, context) => {
				received.push({ agentId: context.agentId, envelope });
			});
		});
		const firstAgentId = await orchestrator.spawnAgent();
		const secondAgentId = await orchestrator.spawnAgent();

		await requireActions(orchestrator, firstAgentId).emitExtensionEvent(
			"herdr:blocked",
			{ pane: 3 },
		);

		expect(received.map((entry) => entry.agentId).sort()).toEqual(
			[firstAgentId, secondAgentId].sort(),
		);
		for (const entry of received) {
			expect(entry.envelope.name).toBe("herdr:blocked");
			expect(entry.envelope.payload).toEqual({ pane: 3 });
			expect(entry.envelope.sourceExtensionId).toBe("sender");
			expect(entry.envelope.sourceAgentId).toBe(firstAgentId);
		}
	});

	it("only wakes subscribers of the emitted name", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const names: string[] = [];
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("wanted", () => {
				names.push("wanted");
			});
			api.onExtensionEvent("other", () => {
				names.push("other");
			});
		});
		const agentId = await orchestrator.spawnAgent();

		await requireActions(orchestrator, agentId).emitExtensionEvent("wanted");

		expect(names).toEqual(["wanted"]);
	});

	it("hands every subscriber a payload detached from the emitter", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const payloads: unknown[] = [];
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("state", (envelope) => {
				payloads.push(envelope.payload);
			});
		});
		const agentId = await orchestrator.spawnAgent();
		const payload = { counts: [1, 2] };

		await requireActions(orchestrator, agentId).emitExtensionEvent(
			"state",
			payload,
		);
		payload.counts.push(3);

		expect(payloads).toEqual([{ counts: [1, 2] }]);
	});

	it("rejects an unusable name or payload before anything is delivered", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		let delivered = 0;
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("fine", () => {
				delivered += 1;
			});
		});
		const agentId = await orchestrator.spawnAgent();
		const actions = requireActions(orchestrator, agentId);

		await expect(actions.emitExtensionEvent("has space")).rejects.toThrow(
			TypeError,
		);
		await expect(
			actions.emitExtensionEvent("fine", {
				big: "x".repeat(70_000),
			}),
		).rejects.toThrow(RangeError);

		expect(delivered).toBe(0);
	});

	// Registration-time validation, like registerProvider's: a name nobody emits
	// is indistinguishable from one nobody has sent yet, so a typo would
	// otherwise stay silent for the life of the extension.
	it("refuses a subscription to an invalid name at activation", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		orchestrator.registerExtension("broken", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("has space", () => {});
		});

		await expect(orchestrator.spawnAgent()).rejects.toThrow(
			"Extension event name must contain only",
		);
	});

	it("reports a failing subscriber and still reaches the rest", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const diagnostics = collectDiagnostics(orchestrator);
		let reached = 0;
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("ping", () => {
				throw new Error("subscriber exploded");
			});
			api.onExtensionEvent("ping", () => {
				reached += 1;
			});
		});
		const agentId = await orchestrator.spawnAgent();

		await requireActions(orchestrator, agentId).emitExtensionEvent("ping");

		expect(reached).toBe(1);
		const failure = diagnostics.find(
			(diagnostic) => diagnostic.code === "extension.handler_failed",
		);
		expect(failure?.message).toContain("subscriber exploded");
	});

	it("stops a cascade at the dispatch depth limit", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const diagnostics = collectDiagnostics(orchestrator);
		let relays = 0;
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("echo", async (_envelope, context) => {
				relays += 1;
				await context.actions.emitExtensionEvent("echo");
			});
		});
		const agentId = await orchestrator.spawnAgent();

		await requireActions(orchestrator, agentId).emitExtensionEvent("echo");

		expect(relays).toBe(MAX_EXTENSION_EVENT_DISPATCH_DEPTH);
		expect(
			diagnostics.some(
				(diagnostic) =>
					diagnostic.code === "extension.event_recursion_dropped" &&
					diagnostic.extensionId === "sender",
			),
		).toBe(true);
	});

	it("drops the subscriptions of a disposed agent", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const seen: string[] = [];
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("ping", (_envelope, context) => {
				seen.push(context.agentId);
			});
		});
		const survivorId = await orchestrator.spawnAgent();
		const disposedId = await orchestrator.spawnAgent();
		await orchestrator.disposeAgent(disposedId, "test");

		await requireActions(orchestrator, survivorId).emitExtensionEvent("ping");

		expect(seen).toEqual([survivorId]);
	});

	it("moves subscriptions to the runner an extension reload installs", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		const generations: number[] = [];
		let generation = 0;
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			const activationGeneration = ++generation;
			api.onExtensionEvent("ping", () => {
				generations.push(activationGeneration);
			});
		});
		const agentId = await orchestrator.spawnAgent();
		await orchestrator.reloadExtensions({ agentIds: [agentId] });

		await requireActions(orchestrator, agentId).emitExtensionEvent("ping");

		expect(generations).toEqual([2]);
	});

	it("lists bus subscriptions among the inspectable hooks", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		orchestrator.registerExtension("sender", (api: ExtensionActivationApi) => {
			api.onExtensionEvent("herdr:blocked", () => {});
		});
		const agentId = await orchestrator.spawnAgent();

		const hooks = orchestrator.inspectAgent(agentId).extensionSnapshot.hooks;

		expect(hooks).toContainEqual({
			kind: "event",
			extensionId: "sender",
			eventName: "herdr:blocked",
			divisionId: undefined,
		});
	});
});
