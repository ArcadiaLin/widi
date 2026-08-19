#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { parseCliArgs } from "./cli/args.ts";
import { formatHelp, readVersion } from "./cli/help.ts";
import { OrchestratorError } from "./core/diagnostics.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { runWidiPrint } from "./print/index.ts";
import { runWidiRpc } from "./rpc/index.ts";
import { runWidiTui } from "./tui/application.ts";

function usageError(message: string): void {
	process.stderr.write(`widi: ${message}\nTry 'widi --help'.\n`);
	process.exitCode = 1;
}

async function main(): Promise<void> {
	const parsed = parseCliArgs(process.argv.slice(2), {
		cwd: process.cwd(),
		stdinIsTty: process.stdin.isTTY === true,
		stdoutIsTty: process.stdout.isTTY === true,
	});
	if (parsed.kind === "usage-error") {
		usageError(parsed.message);
		return;
	}
	if (parsed.kind === "help") {
		process.stdout.write(formatHelp());
		return;
	}
	if (parsed.kind === "version") {
		process.stdout.write(`${readVersion()}\n`);
		return;
	}

	// Checked here rather than inside the runtime, where a missing directory
	// resurfaces as whatever the first loader to touch it makes of it.
	const { cwd } = parsed.invocation.options;
	const info = await stat(cwd).catch(() => undefined);
	if (!info?.isDirectory()) {
		usageError(`--cwd is not a directory: ${cwd}`);
		return;
	}

	// From the environment alone, before anything can issue a request. The
	// runtime configures it a second time once settings are loaded and may name
	// their own proxy or idle timeout.
	configureHttpDispatcher();

	switch (parsed.invocation.mode) {
		case "rpc":
			await runWidiRpc(parsed.invocation.options);
			return;
		case "print":
			process.exitCode = await runWidiPrint(parsed.invocation.options);
			return;
		case "tui":
			await runWidiTui(parsed.invocation.options);
			return;
	}
}

// Errors go to stderr in every mode, which stays true in RPC: the protocol owns
// stdout and everything else is pushed to stderr by the takeover. An
// OrchestratorError is a stated refusal rather than a crash - a model nobody
// authenticated, a profile that does not resolve - so it says so and stops
// there; a stack would only bury the sentence the user needs to read.
main().catch((error) => {
	if (error instanceof OrchestratorError) {
		process.stderr.write(`widi: ${error.message}\n`);
	} else {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	}
	process.exitCode = 1;
});
