/**
 * Resuming a stored session as a print run's root.
 *
 * What these pin is the boundary print owns, not the resume itself: which
 * session a reference reaches, what the `ready` frame says about it, and that a
 * run leaves the session exactly as resumable as it found it. The orchestrator's
 * own resume - profile from metadata, model from context, id reuse - is covered
 * in `tests/core/agent-orchestrator.test.ts` and is deliberately not restated.
 *
 * The spawn is real here, unlike in `session.test.ts`: it is the thing under
 * test. The model loop is stubbed the moment the root exists instead.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import {
	type AgentProfile,
	AgentProfileRegistry,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
import { PersistenceRegistry } from "../../src/core/persistence/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { PrintFrame, PrintReadyFrame } from "../../src/print/frames.ts";
import type { PrintOutput } from "../../src/print/output.ts";
import { type PrintRuntimeFacts, runPrintSession } from "../../src/print/session.ts";
import {
	createOrchestrator,
	defaultModel,
	MemoryExecutionEnv,
	requireAgentHarness,
	restoredProfile,
} from "../helpers/orchestrator.ts";

const TEST_TIMEOUT_MS = 15_000;
const WORKSPACE = "/workspace/project";

class RecordingOutput implements PrintOutput {
	readonly frames: PrintFrame[] = [];

	emit(frame: PrintFrame): void {
		this.frames.push(frame);
	}

	async drain(): Promise<void> {}
}

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "turn" }],
		api: defaultModel.api,
		provider: defaultModel.provider,
		model: defaultModel.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	} as AssistantMessage;
}

function facts(orchestrator: AgentOrchestrator, cwd: string = WORKSPACE): PrintRuntimeFacts {
	return { orchestrator, cwd, agentDir: "/agent", diagnostics: [] };
}

/**
 * A model loop for whichever root the run spawns, installed as soon as it
 * exists. The other print tests stub the harness before the run and hand the
 * session a ready-made agent; that would replace the very call under test here.
 */
function stubSpawnedTurns(orchestrator: AgentOrchestrator): void {
	const spawnAgent = orchestrator.spawnAgent.bind(orchestrator);
	vi.spyOn(orchestrator, "spawnAgent").mockImplementation(async (options) => {
		const agentId = await spawnAgent(options);
		const harness = requireAgentHarness(orchestrator, agentId);
		const setPhase = (harness as unknown as { setPhase: (next: string) => Promise<void> }).setPhase.bind(harness);
		vi.spyOn(harness, "prompt").mockImplementation(async () => {
			await setPhase("turn");
			await setPhase("idle");
			return assistantMessage();
		});
		return agentId;
	});
}

/**
 * A session an earlier run left behind, written through a SessionManager of its
 * own so nothing about it is cached in the orchestrator that resumes it.
 */
async function writeEarlierSession(
	env: MemoryExecutionEnv,
	agentId: string,
	body: string,
): Promise<{ readonly ref: string; readonly leafId: string | null }> {
	const sessions = new SessionManager({
		fs: env,
		cwd: WORKSPACE,
		sessionsRoot: "/sessions",
		registry: new PersistenceRegistry(),
	});
	const session = await sessions.createAgentSession({ agentId, agentProfile: restoredProfile });
	await session.appendMessage({ role: "user", content: body, timestamp: 1 });
	const ref = sessions.getAgentSessionRef(agentId);
	if (ref === undefined) throw new Error(`Expected a persisted session for ${agentId}.`);
	return { ref, leafId: await session.getLeafId() };
}

function readyFrame(output: RecordingOutput): PrintReadyFrame {
	const ready = output.frames[0];
	if (ready?.type !== "ready") throw new Error("no ready frame");
	return ready;
}

async function runResume(
	orchestrator: AgentOrchestrator,
	options: { readonly resume?: string; readonly cwd?: string } = {},
): Promise<RecordingOutput & { readonly exitCode: number }> {
	stubSpawnedTurns(orchestrator);
	const output = new RecordingOutput();
	const exitCode = await runPrintSession(
		facts(orchestrator, options.cwd ?? WORKSPACE),
		{ prompts: ["carry on"], quietMs: 5, ...(options.resume === undefined ? undefined : { resume: options.resume }) },
		output,
	);
	return Object.assign(output, { exitCode });
}

