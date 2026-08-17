/**
 * One session subtree, assembled into the payload the viewer reads.
 *
 * The order matters. Every session is read first, because a link out of one
 * agent can only be resolved once every agent id in the tree is known - and a
 * link that resolves is the difference between a page that lets you follow a
 * delegation and a page that merely mentions one.
 *
 * An agent id that resolves to nothing is kept as a link with a null key rather
 * than dropped. Agents can run without being persisted, and a reader is better
 * served by "it talked to research-2, which is not in this tree" than by
 * silence.
 */

import { basename } from "node:path";
import type { DiscoveredSession } from "../load/discover.ts";
import { type RawEntry, readSessionFile, type SessionFile, SessionFileError } from "../load/session-file.ts";
import { buildBranches } from "./branch.ts";
import { ImageAllowance, type ImageBudget } from "./content.ts";
import { buildRecords } from "./records.ts";
import { statsOf } from "./stats.ts";
import {
	type AgentProfileRef,
	type AgentTrajectory,
	type LoadDiagnostic,
	type SessionOriginRef,
	TRAJECTORY_BUNDLE_VERSION,
	type TrajectoryBundle,
} from "./types.ts";

export interface BuildBundleOptions {
	readonly session: DiscoveredSession;
	readonly imageBudget?: ImageBudget;
}

interface FlatSession {
	readonly key: string;
	readonly parentKey: string | null;
	readonly depth: number;
	readonly discovered: DiscoveredSession;
}

function flatten(session: DiscoveredSession, parentKey: string | null, depth: number, out: FlatSession[]): void {
	const key = session.key.join("/");
	out.push({ key, parentKey, depth, discovered: session });
	for (const child of session.children) flatten(child, key, depth + 1, out);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function profileOf(metadata: Record<string, unknown> | undefined): AgentProfileRef | undefined {
	const profile = metadata?.profile;
	if (!isRecordValue(profile) || typeof profile.id !== "string") return undefined;
	return { id: profile.id, ...(typeof profile.label === "string" ? { label: profile.label } : undefined) };
}

function originOf(metadata: Record<string, unknown> | undefined): SessionOriginRef | undefined {
	const origin = metadata?.origin;
	if (!isRecordValue(origin)) return undefined;
	const parsed: SessionOriginRef = {
		...(typeof origin.spawnedBy === "string" ? { spawnedBy: origin.spawnedBy } : undefined),
		...(typeof origin.forkedFrom === "string" ? { forkedFrom: origin.forkedFrom } : undefined),
		...(typeof origin.forkEntryId === "string" ? { forkEntryId: origin.forkEntryId } : undefined),
	};
	return Object.keys(parsed).length === 0 ? undefined : parsed;
}

function sessionNameOf(entries: readonly RawEntry[]): string | undefined {
	let name: string | undefined;
	for (const entry of entries) {
		if (entry.type !== "session_info") continue;
		const raw = (entry as { name?: string }).name;
		name = typeof raw === "string" && raw !== "" ? raw : undefined;
	}
	return name;
}

export async function buildBundle(options: BuildBundleOptions): Promise<TrajectoryBundle> {
	const flat: FlatSession[] = [];
	flatten(options.session, null, 0, flat);

	const diagnostics: LoadDiagnostic[] = [];
	const files = new Map<string, SessionFile>();
	for (const entry of flat) {
		try {
			const file = await readSessionFile(entry.discovered.filePath);
			files.set(entry.key, file);
			for (const warning of file.warnings) {
				diagnostics.push({ severity: "warning", code: "session_file", message: warning, agentKey: entry.key });
			}
		} catch (error) {
			diagnostics.push({
				severity: "error",
				code: "unreadable_session",
				message: error instanceof SessionFileError ? error.message : String(error),
				agentKey: entry.key,
			});
		}
	}

	const keyOfAgentId = new Map<string, string>();
	for (const entry of flat) {
		const file = files.get(entry.key);
		if (file === undefined) continue;
		if (!keyOfAgentId.has(file.header.id)) keyOfAgentId.set(file.header.id, entry.key);
	}
	const keyOfAgent = (agentId: string): string | undefined => keyOfAgentId.get(agentId);

	const images = new ImageAllowance(options.imageBudget);
	const agents: AgentTrajectory[] = [];
	for (const entry of flat) {
		const file = files.get(entry.key);
		if (file === undefined) continue;
		const { records, byEntryId } = buildRecords({ entries: file.entries, images, keyOfAgent });
		const { branches, currentBranchId } = buildBranches({
			entries: file.entries,
			leafId: file.leafId,
			records,
			byEntryId,
		});
		const currentBranch = branches.find((branch) => branch.id === currentBranchId);
		const createdAt = Date.parse(file.header.timestamp);
		agents.push({
			key: entry.key,
			agentId: file.header.id,
			parentKey: entry.parentKey,
			depth: entry.depth,
			cwd: file.header.cwd,
			createdAt: Number.isFinite(createdAt) ? createdAt : 0,
			...(sessionNameOf(file.entries) === undefined ? undefined : { name: sessionNameOf(file.entries) }),
			...(profileOf(file.header.metadata) === undefined ? undefined : { profile: profileOf(file.header.metadata) }),
			...(originOf(file.header.metadata) === undefined ? undefined : { origin: originOf(file.header.metadata) }),
			records,
			branches,
			currentBranchId,
			stats: currentBranch?.stats ?? statsOf(records, 0),
		});
	}

	if (images.dropped > 0) {
		diagnostics.push({
			severity: "warning",
			code: "image_budget",
			message: `${images.dropped} image(s) were left out to keep the page small`,
		});
	}
	if (agents.length === 0) {
		diagnostics.push({
			severity: "error",
			code: "no_session",
			message: `No readable session under ${options.session.dirPath}`,
		});
	}

	return {
		version: TRAJECTORY_BUNDLE_VERSION,
		generatedAt: new Date().toISOString(),
		source: { rootPath: options.session.dirPath, cwd: agents[0]?.cwd ?? basename(options.session.dirPath) },
		agents,
		diagnostics,
	};
}
