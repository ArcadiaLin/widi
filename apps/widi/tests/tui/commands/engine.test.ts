import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../../src/core/agent-orchestrator.ts";
import { builtInCommands } from "../../../src/tui/commands/built-ins.ts";
import { CommandEngine, switchedAgentId } from "../../../src/tui/commands/engine.ts";
import type { ActionCommand, CommandDefinition } from "../../../src/tui/commands/types.ts";

function stubOrchestrator(overrides: Record<string, unknown>): AgentOrchestrator {
	// Status gates read `getAgentActivity`; the overrides may replace it.
	return {
		getAgentStatus: () => "idle",
		getAgentActivity: () => ({ activity: "idle" }),
		sendMessage: async () => ({ kind: "accepted" }),
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
		let forkedFrom: unknown = "unset";
		const outcome = await engine.handleInput(
			"/fork:",
			context({
				spawnAgent: async (request: { origin: unknown }) => {
					forkedFrom = request.origin;
					return "agent-2";
				},
				inspectAgent: () => ({ agentId: "agent-2" }),
			}),
		);
		expect(outcome.kind).toBe("executed");
		// An explicit empty argument forks at the current leaf, so no entry id.
		expect(forkedFrom).toEqual({ kind: "fork", sourceAgentId: "agent-1" });
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
		const sendMessage = vi.fn(async () => ({ kind: "accepted" as const }));
		const commandContext = context({
			getAgentActivity: () => ({ activity: "running", maintenance: "compaction" }),
			abortAgent,
			sendMessage,
		});

		for (const input of ["/abort", "/follow-up later", "/steer now"]) {
			const outcome = await engine.handleInput(input, commandContext);
			expect(outcome).toMatchObject({ kind: "failed", error: { message: expect.stringContaining("compaction") } });
		}
		expect(abortAgent).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("routes /steer through the human interrupt message path", async () => {
		let message: unknown;
		const outcome = await engine.handleInput(
			"/steer go now",
			context({
				getAgentActivity: () => ({ activity: "running" }),
				sendMessage: async (draft: unknown, binding: unknown) => {
					message = { draft, binding };
					return { kind: "accepted" as const };
				},
			}),
		);

		expect(outcome).toMatchObject({ kind: "executed", name: "steer" });
		// The request names only what it wants said; the sink's binding is what
		// makes it count as the human interrupting.
		expect(message).toEqual({
			draft: { targetAgentId: "agent-1", body: "go now", mode: "interrupt" },
			binding: expect.objectContaining({
				source: { kind: "human" },
				policy: expect.objectContaining({ humanInterrupt: true }),
			}),
		});
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
				listAgentSessions: async () => ({
					sessions: [{ id: "session-1", ref: "session-1", createdAt: "2026-01-01T00:00:00.000Z", cwd: "/workspace" }],
				}),
				spawnAgent: async () => "agent-2",
				inspectAgent: () => ({
					agentId: "agent-2",
					profile: { reference: { id: "default", label: "Default" } },
					model: { id: "test-model" },
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

describe("CommandEngine argument resolution", () => {
	function picker(received: string[], overrides: Partial<ActionCommand> = {}): CommandDefinition {
		return {
			kind: "action",
			agentPolicy: "runtime",
			name: "pick",
			description: "Pick a value.",
			argumentHint: "<value>",
			requiresArgument: true,
			complete: async () => [{ value: "alpha-one" }, { value: "alpha-two" }, { value: "beta" }],
			execute: async (_context, argument) => {
				received.push(argument);
				return argument;
			},
			...overrides,
		};
	}

	it("snaps an exact match to the canonical candidate value", async () => {
		const received: string[] = [];
		const engine = new CommandEngine([picker(received)]);

		const outcome = await engine.handleInput("/pick ALPHA-ONE", pendingContext());

		expect(outcome.kind).toBe("executed");
		expect(received).toEqual(["alpha-one"]);
	});

	it("snaps a unique prefix to its candidate", async () => {
		const received: string[] = [];
		const engine = new CommandEngine([picker(received)]);

		const outcome = await engine.handleInput("/pick alpha-t", pendingContext());

		expect(outcome.kind).toBe("executed");
		expect(received).toEqual(["alpha-two"]);
	});

	it("opens the selector with the query on an ambiguous prefix", async () => {
		const received: string[] = [];
		const engine = new CommandEngine([picker(received)]);

		const outcome = await engine.handleInput("/pick alpha", pendingContext());

		expect(outcome).toMatchObject({ kind: "open-selector", query: "alpha" });
		if (outcome.kind === "open-selector") {
			expect(outcome.command.name).toBe("pick");
			expect(outcome.candidates).toHaveLength(3);
		}
		expect(received).toEqual([]);
	});

	it("opens the selector with the query on no match", async () => {
		const received: string[] = [];
		const engine = new CommandEngine([picker(received)]);

		const outcome = await engine.handleInput("/pick zzz", pendingContext());

		expect(outcome).toMatchObject({ kind: "open-selector", query: "zzz" });
		expect(received).toEqual([]);
	});

	it("passes the raw argument through when there are no candidates", async () => {
		const received: string[] = [];
		const engine = new CommandEngine([picker(received, { complete: async () => [] })]);

		const outcome = await engine.handleInput("/pick anything", pendingContext());

		expect(outcome.kind).toBe("executed");
		expect(received).toEqual(["anything"]);
	});

	it("prefers the command's own resolveArgument over the generic matching", async () => {
		const received: string[] = [];
		const engine = new CommandEngine([
			picker(received, { resolveArgument: () => ({ kind: "resolved", value: "custom" }) }),
		]);

		const outcome = await engine.handleInput("/pick whatever", pendingContext());

		expect(outcome.kind).toBe("executed");
		expect(received).toEqual(["custom"]);
	});

	it("does not resolve prompt command arguments", async () => {
		const engine = new CommandEngine([
			{
				kind: "prompt",
				agentPolicy: "runtime",
				name: "echo",
				description: "Echo the argument.",
				argumentHint: "<text>",
				requiresArgument: true,
				complete: async () => [{ value: "alpha-one" }],
				expand: async (_context, argument) => argument,
			},
		]);

		// "alpha" prefixes the sole candidate, but a prompt argument is free
		// text: it reaches expand exactly as typed.
		const outcome = await engine.handleInput("/echo alpha", pendingContext());

		expect(outcome).toEqual({ kind: "expanded", text: "alpha" });
	});

	it("resolves a unique model prefix to the full reference", async () => {
		const setAgentModelByReference = vi.fn(async () => ({ provider: "vllm", id: "hello-world" }));
		const engine = new CommandEngine(builtInCommands);

		const outcome = await engine.handleInput(
			"/model vllm/hello",
			context({
				listAvailableModelCandidates: async () => ({
					models: [{ value: "vllm/hello-world" }, { value: "openai/gpt-5" }],
				}),
				setAgentModelByReference,
			}),
		);

		expect(outcome).toMatchObject({ kind: "executed", name: "model" });
		expect(setAgentModelByReference).toHaveBeenCalledWith("agent-1", "vllm/hello-world");
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

describe("CommandEngine runtime registration", () => {
	function actionCommand(name: string): CommandDefinition {
		return {
			kind: "action",
			name,
			description: `${name} command`,
			agentPolicy: "runtime",
			execute: async () => `ran ${name}`,
		};
	}

	it("registers and unregisters a command at runtime", async () => {
		const engine = new CommandEngine();
		expect(engine.list(undefined)).toEqual([]);

		expect(engine.register(actionCommand("deploy"))).toBeUndefined();
		expect(engine.match("/deploy now")?.name).toBe("deploy");
		const outcome = await engine.handleInput("/deploy now", pendingContext());
		expect(outcome).toMatchObject({ kind: "executed", name: "deploy", value: "ran deploy" });

		expect(engine.unregister("deploy")).toBe(true);
		expect(engine.match("/deploy now")).toBeUndefined();
		expect(engine.unregister("deploy")).toBe(false);
	});

	it("refuses a conflicting name and keeps the original", () => {
		const engine = new CommandEngine();
		const original = actionCommand("deploy");
		engine.register(original);

		const diagnostic = engine.register(actionCommand("deploy"));

		expect(diagnostic).toMatchObject({ severity: "warning", code: "command.name_conflict" });
		expect(engine.get("deploy")).toBe(original);
	});

	it("list() snapshots reflect runtime registration changes", () => {
		const engine = new CommandEngine();
		engine.register(actionCommand("alpha"));
		engine.register(actionCommand("beta"));
		expect(engine.list(undefined).map((view) => view.name)).toEqual(["alpha", "beta"]);

		engine.unregister("alpha");
		expect(engine.list(undefined).map((view) => view.name)).toEqual(["beta"]);
	});
});
