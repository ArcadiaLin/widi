import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditFlow, type FlowCost } from "./audit.ts";
import type { Flow } from "./document.ts";
import { parseFlow } from "./parse.ts";

/**
 * The config directory, browsed rather than compiled in. A flow that fails to
 * parse or fails its audit still appears in the catalog, carrying its problems:
 * a flow the person is editing is exactly the one they need told about.
 */

export interface FlowEntry {
	readonly name: string;
	readonly path: string;
	readonly description?: string;
	readonly flow?: Flow;
	readonly cost?: FlowCost;
	readonly problems: readonly string[];
}

export interface FlowCatalog {
	readonly roots: readonly string[];
	readonly entries: readonly FlowEntry[];
}

/**
 * Where flows live: `.widi/workflows` beside the extension's own installation,
 * plus the same directory under the process's working directory.
 *
 * The extension API hands the core half neither the workspace cwd nor the agent
 * dir, so the installation's own location is the one root that is always right -
 * install the extension in the agent dir and its flows are the agent dir's,
 * install it in a project and they are the project's.
 */
export function flowRoots(): readonly string[] {
	const roots: string[] = [];
	try {
		roots.push(resolve(dirname(fileURLToPath(import.meta.url)), "../../../workflows"));
	} catch {
		// Loaders that do not give this module a file URL simply lose this root.
	}
	const fromCwd = resolve(process.cwd(), ".widi/workflows");
	if (!roots.includes(fromCwd)) roots.push(fromCwd);
	return roots;
}

export async function discoverFlows(roots: readonly string[] = flowRoots()): Promise<FlowCatalog> {
	const entries: FlowEntry[] = [];
	const claimed = new Set<string>();
	for (const root of roots) {
		for (const file of await listFlowFiles(root)) {
			const entry = await readEntry(file);
			// First root wins, so an installation's own flows shadow the ones it
			// would otherwise pick up from wherever the process happens to be.
			if (claimed.has(entry.name)) continue;
			claimed.add(entry.name);
			entries.push(entry);
		}
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));
	return { roots, entries };
}

/** Where a run's journal goes: relative paths resolve against the flow's own file. */
export function journalPath(flow: Flow): string | undefined {
	if (flow.journal === undefined) return undefined;
	return isAbsolute(flow.journal.path) ? flow.journal.path : resolve(dirname(flow.source), flow.journal.path);
}

async function listFlowFiles(root: string): Promise<readonly string[]> {
	try {
		const found = await readdir(root, { withFileTypes: true });
		return found
			.filter((entry) => entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")))
			.map((entry) => join(root, entry.name))
			.sort();
	} catch {
		// A missing directory is the normal case before anyone has written a flow.
		return [];
	}
}

async function readEntry(path: string): Promise<FlowEntry> {
	const fallback = path.replace(/^.*\//, "").replace(/\.ya?ml$/, "");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		return {
			name: fallback,
			path,
			problems: [`unreadable: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
	const parsed = parseFlow(text, path);
	if (parsed.flow === undefined) return { name: fallback, path, problems: parsed.errors };
	const audit = auditFlow(parsed.flow);
	return {
		name: parsed.flow.name,
		path,
		...(parsed.flow.description === undefined ? undefined : { description: parsed.flow.description }),
		...(audit.ok ? { flow: parsed.flow } : undefined),
		cost: audit.cost,
		problems: audit.problems,
	};
}
