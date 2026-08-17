/**
 * Finding sessions on disk.
 *
 * The runtime's layout is the whole of the agent tree's persistence: a session
 * directory owns `session.jsonl`, its `persistence/`, and under `agents/` the
 * directories of the sessions it spawned. Walking that shape is therefore how
 * this tool recovers a spawn tree that nothing else records - which is why the
 * walk lives here and the two reserved names are the only layout knowledge the
 * rest of the app needs.
 *
 * Path segments alternate `<session>/agents/<session>`, so a directory that does
 * not alternate is not part of the tree and the walk stops rather than guessing.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const SESSION_FILE_NAME = "session.jsonl";
export const AGENTS_DIR_NAME = "agents";
export const PERSISTENCE_DIR_NAME = "persistence";

export interface DiscoveredSession {
	/** Session key: this directory's name preceded by its ancestors' names. */
	readonly key: readonly string[];
	readonly dirName: string;
	readonly dirPath: string;
	readonly filePath: string;
	readonly children: readonly DiscoveredSession[];
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function childDirNames(path: string): Promise<string[]> {
	let names: string[];
	try {
		names = (await readdir(path, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	return names.sort();
}

/** Read one session directory and, recursively, the sessions it spawned. */
export async function discoverSession(dirPath: string, key: readonly string[] = []): Promise<DiscoveredSession> {
	const dirName = basename(dirPath);
	const sessionKey = key.length === 0 ? [dirName] : [...key];
	const agentsDir = join(dirPath, AGENTS_DIR_NAME);
	const children: DiscoveredSession[] = [];
	if (await isDirectory(agentsDir)) {
		for (const name of await childDirNames(agentsDir)) {
			if (name === AGENTS_DIR_NAME || name === PERSISTENCE_DIR_NAME) continue;
			const childDir = join(agentsDir, name);
			if (!(await isFile(join(childDir, SESSION_FILE_NAME)))) continue;
			children.push(await discoverSession(childDir, [...sessionKey, name]));
		}
	}
	return { key: sessionKey, dirName, dirPath, filePath: join(dirPath, SESSION_FILE_NAME), children };
}

export interface RootSessionRef {
	readonly dirPath: string;
	readonly dirName: string;
	/** Encoded cwd group directory the session sits in, when it sits in one. */
	readonly group?: string;
	readonly modifiedAt: number;
}

/**
 * Every top-level session under a runs root, newest first.
 *
 * A runs root holds one directory per project cwd, and each of those holds root
 * sessions. Both shapes are accepted: pointing at a single project's directory
 * lists just that project.
 */
export async function listRootSessions(root: string): Promise<RootSessionRef[]> {
	const found: RootSessionRef[] = [];
	const collect = async (dirPath: string, group?: string): Promise<void> => {
		for (const name of await childDirNames(dirPath)) {
			if (name === AGENTS_DIR_NAME || name === PERSISTENCE_DIR_NAME) continue;
			const candidate = join(dirPath, name);
			if (await isFile(join(candidate, SESSION_FILE_NAME))) {
				let modifiedAt = 0;
				try {
					modifiedAt = (await stat(join(candidate, SESSION_FILE_NAME))).mtimeMs;
				} catch {
					modifiedAt = 0;
				}
				found.push({ dirPath: candidate, dirName: name, ...(group === undefined ? undefined : { group }), modifiedAt });
				continue;
			}
			if (group === undefined) await collect(candidate, name);
		}
	};
	await collect(root);
	// Last activity first, because a session resumed today is the one someone
	// means by "the latest run". Directory names start with a compact timestamp,
	// so they order the same way and settle the tie when two files were touched
	// within the same millisecond.
	return found.sort((left, right) => right.modifiedAt - left.modifiedAt || right.dirName.localeCompare(left.dirName));
}

export interface ResolvedTarget {
	readonly session: DiscoveredSession;
	/** Runs root the session was found under, when the target named one. */
	readonly root?: string;
}

/**
 * Turn whatever the user pointed at into one root session directory.
 *
 * Accepted, in this order: a `session.jsonl`, a session directory, a project
 * group or runs root (newest session wins). A child session directory is
 * accepted as-is; its own subtree is what gets rendered, because a subtree is
 * reachable only through its parent and reading upward would mean guessing how
 * far up the caller meant.
 */
export async function resolveTarget(target: string): Promise<ResolvedTarget> {
	const path = resolve(target);
	if (basename(path) === SESSION_FILE_NAME && (await isFile(path))) {
		return { session: await discoverSession(dirname(path)) };
	}
	if (!(await isDirectory(path))) {
		throw new Error(`Not a directory or session file: ${path}`);
	}
	if (await isFile(join(path, SESSION_FILE_NAME))) {
		return { session: await discoverSession(path) };
	}
	const roots = await listRootSessions(path);
	if (roots.length === 0) {
		throw new Error(`No session found under ${path}`);
	}
	return { session: await discoverSession(roots[0].dirPath), root: path };
}

/** Default runs roots, in the order they are tried when no target is given. */
export function defaultRunRoots(cwd: string, home: string): string[] {
	return [join(cwd, ".widi", "runs"), join(home, ".widi", "runs")];
}

export async function findDefaultRoot(cwd: string, home: string): Promise<string | undefined> {
	for (const candidate of defaultRunRoots(cwd, home)) {
		if (await isDirectory(candidate)) return candidate;
	}
	return undefined;
}