describe("print mode --resume", () => {
	it(
		"reopens the session a reference names, on the branch the earlier run left",
		async () => {
			const env = new MemoryExecutionEnv();
			const earlier = await writeEarlierSession(env, "worker-agent", "what the first run said");
			const orchestrator = await createOrchestrator(env);

			const output = await runResume(orchestrator, { resume: earlier.ref });

			expect(output.exitCode).toBe(0);
			expect(readyFrame(output)).toMatchObject({
				origin: "resume",
				rootAgentId: "worker-agent",
				sessionRef: earlier.ref,
				cwd: WORKSPACE,
			});
			const snapshot = await orchestrator.sessionManager.getAgentSessionSnapshot("worker-agent");
			expect(snapshot.leafId).toBe(earlier.leafId);
			// The branch the resumed root would send, not just the file it opened.
			const context = await orchestrator.sessionManager.buildAgentSessionContext("worker-agent");
			expect(JSON.stringify(context.messages)).toContain("what the first run said");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"names the session a new root just created, which is what a later resume needs",
		async () => {
			const env = new MemoryExecutionEnv();
			const first = await createOrchestrator(env);

			const created = await runResume(first);
			const ready = readyFrame(created);
			expect(ready.origin).toBe("new");
			expect(ready.sessionRef).toBeDefined();
			await first.disposeAll("print run finished");

			// The run before it is gone, session and all - except it is not, which is
			// the whole point of scoring a benchmark across several print processes.
			const second = await createOrchestrator(env);
			const resumed = await runResume(second, { resume: ready.sessionRef });

			expect(resumed.exitCode).toBe(0);
			expect(readyFrame(resumed)).toMatchObject({
				origin: "resume",
				rootAgentId: ready.rootAgentId,
				sessionRef: ready.sessionRef,
			});
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"leaves the session resumable again once the resumed run is over",
		async () => {
			const env = new MemoryExecutionEnv();
			const earlier = await writeEarlierSession(env, "worker-agent", "still here");
			const first = await createOrchestrator(env);
			await runResume(first, { resume: earlier.ref });
			await first.disposeAll("print run finished");

			const second = await createOrchestrator(env);
			const output = await runResume(second, { resume: earlier.ref });

			expect(output.exitCode).toBe(0);
			expect(readyFrame(output)).toMatchObject({ origin: "resume", sessionRef: earlier.ref });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"fails the run when the reference names no session here",
		async () => {
			const orchestrator = await createOrchestrator(new MemoryExecutionEnv());

			const output = await runResume(orchestrator, { resume: "no-such-session" });

			expect(output.exitCode).toBe(1);
			expect(readyFrame(output).rootAgentId).toBeUndefined();
			const summary = output.frames.at(-1);
			if (summary?.type !== "run_summary") throw new Error("no summary frame");
			expect(summary.status).toBe("failed");
			expect(summary.error).toContain("no-such-session");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"refuses a session that belongs to another workspace, and says which one it looked in",
		async () => {
			const env = new MemoryExecutionEnv();
			const earlier = await writeEarlierSession(env, "worker-agent", "written elsewhere");
			const orchestrator = await createOrchestrator(env);

			const output = await runResume(orchestrator, { resume: earlier.ref, cwd: "/workspace/other" });

			expect(output.exitCode).toBe(1);
			const summary = output.frames.at(-1);
			if (summary?.type !== "run_summary") throw new Error("no summary frame");
			expect(summary.error).toContain("/workspace/other");
			expect(summary.error).toContain("the directory it was written in");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"gives an ephemeral root no session reference, so there is nothing to resume",
		async () => {
			const ephemeral: AgentProfile = {
				id: "scratch",
				label: "Scratch Agent",
				systemPrompt: "scratch prompt",
				persist: false,
			};
			const orchestrator = await createOrchestrator(new MemoryExecutionEnv(), {
				profileRegistry: new AgentProfileRegistry(InMemoryProfileStorageBackend.fromProfiles([{ profile: ephemeral }])),
				defaultProfileId: ephemeral.id,
			});

			const output = await runResume(orchestrator);

			expect(output.exitCode).toBe(0);
			const ready = readyFrame(output);
			expect(ready.origin).toBe("new");
			expect(ready.sessionRef).toBeUndefined();
		},
		TEST_TIMEOUT_MS,
	);
});
