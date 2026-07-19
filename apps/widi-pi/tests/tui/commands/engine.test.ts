import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../../src/core/agent-orchestrator.ts";
import { builtInCommands } from "../../../src/tui/commands/built-ins.ts";
import {
	CommandEngine,
	switchedAgentId,
} from "../../../src/tui/commands/engine.ts";

function stubOrchestrator(
	overrides: Record<string, unknown>,
): AgentOrchestrator {
	return {
		getAgentStatus: () => "idle",
		...overrides,
	} as unknown as AgentOrchestrator;
}

function context(overrides: Record<string, unknown> = {}) {
	return { agentId: "agent-1", orchestrator: stubOrchestrator(overrides) };
}

function pendingContext(overrides: Record<string, unknown> = {}) {
	return { orchestrator: stubOrchestrator(overrides) };
}

describe("CommandEngine.handleInput", () => {
	const engine = new CommandEngine(builtInCommands);

	it("passes plain prompts through", async () => {
		expect(await engine.handleInput("hello world", context())).toEqual({
			kind: "pass",
		});
	});

	it("executes a line command against orchestrator atomics", async () => {
		let aborted = 0;
		const outcome = await engine.handleInput(
			"/abort",
			context({
				abortAgent: async () => {
					aborted += 1;
				},
			}),
		);
		expect(outcome.kind).toBe("executed");
		expect(aborted).toBe(1);
	});

	it("returns needs-argument for a bare command with completion", async () => {
		const outcome = await engine.handleInput(
			"/model",
			context({
				listAvailableModelCandidates: async () => ({
					models: [{ value: "openai/gpt-5" }],
				}),
			}),
		);
		expect(outcome.kind).toBe("needs-argument");
		if (outcome.kind === "needs-argument") {
			expect(outcome.command.name).toBe("model");
			expect(outcome.candidates).toEqual([{ value: "openai/gpt-5" }]);
		}
	});

	it("executes an explicit empty argument instead of re-prompting", async () => {
		let forkedWith: unknown = "unset";
		const outcome = await engine.handleInput(
			"/fork:",
			context({
				forkAgentSessionFromAgent: async (
					_agentId: string,
					options: unknown,
				) => {
					forkedWith = options;
					return { agentId: "agent-2" };
				},
			}),
		);
		expect(outcome.kind).toBe("executed");
		expect(forkedWith).toBeUndefined();
	});

	it("re-prompts a required argument given as blank", async () => {
		const outcome = await engine.handleInput("/rename: ", context());
		expect(outcome.kind).toBe("needs-argument");
		if (outcome.kind === "needs-argument") {
			expect(outcome.command.name).toBe("rename");
			expect(outcome.candidates).toEqual([]);
		}
	});

	it("fails unavailable commands with a CommandError", async () => {
		const outcome = await engine.handleInput("/steer:go", context());
		expect(outcome.kind).toBe("failed");
		if (outcome.kind === "failed") {
			expect(outcome.error.message).toContain("running");
		}
	});

	it("wraps execute exceptions as failed outcomes", async () => {
		const outcome = await engine.handleInput(
			"/abort",
			context({
				abortAgent: async () => {
					throw new Error("boom");
				},
			}),
		);
		expect(outcome.kind).toBe("failed");
		if (outcome.kind === "failed") expect(outcome.error.message).toBe("boom");
	});

	it("executes runtime commands without an active agent", async () => {
		const outcome = await engine.handleInput(
			"/session",
			pendingContext({
				listAgentSessions: async () => ({ sessions: [] }),
			}),
		);

		expect(outcome).toMatchObject({ kind: "executed", name: "session" });
	});

	it("rejects active-only commands without an active agent", async () => {
		const outcome = await engine.handleInput("/status", pendingContext());

		expect(outcome).toMatchObject({
			kind: "failed",
			error: { message: expect.stringContaining("active agent") },
		});
	});

	it("offers model candidates without an active agent", async () => {
		const outcome = await engine.handleInput(
			"/model",
			pendingContext({
				listAvailableModelCandidates: async () => ({
					models: [{ value: "openai/gpt-5" }],
				}),
			}),
		);

		expect(outcome).toMatchObject({
			kind: "needs-argument",
			candidates: [{ value: "openai/gpt-5" }],
		});
	});

	it("requires materialization before executing a setting command", async () => {
		const outcome = await engine.handleInput(
			"/model:openai/gpt-5",
			pendingContext(),
		);

		expect(outcome).toMatchObject({
			kind: "failed",
			error: { message: expect.stringContaining("active agent") },
		});
	});

	it("reports command start through hooks", async () => {
		const started: string[] = [];
		await engine.handleInput("/status", context(), {
			onCommandStart: (_id, name) => {
				started.push(name);
			},
		});
		expect(started).toEqual(["status"]);
	});

	it("expands inline commands and records positions", async () => {
		const outcome = await engine.handleInput(
			"use <skill:review> now",
			context({
				getAgentSkill: async () => ({
					name: "review",
					description: "Review code.",
					filePath: "/skills/review.md",
				}),
			}),
		);
		expect(outcome.kind).toBe("expanded");
		if (outcome.kind === "expanded") {
			expect(outcome.text).toContain('<skill name="review">');
			expect(outcome.expansion.originalText).toBe("use <skill:review> now");
			expect(outcome.expansion.items).toHaveLength(1);
			expect(outcome.expansion.items[0]).toMatchObject({
				name: "skill",
				trigger: "<",
				argument: "review",
				start: 4,
				end: 18,
			});
		}
	});

	it("fails the whole input when an inline expansion throws", async () => {
		const outcome = await engine.handleInput(
			"<prompt:missing>",
			context({
				getAgentPromptTemplate: async () => {
					throw new Error("not found");
				},
			}),
		);
		expect(outcome.kind).toBe("failed");
	});
});

describe("CommandEngine.list and match", () => {
	const engine = new CommandEngine(builtInCommands);

	it("marks status-gated commands unavailable", () => {
		const steer = engine.list("idle").find((view) => view.name === "steer");
		expect(steer?.available).toBe(false);
		const running = engine
			.list("running")
			.find((view) => view.name === "steer");
		expect(running?.available).toBe(true);
	});

	it("marks active commands unavailable without an agent", () => {
		const views = engine.list(undefined);

		expect(views.find((view) => view.name === "status")).toMatchObject({
			available: false,
			unavailableReason: expect.stringContaining("active agent"),
		});
		expect(views.find((view) => view.name === "model")?.available).toBe(true);
		expect(views.find((view) => view.name === "session")?.available).toBe(true);
	});

	it("matches known line commands only", () => {
		expect(engine.match("/abort")?.name).toBe("abort");
		expect(engine.match("/nope:x")).toBeUndefined();
		expect(engine.match("plain text")).toBeUndefined();
	});
});

describe("switchedAgentId", () => {
	it("extracts the agent id from fork/resume results only", () => {
		expect(
			switchedAgentId({
				kind: "executed",
				commandId: "c1",
				name: "resume",
				value: { agentId: "agent-9" },
			}),
		).toBe("agent-9");
		expect(
			switchedAgentId({
				kind: "executed",
				commandId: "c2",
				name: "status",
				value: { agentId: "agent-9" },
			}),
		).toBeUndefined();
		expect(switchedAgentId({ kind: "pass" })).toBeUndefined();
	});
});
