import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../../src/core/agent-orchestrator.ts";
import { builtInCommands } from "../../../src/tui/commands/built-ins.ts";
import { CommandEngine, switchedAgentId } from "../../../src/tui/commands/engine.ts";

function stubOrchestrator(overrides: Record<string, unknown>): AgentOrchestrator {
	return { getAgentStatus: () => "idle", ...overrides } as unknown as AgentOrchestrator;
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
		expect(await engine.handleInput("hello world", context())).toEqual({ kind: "pass" });
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
			context({ listAvailableModelCandidates: async () => ({ models: [{ value: "openai/gpt-5" }] }) }),
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
				forkAgentSessionFromAgent: async (_agentId: string, options: unknown) => {
					forkedWith = options;
					return { agentId: "agent-2" };
				},
			}),
		);
		expect(outcome.kind).toBe("executed");
		expect(forkedWith).toBeUndefined();
	});

	it("runs the bare form when an optional argument has no candidates", async () => {
		let treeCalls = 0;
		const outcome = await engine.handleInput(
			"/tree",
			context({
				getAgentSessionTree: async () => {
					treeCalls += 1;
					return { entries: [] };
				},
			}),
		);
		// A fresh session has no user messages to navigate to; demanding an
		// argument would hide /tree's own listing behind "/tree:".
		expect(outcome).toMatchObject({ kind: "executed", name: "tree" });
		expect(treeCalls).toBe(2);
	});

	it("still offers a menu for an optional argument that has candidates", async () => {
		const outcome = await engine.handleInput(
			"/tree",
			context({
				getAgentSessionTree: async () => ({
					entries: [
						{
							id: "entry-1",
							type: "message",
							timestamp: "2026-01-01T00:00:00.000Z",
							message: { role: "user", content: "Fix the flaky test" },
						},
					],
				}),
			}),
		);
		expect(outcome).toMatchObject({
			kind: "needs-argument",
			candidates: [{ value: "entry-1", label: "Fix the flaky test" }],
		});
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

	it("blocks turn-control commands during maintenance", async () => {
		const abortAgent = vi.fn(async () => {});
		const followUpAgent = vi.fn(async () => {});
		const sendMessage = vi.fn(async () => ({ kind: "accepted" as const }));
		const commandContext = context({
			getAgentStatus: () => "running",
			getAgentMaintenance: () => "compaction",
			abortAgent,
			followUpAgent,
			sendMessage,
		});

		for (const input of ["/abort", "/follow-up later", "/steer now"]) {
			const outcome = await engine.handleInput(input, commandContext);
			expect(outcome).toMatchObject({ kind: "failed", error: { message: expect.stringContaining("compaction") } });
		}
		expect(abortAgent).not.toHaveBeenCalled();
		expect(followUpAgent).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("routes /steer through the human interrupt message path", async () => {
		let message: unknown;
		const outcome = await engine.handleInput(
			"/steer go now",
			context({
				getAgentStatus: () => "running",
				sendMessage: async (draft: unknown) => {
					message = draft;
					return { kind: "accepted" as const };
				},
			}),
		);

		expect(outcome).toMatchObject({ kind: "executed", name: "steer" });
		expect(message).toEqual({ source: { kind: "human" }, targetAgentId: "agent-1", body: "go now", mode: "interrupt" });
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
			pendingContext({ listAgentSessions: async () => ({ sessions: [] }) }),
		);

		expect(outcome).toMatchObject({ kind: "executed", name: "session" });
	});

	it("carries the command's formatResult as display text", async () => {
		const outcome = await engine.handleInput(
			"/resume session-1",
			context({
				resumeAgentSessionByReference: async () => ({
					agentId: "agent-2",
					snapshot: { profile: { reference: { id: "default", label: "Default" } }, model: { id: "test-model" } },
				}),
			}),
		);

		expect(outcome).toMatchObject({
			kind: "executed",
			name: "resume",
			display: "resumed agent-2 · Default · test-model",
		});
	});

	it("rejects active-only commands without an active agent", async () => {
		const outcome = await engine.handleInput("/status", pendingContext());

		expect(outcome).toMatchObject({ kind: "failed", error: { message: expect.stringContaining("active agent") } });
	});

	it("offers model candidates without an active agent", async () => {
		const outcome = await engine.handleInput(
			"/model",
			pendingContext({ listAvailableModelCandidates: async () => ({ models: [{ value: "openai/gpt-5" }] }) }),
		);

		expect(outcome).toMatchObject({ kind: "needs-argument", candidates: [{ value: "openai/gpt-5" }] });
	});

	it("requires materialization before executing a setting command", async () => {
		const outcome = await engine.handleInput("/model:openai/gpt-5", pendingContext());

		expect(outcome).toMatchObject({ kind: "failed", error: { message: expect.stringContaining("active agent") } });
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

	it("expands a prompt command into the submitted text", async () => {
		const outcome = await engine.handleInput(
			"/skill review focus on locking",
			context({
				getAgentSkill: async () => ({
					name: "review",
					description: "Review code.",
					content: "Review the diff carefully.",
					filePath: "/skills/review/SKILL.md",
				}),
			}),
		);
		expect(outcome.kind).toBe("expanded");
		if (outcome.kind === "expanded") {
			expect(outcome.text).toContain('<skill name="review" location="/skills/review/SKILL.md">');
			// The body is inlined, not pointed at.
			expect(outcome.text).toContain("Review the diff carefully.");
			expect(outcome.text).toContain("focus on locking");
		}
	});

	it("substitutes positional arguments into a prompt template", async () => {
		const outcome = await engine.handleInput(
			'/prompt review src/a.ts "src/b c.ts"',
			context({
				getAgentPromptTemplate: async () => ({
					name: "review",
					description: "Review files.",
					content: "Review $1 and $2. All: $ARGUMENTS",
				}),
			}),
		);
		expect(outcome).toMatchObject({
			kind: "expanded",
			text: "Review src/a.ts and src/b c.ts. All: src/a.ts src/b c.ts",
		});
	});

	it("fails the input when a prompt expansion throws", async () => {
		const outcome = await engine.handleInput(
			"/prompt missing",
			context({
				getAgentPromptTemplate: async () => {
					throw new Error("not found");
				},
			}),
		);
		expect(outcome.kind).toBe("failed");
	});

	it("offers candidates for a prompt command given no argument", async () => {
		const outcome = await engine.handleInput(
			"/skill",
			context({ listAgentSkillCandidates: async () => ({ skills: [{ value: "review" }] }) }),
		);
		expect(outcome).toMatchObject({ kind: "needs-argument", candidates: [{ value: "review" }] });
	});
});

describe("CommandEngine.list and match", () => {
	const engine = new CommandEngine(builtInCommands);

	it("marks status-gated commands unavailable", () => {
		const steer = engine.list({ activity: "idle" }).find((view) => view.name === "steer");
		expect(steer?.available).toBe(false);
		const running = engine.list({ activity: "running" }).find((view) => view.name === "steer");
		expect(running?.available).toBe(true);
	});

	it("marks turn controls unavailable during maintenance", () => {
		const views = engine.list({ activity: "running", maintenance: "tree-navigation" });
		for (const name of ["abort", "follow-up", "steer"]) {
			expect(views.find((view) => view.name === name)).toMatchObject({
				available: false,
				unavailableReason: expect.stringContaining("tree navigation"),
			});
		}
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
		expect(switchedAgentId({ kind: "executed", commandId: "c1", name: "resume", value: { agentId: "agent-9" } })).toBe(
			"agent-9",
		);
		expect(
			switchedAgentId({ kind: "executed", commandId: "c2", name: "status", value: { agentId: "agent-9" } }),
		).toBeUndefined();
		expect(switchedAgentId({ kind: "pass" })).toBeUndefined();
	});
});
