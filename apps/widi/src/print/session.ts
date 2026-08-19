/**
 * One print run, from an empty root agent to the two frames a driver scores.
 *
 * It is an RPC client written as a script. The registration is the same, the
 * wire projection is the same, the accounting is the same object - what differs
 * is that nothing here is waiting to be told what to do, so the order is fixed:
 * emit whatever bus events the driver brought, deliver the prompts one at a
 * time, then wait.
 *
 * Three decisions are worth knowing before changing anything here.
 *
 * **The end condition is the whole agent tree, not the root.** A prompt resolves
 * when the root's own run ends, and a root that delegated ends its run to wait
 * for the subagent it delegated to. Scoring there cuts the run in half - and
 * only sometimes, because a subagent that happens to finish first folds its
 * report into the root's run and the same driver looks correct.
 *
 * **No human request handler is registered, on purpose.** Nobody is at the
 * terminal. The broker's answer to an unhandled request is to fail it at once
 * with a diagnostic, which is what an unattended run wants; a handler that
 * stalled instead would turn one `ask` into the whole run's wall clock. This is
 * also why project trust has to arrive as `trustOverride` rather than as an
 * answered prompt.
 *
 * **The deadline still produces both terminal frames.** A timed-out sample is
 * the one whose numbers a benchmark most needs, so the deadline aborts the tree
 * and then reports, rather than tearing the process down where it stood.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentOrchestrator } from "../core/agent-orchestrator.ts";
import type { OrchestratorClient } from "../core/client.ts";
import type { CoreDiagnostic } from "../core/diagnostics.ts";
import { type MessageSink, messageBindingFor } from "../core/message.ts";
import type { AgentId, OrchestratorEvent, PromptOutcome } from "../core/types.ts";
import { RunAccounting } from "../rpc/run-summary.ts";
import { toWireEvent } from "../rpc/wire-event.ts";
import { formatError } from "../utils/errors.ts";
import { PRINT_PROTOCOL_VERSION, type PrintRunStatus, printExitCode } from "./frames.ts";
import type { PrintOutput } from "./output.ts";
import { PRINT_EXTENSION_ID, type PrintExitCode, type PrintExtensionEmit } from "./types.ts";

/**
 * Longer than the orchestrator's own 250ms default, because a bus-driven run
 * settles differently: an extension handler that starts work returns before that
 * work has reached an agent, and a quiet window shorter than the handover
 * declares the tree finished before it began. A driver that knows what it
 * started can shorten this.
 */
export const DEFAULT_PRINT_QUIET_MS = 1_000;

/** What the run needs from a runtime. `WidiRuntime` supplies all of it. */
export interface PrintRuntimeFacts {
	readonly orchestrator: AgentOrchestrator;
	readonly cwd: string;
	readonly agentDir: string;
	readonly diagnostics: readonly CoreDiagnostic[];
}

export interface PrintSessionOptions {
	/** Already assembled: files and piped stdin are folded in by `input.ts`. */
	readonly prompts: readonly string[];
	readonly emit?: readonly PrintExtensionEmit[];
	readonly images?: readonly ImageContent[];
	readonly deadlineMs?: number;
	readonly quietMs?: number;
	/** Stops the run early. Ends it the same way a deadline does, minus the status. */
	readonly signal?: AbortSignal;
}

class PrintDeadlineError extends Error {
	constructor(deadlineMs: number) {
		super(`The run exceeded its ${deadlineMs}ms deadline.`);
		this.name = "PrintDeadlineError";
	}
}

