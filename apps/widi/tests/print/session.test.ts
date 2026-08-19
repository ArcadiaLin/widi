/**
 * The print run itself, driven against a real orchestrator with a stubbed model
 * loop.
 *
 * The claims worth pinning are all about order and about endings, because that
 * is the whole of what print adds to the RPC machinery it reuses: `ready` is
 * first, the report and the totals are the last two frames, the run that hit its
 * deadline still writes both, and a run that carries no prompt at all is a run.
 *
 * `spawnAgent` is stubbed to hand back an agent the test spawned itself. That is
 * not a shortcut around the session - it is the only way to hold the harness
 * before the session prompts it, and it reproduces the real ordering exactly:
 * the root exists before the client registers, so its `agent_spawned` is not on
 * the stream either way.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { WidiAgentHarness } from "../../src/core/agent-types.ts";
import type { CoreDiagnostic } from "../../src/core/diagnostics.ts";
import type { PrintFrame } from "../../src/print/frames.ts";
import { PrintJsonOutput, type PrintOutput, type PrintWriter } from "../../src/print/output.ts";
import { type PrintRuntimeFacts, runPrintSession } from "../../src/print/session.ts";
import {
	createOrchestrator,
	defaultModel,
	harnessEventDriver,
	harnessInputText,
	MemoryExecutionEnv,
	requireAgentHarness,
	stubPromptRun,
} from "../helpers/orchestrator.ts";

const TEST_TIMEOUT_MS = 15_000;

class RecordingOutput implements PrintOutput {
	readonly frames: PrintFrame[] = [];

	emit(frame: PrintFrame): void {
		this.frames.push(frame);
	}

	async drain(): Promise<void> {}
}

class MemoryWriter implements PrintWriter {
	text = "";

	write(chunk: string): void {
		this.text += chunk;
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
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	} as AssistantMessage;
}

/**
 * A model loop that answers immediately, recording what it was asked. The phase
 * moves the way a real run's does, because the orchestrator reads activity from
 * the phase and a mock that only returned a promise would leave the agent
 * looking idle mid-turn.
 */
function stubTurns(harness: WidiAgentHarness): string[] {
	const asked: string[] = [];
	const setPhase = (harness as unknown as { setPhase: (next: string) => Promise<void> }).setPhase.bind(harness);
	vi.spyOn(harness, "prompt").mockImplementation(async (input: unknown) => {
		asked.push(harnessInputText(input));
		await setPhase("turn");
		await setPhase("idle");
		return assistantMessage();
	});
	return asked;
}

async function createFixture(
	options: {
		readonly activate?: (orchestrator: AgentOrchestrator) => void;
		readonly diagnostics?: CoreDiagnostic[];
	} = {},
): Promise<{
	readonly orchestrator: AgentOrchestrator;
	readonly agentId: string;
	readonly harness: WidiAgentHarness;
	readonly facts: PrintRuntimeFacts;
}> {
	const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
	options.activate?.(orchestrator);
	const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
	vi.spyOn(orchestrator, "spawnAgent").mockResolvedValue(agentId);
	return {
		orchestrator,
		agentId,
		harness: requireAgentHarness(orchestrator, agentId),
		facts: { orchestrator, cwd: "/workspace/project", agentDir: "/agent", diagnostics: options.diagnostics ?? [] },
	};
}

function lastTwo(frames: readonly PrintFrame[]): readonly PrintFrame[] {
	return frames.slice(-2);
}

