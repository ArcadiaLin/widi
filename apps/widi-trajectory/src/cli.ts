#!/usr/bin/env node
/**
 * The command.
 *
 * One session subtree in, one page out. The default target is the newest
 * session under the runs root of the current project, because that is the run
 * someone almost always means right after it finished.
 *
 * `--serve` rebuilds on every request rather than watching. A session file is
 * append-only and a refresh is a cheap, explicit way to ask for the current
 * state; a watcher would have to guess when a run is quiet versus finished.
 */

import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { discoverSession, findDefaultRoot, listRootSessions, resolveTarget } from "./load/discover.ts";
import { buildBundle } from "./model/bundle.ts";
import { DEFAULT_IMAGE_BUDGET } from "./model/content.ts";
import type { TrajectoryBundle } from "./model/types.ts";
import { loadViewerAssets } from "./render/assets.ts";
import { renderHtml } from "./render/html.ts";
import { serveTrajectory } from "./serve.ts";

/**
 * Where the user was standing when they typed the command.
 *
 * `npm run` sets INIT_CWD before changing directory, and `npm --workspace` does
 * change directory, so paths typed at the repo root would otherwise resolve
 * inside the workspace package.
 */
function fromInvocationCwd(path: string): string {
	return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

const USAGE = `widi-trajectory - turn a WIDI session tree into a self-contained trajectory page

Usage:
  widi-trajectory [target] [options]

Target:
  A session directory, a session.jsonl, a project directory under a runs root,
  or a runs root. Defaults to the newest session under ./.widi/runs, then
  ~/.widi/runs.

Options:
  -o, --out <file>       Write the page here (default: <session>-trajectory.html)
      --stdout           Write the page to stdout instead of a file
      --serve [port]     Serve the page instead of writing it (default port 4173)
      --list             List the sessions under the resolved runs root and exit
      --root <dir>       Runs root to resolve the target against
      --no-images        Leave recorded images out of the page
      --max-image-bytes <n>  Largest single inlined image (default 2097152)
  -h, --help             Show this help
`;

interface Options {
	target?: string;
	out?: string;
	stdout: boolean;
	serve?: number;
	list: boolean;
	root?: string;
	images: boolean;
	maxImageBytes: number;
}

function parseArgs(argv: readonly string[]): Options {
	const options: Options = { stdout: false, list: false, images: true, maxImageBytes: DEFAULT_IMAGE_BUDGET.maxBytes };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const next = (): string => {
			const value = argv[++index];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			return value;
		};
		if (arg === "-h" || arg === "--help") {
			process.stdout.write(USAGE);
			process.exit(0);
		} else if (arg === "-o" || arg === "--out") {
			options.out = next();
		} else if (arg === "--stdout") {
			options.stdout = true;
		} else if (arg === "--serve") {
			const peek = argv[index + 1];
			options.serve = peek !== undefined && /^\d+$/.test(peek) ? Number(argv[++index]) : 4173;
		} else if (arg === "--list") {
			options.list = true;
		} else if (arg === "--root") {
			options.root = next();
		} else if (arg === "--no-images") {
			options.images = false;
		} else if (arg === "--max-image-bytes") {
			options.maxImageBytes = Number(next());
		} else if (arg.startsWith("-")) {
			throw new Error(`Unknown option ${arg}`);
		} else if (options.target === undefined) {
			options.target = arg;
		} else {
			throw new Error(`Unexpected argument ${arg}`);
		}
	}
	return options;
}

async function resolveRoot(root: string | undefined): Promise<string | undefined> {
	if (root !== undefined) return fromInvocationCwd(root);
	return findDefaultRoot(process.env.INIT_CWD ?? process.cwd(), homedir());
}

async function resolveSession(options: Options): Promise<{ dirPath: string }> {
	if (options.target !== undefined) {
		return { dirPath: (await resolveTarget(fromInvocationCwd(options.target))).session.dirPath };
	}
	const root = await resolveRoot(options.root);
	if (root === undefined) {
		throw new Error("No runs root found. Pass a session directory, or --root <dir>.");
	}
	const sessions = await listRootSessions(root);
	if (sessions.length === 0) throw new Error(`No session found under ${root}`);
	return { dirPath: sessions[0].dirPath };
}

async function build(dirPath: string, options: Options): Promise<TrajectoryBundle> {
	return buildBundle({
		session: await discoverSession(dirPath),
		imageBudget: options.images
			? { maxBytes: options.maxImageBytes, totalBytes: DEFAULT_IMAGE_BUDGET.totalBytes }
			: { maxBytes: 0, totalBytes: 0 },
	});
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));

	if (options.list) {
		const root = await resolveRoot(options.root ?? options.target);
		if (root === undefined) throw new Error("No runs root found. Pass --root <dir>.");
		const sessions = await listRootSessions(root);
		if (sessions.length === 0) {
			process.stderr.write(`No session under ${root}\n`);
			return;
		}
		for (const session of sessions) {
			const when = new Date(session.modifiedAt).toISOString().replace("T", " ").slice(0, 19);
			process.stdout.write(`${when}  ${session.group ?? ""}  ${session.dirPath}\n`);
		}
		return;
	}

	const { dirPath } = await resolveSession(options);
	const assets = await loadViewerAssets();

	if (options.serve !== undefined) {
		await serveTrajectory({
			port: options.serve,
			render: async () => renderHtml(await build(dirPath, options), assets),
			label: dirPath,
		});
		return;
	}

	const bundle = await build(dirPath, options);
	const html = renderHtml(bundle, assets);
	if (options.stdout) {
		process.stdout.write(html);
		return;
	}
	const out = fromInvocationCwd(options.out ?? `${basename(dirPath)}-trajectory.html`);
	await writeFile(out, html, "utf8");
	const errors = bundle.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	for (const diagnostic of bundle.diagnostics) {
		process.stderr.write(`${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.message}\n`);
	}
	process.stderr.write(
		`${bundle.agents.length} agent(s), ${bundle.agents.reduce((total, agent) => total + agent.stats.records, 0)} records -> ${out}\n`,
	);
	if (errors.length > 0 && bundle.agents.length === 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
