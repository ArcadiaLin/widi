import { describe, expect, it, vi } from "vitest";
import type { RuntimeModel } from "../../src/core/types.ts";
import {
	PendingAgentController,
	type PendingAgentDisplay,
	type PendingAgentRuntime,
} from "../../src/tui/pending-agent.ts";
import { createTuiApplicationState } from "../../src/tui/state.ts";

describe("PendingAgentController", () => {
	it("does not spawn while creating default and new-session intents", () => {
		const spawnAgent = vi.fn(async () => "main");
		const newAgentSessionFromAgent = vi.fn(async () => ({
			agentId: "worker",
		}));
		const controller = createController({
			spawnAgent,
			newAgentSessionFromAgent,
		});

		controller.beginDefault(display());
		controller.beginNewSession("main", display());

		expect(spawnAgent).not.toHaveBeenCalled();
		expect(newAgentSessionFromAgent).not.toHaveBeenCalled();
	});

	it("materializes one default agent for concurrent callers", async () => {
		let resolveSpawn: (agentId: string) => void = () => {};
		const spawnPromise = new Promise<string>((resolve) => {
			resolveSpawn = resolve;
		});
		const spawnAgent = vi.fn(() => spawnPromise);
		const state = createTuiApplicationState();
		const controller = createController({ spawnAgent }, state);
		controller.beginDefault(display());

		const first = controller.materialize();
		const second = controller.materialize();
		resolveSpawn("main");

		await expect(Promise.all([first, second])).resolves.toEqual([
			"main",
			"main",
		]);
		expect(spawnAgent).toHaveBeenCalledTimes(1);
		expect(state.pendingAgent).toBeUndefined();
	});

	it("uses the source agent for a pending new session", async () => {
		const newAgentSessionFromAgent = vi.fn(async () => ({
			agentId: "main-2",
		}));
		const controller = createController({ newAgentSessionFromAgent });
		controller.beginNewSession("main", display());

		await expect(controller.materialize()).resolves.toBe("main-2");
		expect(newAgentSessionFromAgent).toHaveBeenCalledWith("main");
	});

	it("keeps the pending intent after materialization fails", async () => {
		const spawnAgent = vi.fn(async () => {
			throw new Error("spawn failed");
		});
		const state = createTuiApplicationState();
		const controller = createController({ spawnAgent }, state);
		controller.beginDefault(display());

		await expect(controller.materialize()).rejects.toThrow("spawn failed");
		expect(state.pendingAgent?.start).toEqual({ kind: "default" });
	});
});

function createController(
	overrides: Partial<PendingAgentRuntime> = {},
	state = createTuiApplicationState(),
): PendingAgentController {
	const runtime: PendingAgentRuntime = {
		spawnAgent: async () => "main",
		newAgentSessionFromAgent: async () => ({ agentId: "main-2" }),
		...overrides,
	};
	return new PendingAgentController(state, runtime, display());
}

function display(): PendingAgentDisplay {
	return {
		profileLabel: "Main Agent",
		model: model(),
		thinkingLevel: "medium",
	};
}

function model(): RuntimeModel {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000,
		maxTokens: 100,
	};
}
