/**
 * Print mode entry: core's third front end, beside the TUI and RPC.
 *
 * Everything process-shaped lives here and nothing else does - stdout, stdin,
 * signals, the runtime's construction and its disposal - so that `session.ts`
 * describes a run and can be driven by a test without a terminal.
 *
 * The stdout takeover is not a json-mode detail. An extension's `console.log`
 * would split a JSONL frame in half, and in text mode it would land in the
 * middle of the answer a caller redirected to a file; both modes promise that
 * stdout carries the run and nothing else, so both take it over and push
 * everything else to stderr.
 *
 * Only the core halves of extensions load here, exactly as under RPC. That is
 * the dual-entry contract rather than a degradation: a `tui` half has nothing to
 * do in a process with no terminal.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_DIR } from "../core/constants.ts";
import { createWidiRuntime } from "../core/runtime-service.ts";
import { ProtocolStdout, takeOverStdout } from "../rpc/stdout-guard.ts";
import { resolvePrintPrompts } from "./input.ts";
import { PrintJsonOutput, type PrintOutput } from "./output.ts";
import { PrintTextOutput } from "./projector.ts";
import { runPrintSession } from "./session.ts";
import type { PrintExitCode, WidiPrintOptions } from "./types.ts";

export async function runWidiPrint(options: WidiPrintOptions): Promise<PrintExitCode> {
	const takeover = takeOverStdout();
	if (!takeover) {
		throw new Error("Print mode needs sole ownership of stdout, and something already took it.");
	}
	const { rawWrite, restore: restoreStdout } = takeover;
	const note = (text: string): void => {
		process.stderr.write(text);
	};

	const stdout = new ProtocolStdout({
		write: rawWrite,
		onFailure: (error) => {
			note(`widi print: stdout failed: ${error.message}\n`);
		},
	});
	const output: PrintOutput =
		options.output === "json" ? new PrintJsonOutput(stdout) : new PrintTextOutput({ writer: stdout, note });

	// Aborting rather than dying on a signal: an interrupted run still owes the
	// caller its report and its totals, and those are what a batch driver keeps.
	const interrupted = new AbortController();
	const onSignal = (signal: NodeJS.Signals) => (): void => {
		interrupted.abort(new Error(`Interrupted by ${signal}.`));
	};
	const handlers = (["SIGINT", "SIGTERM"] as const).map((signal) => {
		const handler = onSignal(signal);
		process.on(signal, handler);
		return { signal, handler };
	});

	try {
		const prompts = await resolvePrintPrompts({
			cwd: options.cwd,
			prompts: options.prompts,
			...(options.fileArgs === undefined ? undefined : { fileArgs: options.fileArgs }),
			...(process.stdin.isTTY ? undefined : { stdin: await readPipedStdin() }),
		});

		// `--model` goes in as a reference the runtime resolves for itself. The
		// orchestrator's own `setDefaultModel` would be the shorter path and is the
		// wrong one: it writes the resolved model back to settings.json, so a flag
		// meant to last one run would silently rewrite the default every later run
		// starts from. A benchmark sweeping models must not edit the config it is
		// measuring against.
		const runtime = await createWidiRuntime({
			cwd: options.cwd,
			agentDir: options.agentDir ?? join(homedir(), DEFAULT_AGENT_DIR),
			...(options.profileId === undefined ? undefined : { defaultProfileId: options.profileId }),
			...(options.enabledProfileIds === undefined ? undefined : { enabledProfileIds: options.enabledProfileIds }),
			...(options.model === undefined ? undefined : { defaultModelReference: options.model }),
			...(options.thinkingLevel === undefined ? undefined : { defaultThinkingLevel: options.thinkingLevel }),
			...(options.sessionRoot === undefined ? undefined : { sessionRoot: options.sessionRoot }),
			...(options.trustOverride === undefined ? undefined : { trustOverride: options.trustOverride }),
			...(options.noExtensions === undefined ? undefined : { noExtensions: options.noExtensions }),
			...(options.extensionPaths === undefined ? undefined : { extensionPaths: options.extensionPaths }),
		});
		const orchestrator = runtime.orchestrator;

		try {
			return await runPrintSession(
				{
					orchestrator,
					cwd: runtime.services.cwd,
					agentDir: runtime.services.agentDir,
					diagnostics: runtime.diagnostics,
				},
				{
					prompts,
					...(options.emit === undefined ? undefined : { emit: options.emit }),
					...(options.images === undefined ? undefined : { images: options.images }),
					...(options.deadlineMs === undefined ? undefined : { deadlineMs: options.deadlineMs }),
					...(options.quietMs === undefined ? undefined : { quietMs: options.quietMs }),
					signal: interrupted.signal,
				},
				output,
			);
		} finally {
			await orchestrator.disposeAll("print run finished");
		}
	} finally {
		for (const { signal, handler } of handlers) process.off(signal, handler);
		// Frames already handed over still belong to the consumer.
		await stdout.drain();
		restoreStdout();
	}
}

/**
 * Piped input, read to end of stream. Only when stdin is not a terminal: a
 * terminal never ends, so reading one would hang a run that never asked for it.
 */
async function readPipedStdin(): Promise<string> {
	process.stdin.setEncoding("utf8");
	let text = "";
	for await (const chunk of process.stdin) text += chunk;
	return text;
}

export { PRINT_PROTOCOL_VERSION, type PrintFrame, type PrintRunStatus, printExitCode } from "./frames.ts";
export { resolvePrintPrompts } from "./input.ts";
export { PrintJsonOutput, type PrintOutput, type PrintWriter } from "./output.ts";
export { PrintTextOutput } from "./projector.ts";
export {
	DEFAULT_PRINT_QUIET_MS,
	type PrintRuntimeFacts,
	type PrintSessionOptions,
	runPrintSession,
} from "./session.ts";
export * from "./types.ts";