export async function runPrintSession(
	runtime: PrintRuntimeFacts,
	options: PrintSessionOptions,
	output: PrintOutput,
): Promise<PrintExitCode> {
	const orchestrator = runtime.orchestrator;
	const emits = options.emit ?? [];
	const accounting = new RunAccounting();

	let rootAgentId: AgentId | undefined;
	let status: PrintRunStatus = "ok";
	let failure: string | undefined;

	// One controller for both ways a run can be cut short, so every await needs to
	// watch only one signal.
	const deadline = new AbortController();
	const deadlineMs = options.deadlineMs;
	const timer =
		deadlineMs === undefined
			? undefined
			: setTimeout(() => deadline.abort(new PrintDeadlineError(deadlineMs)), deadlineMs);
	const stop = options.signal;
	const onStop = (): void => deadline.abort(stop?.reason);
	if (stop?.aborted) deadline.abort(stop.reason);
	else stop?.addEventListener("abort", onStop, { once: true });

	const fail = (error: unknown): void => {
		status = error instanceof PrintDeadlineError ? "deadline_exceeded" : "failed";
		failure = formatError(error);
	};

	try {
		// The deadline covers startup too: a spawn that hangs waiting on a provider
		// is as dead a run as a prompt that does.
		try {
			if (options.prompts.length === 0 && emits.length === 0) {
				throw new Error("A print run needs at least one prompt or one extension event to emit.");
			}
			const fatal = runtime.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
			if (fatal.length > 0) {
				// Not a run worth scoring: an extension that failed to load is missing
				// from the sample, and a number produced without it measures something
				// nobody asked about. The diagnostics themselves ride out on `ready`.
				throw new Error(
					`Startup reported ${fatal.length} error diagnostic(s): ${fatal.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; ")}`,
				);
			}
			rootAgentId = await underSignal(orchestrator.spawnAgent({ origin: { kind: "new" } }), deadline.signal);
		} catch (error) {
			fail(error);
		}

		output.emit({
			type: "ready",
			protocolVersion: PRINT_PROTOCOL_VERSION,
			...(rootAgentId === undefined ? undefined : { rootAgentId }),
			cwd: runtime.cwd,
			agentDir: runtime.agentDir,
			diagnostics: runtime.diagnostics,
		});
		await output.drain();

		let report: string | undefined;
		if (rootAgentId !== undefined) {
			const agentId = rootAgentId;
			const client: OrchestratorClient<OrchestratorEvent> = {
				id: "print",
				receive: async (event) => {
					// Before the frame, so a summary can never omit an event the driver
					// has already been told about.
					accounting.record(event);
					output.emit({ type: "event", event: toWireEvent(event) });
					await output.drain();
				},
			};
			const unregisterClient = orchestrator.registerClient(client);
			// A bus subscriber beside the client, not under it: extension events are
			// not orchestrator events and never reach `receive`. An extension driven
			// over the bus reports its whole trace this way, so this is not optional
			// decoration - it is the only channel that carries what it did.
			const unsubscribeExtensionEvents = orchestrator.registerExtensionEventSubscriber({
				deliver: async (event) => {
					output.emit({ type: "extension_event", event });
					await output.drain();
				},
			});
			try {
				await drive(orchestrator, agentId, options, emits, deadline.signal);
			} catch (error) {
				fail(error);
				// Whatever cut the run short left agents running. Stop them, so the
				// report and the totals below describe one moment rather than a
				// tree that kept moving while they were read.
				if (deadline.signal.aborted) await abortTree(orchestrator, agentId);
			} finally {
				unregisterClient();
				unsubscribeExtensionEvents();
			}
			// After the client is gone: this is a session read, not an event, and a
			// driver that saw it as one would have two sources for the same text.
			try {
				report = await orchestrator.readAgentReport(agentId);
			} catch (error) {
				if (status === "ok") fail(error);
			}
		}

		output.emit({
			type: "report",
			...(rootAgentId === undefined ? undefined : { agentId: rootAgentId }),
			...(report === undefined ? undefined : { report }),
		});
		const exitCode = printExitCode(status);
		output.emit({
			type: "run_summary",
			status,
			exitCode,
			...(failure === undefined ? undefined : { error: failure }),
			summary: accounting.summarize(),
		});
		await output.drain();
		return exitCode;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		stop?.removeEventListener("abort", onStop);
	}
}

async function drive(
	orchestrator: AgentOrchestrator,
	agentId: AgentId,
	options: PrintSessionOptions,
	emits: readonly PrintExtensionEmit[],
	signal: AbortSignal,
): Promise<void> {
	for (const emit of emits) {
		await underSignal(
			orchestrator.emitExtensionEvent(agentId, emit.extensionId ?? PRINT_EXTENSION_ID, emit.name, emit.payload),
			signal,
		);
	}

	const sink = orchestrator.messageSinkFor(messageBindingFor({ kind: "human" }));
	for (const body of options.prompts) {
		// `prompt` refuses a busy target rather than queueing, and a bus event or the
		// prompt before this one may have left the root mid-run. Waiting is the
		// difference between a queued turn and a thrown one.
		await orchestrator.waitForAgentIdle(agentId, { signal });
		const outcome = await promptUnderSignal(orchestrator, sink, agentId, body, options.images, signal);
		if (outcome.kind === "blocked") {
			const reason = outcome.reason === undefined ? "" : `: ${outcome.reason}`;
			throw new Error(`Prompt blocked by extension '${outcome.blockedBy}'${reason}`);
		}
	}

	await orchestrator.waitForAgentTreeIdle(agentId, { quietMs: options.quietMs ?? DEFAULT_PRINT_QUIET_MS, signal });
}

/**
 * A prompt whose end is guaranteed before this returns, the way RPC's is: a
 * tripped signal aborts the agent and then awaits the run it aborted, so the
 * events of a timed-out run are already on the stream when the summary is
 * written. Abandoning it would leave a live model loop emitting into a run the
 * driver considers finished.
 */
async function promptUnderSignal(
	orchestrator: AgentOrchestrator,
	sink: MessageSink,
	agentId: AgentId,
	body: string,
	images: readonly ImageContent[] | undefined,
	signal: AbortSignal,
): Promise<PromptOutcome> {
	const run = sink.prompt({
		targetAgentId: agentId,
		body,
		mode: "next_turn",
		...(images === undefined ? undefined : { images }),
	});
	try {
		return await underSignal(run, signal);
	} catch (error) {
		if (!signal.aborted) throw error;
		// Both are best-effort: the agent may already be gone, and the run's own
		// failure is not what the deadline was about.
		await orchestrator.abortAgent(agentId, "human").catch(() => {});
		await run.catch(() => {});
		throw signal.reason;
	}
}

/**
 * Stop everything still running under the root so the report and the totals
 * describe one moment. Best effort by construction: an agent may already be
 * gone, and there is nothing useful to do about it if it is not.
 */
async function abortTree(orchestrator: AgentOrchestrator, agentId: AgentId): Promise<void> {
	let tree: readonly AgentId[];
	try {
		tree = orchestrator.listAgentSubtree(agentId);
	} catch {
		return;
	}
	for (const member of tree) await orchestrator.abortAgent(member, "human").catch(() => {});
}

async function underSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw signal.reason;
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}
