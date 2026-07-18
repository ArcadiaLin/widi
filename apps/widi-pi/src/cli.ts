#!/usr/bin/env node
import { runWidiTui } from "./tui/application.ts";

interface EntryOptions {
	cwd: string;
	agentDir?: string;
	profileId?: string;
}

function parseArgs(argv: string[]): EntryOptions {
	const options: EntryOptions = { cwd: process.cwd() };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		switch (argument) {
			case "--cwd":
				options.cwd = requireValue(argv, ++index, argument);
				break;
			case "--agent-dir":
				options.agentDir = requireValue(argv, ++index, argument);
				break;
			case "--profile":
				options.profileId = requireValue(argv, ++index, argument);
				break;
			default:
				throw new Error(`Unknown argument: ${argument}`);
		}
	}
	return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
	const value = argv[index];
	if (value === undefined) throw new Error(`Missing value for ${flag}`);
	return value;
}

runWidiTui(parseArgs(process.argv.slice(2))).catch((error) => {
	process.stderr.write(
		`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
	);
	process.exitCode = 1;
});