describe("runPrintSession", () => {
	it(
		"delivers one prompt and ends with the root's report and the run's totals",
		async () => {
			const fixture = await createFixture();
			const run = stubPromptRun(fixture.harness);
			vi.spyOn(fixture.orchestrator, "readAgentReport").mockResolvedValue("THE ANSWER");
			const output = new RecordingOutput();

			const session = runPrintSession(fixture.facts, { prompts: ["do it"], quietMs: 5 }, output);
			await vi.waitFor(() => expect(run.prompt).toHaveBeenCalledTimes(1));
			// The totals come off the event stream, not off the prompt's answer, so a
			// stub that only resolves proves nothing about the accounting.
			const message = assistantMessage();
			await harnessEventDriver(fixture.orchestrator)(fixture.agentId, { type: "message_end", message });
			run.resolve(message);

			expect(await session).toBe(0);
			expect(output.frames[0]).toMatchObject({
				type: "ready",
				rootAgentId: fixture.agentId,
				cwd: "/workspace/project",
			});
			const [report, summary] = lastTwo(output.frames);
			expect(report).toEqual({ type: "report", agentId: fixture.agentId, report: "THE ANSWER" });
			expect(summary).toMatchObject({ type: "run_summary", status: "ok", exitCode: 0 });
			if (summary?.type !== "run_summary") throw new Error("no summary frame");
			expect(summary.summary.total.turnUsage.totalTokens).toBe(15);
			expect(summary.error).toBeUndefined();
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"writes json as one valid object per line, ending on report and run_summary",
		async () => {
			const fixture = await createFixture();
			stubTurns(fixture.harness);
			const writer = new MemoryWriter();

			expect(
				await runPrintSession(fixture.facts, { prompts: ["say hi"], quietMs: 5 }, new PrintJsonOutput(writer)),
			).toBe(0);

			const lines = writer.text.split("\n").filter((line) => line !== "");
			expect(lines.length).toBeGreaterThan(2);
			const frames = lines.map((line) => JSON.parse(line) as PrintFrame);
			expect(frames[0]?.type).toBe("ready");
			expect(frames.at(-2)?.type).toBe("report");
			expect(frames.at(-1)?.type).toBe("run_summary");
			// Nothing after the summary, which is what lets a driver stop reading
			// there rather than waiting on the process.
			expect(frames.filter((frame) => frame.type === "run_summary").length).toBe(1);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"emits the driver's bus events and carries the extension's answer back, with no prompt at all",
		async () => {
			const fixture = await createFixture({
				activate: (orchestrator) => {
					orchestrator.registerExtension("echo", (api) => {
						api.onExtensionEvent("driver:run", async (event, context) => {
							await context.actions.emitExtensionEvent("echo:done", { saw: event.payload ?? null });
						});
					});
				},
			});
			const output = new RecordingOutput();

			const exitCode = await runPrintSession(
				fixture.facts,
				{ prompts: [], emit: [{ name: "driver:run", payload: { sample: 7 } }], quietMs: 5 },
				output,
			);

			expect(exitCode).toBe(0);
			const extensionEvents = output.frames.filter((frame) => frame.type === "extension_event");
			// Both directions on one stream: what the driver sent, attributed to the
			// root agent, and what the extension answered. Order is core's - runners
			// are served before non-runner subscribers, so the answer to a nested emit
			// reaches this stream before the event that provoked it.
			expect(extensionEvents.map((frame) => frame.event.name).sort()).toEqual(["driver:run", "echo:done"]);
			expect(extensionEvents.find((frame) => frame.event.name === "driver:run")?.event).toMatchObject({
				sourceExtensionId: "print",
				sourceAgentId: fixture.agentId,
				payload: { sample: 7 },
			});
			expect(lastTwo(output.frames).map((frame) => frame.type)).toEqual(["report", "run_summary"]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"delivers several prompts in order, each after the one before it finished",
		async () => {
			const fixture = await createFixture();
			const asked = stubTurns(fixture.harness);
			const output = new RecordingOutput();

			expect(await runPrintSession(fixture.facts, { prompts: ["first", "second", "third"], quietMs: 5 }, output)).toBe(
				0,
			);

			expect(asked).toEqual(["first", "second", "third"]);
			// Nothing said it, so nothing is reported: the field is absent rather
			// than an empty string a driver would have to special-case.
			expect(lastTwo(output.frames)[0]).toEqual({ type: "report", agentId: fixture.agentId });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"still writes the report and the totals for a run that hit its deadline",
		async () => {
			const fixture = await createFixture();
			const run = stubPromptRun(fixture.harness);
			const output = new RecordingOutput();

			const session = runPrintSession(fixture.facts, { prompts: ["hang"], deadlineMs: 50, quietMs: 5 }, output);
			await vi.waitFor(() => expect(run.prompt).toHaveBeenCalledTimes(1));
			// The agent stops after the abort the deadline sends it, which is what a
			// real one does; the session waits for that before it reports.
			setTimeout(() => run.resolve(assistantMessage()), 200);

			expect(await session).toBe(2);
			const [report, summary] = lastTwo(output.frames);
			expect(report?.type).toBe("report");
			if (summary?.type !== "run_summary") throw new Error("no summary frame");
			expect(summary.status).toBe("deadline_exceeded");
			expect(summary.exitCode).toBe(2);
			expect(summary.error).toContain("50ms deadline");
			// The point of reporting a timed-out run at all: the numbers are real.
			expect(summary.summary.durationMs).toBeGreaterThan(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"refuses a run with neither a prompt nor an event, and says so in the summary",
		async () => {
			const fixture = await createFixture();
			const output = new RecordingOutput();

			expect(await runPrintSession(fixture.facts, { prompts: [] }, output)).toBe(1);

			expect(output.frames[0]?.type).toBe("ready");
			const summary = output.frames.at(-1);
			if (summary?.type !== "run_summary") throw new Error("no summary frame");
			expect(summary.status).toBe("failed");
			expect(summary.error).toContain("at least one prompt");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"will not run at all when startup reported an error, and still says why on the stream",
		async () => {
			const fixture = await createFixture({
				diagnostics: [{ severity: "error", code: "extension.load_failed", message: "boom" }],
			});
			const run = stubPromptRun(fixture.harness);
			const output = new RecordingOutput();

			expect(await runPrintSession(fixture.facts, { prompts: ["do it"] }, output)).toBe(1);

			expect(run.prompt).not.toHaveBeenCalled();
			const ready = output.frames[0];
			if (ready?.type !== "ready") throw new Error("no ready frame");
			expect(ready.rootAgentId).toBeUndefined();
			expect(ready.diagnostics).toEqual([{ severity: "error", code: "extension.load_failed", message: "boom" }]);
			const summary = output.frames.at(-1);
			if (summary?.type !== "run_summary") throw new Error("no summary frame");
			expect(summary.status).toBe("failed");
			expect(summary.error).toContain("extension.load_failed");
		},
		TEST_TIMEOUT_MS,
	);
});
