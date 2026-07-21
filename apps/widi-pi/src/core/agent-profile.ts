import type {
	ExecutionEnv,
	FileError,
	FileInfo,
} from "@earendil-works/pi-agent-core";
import { DEFAULT_PROFILE_DIR } from "./constants.js";
import {
	type CoreDiagnostic,
	createDiagnostic,
	type DiagnosticSeverity,
	type DiagnosticSource,
} from "./diagnostics.ts";

export type AgentProfile = {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly systemPrompt: string;
	/** Whether newly-created agents should use persistent session storage. */
	readonly persist: boolean;
	readonly tools?: readonly string[];
	readonly skills?: readonly string[];
	readonly promptTemplates?: readonly string[];
	readonly extensions?: readonly string[];
	readonly missingExtensionSeverity?: AgentProfileMissingExtensionSeverity;

	readonly capabilities?: {
		readonly acceptsUserInput?: boolean;
		readonly canSpawn?: boolean;
		readonly canRequestUser?: boolean;
		/**
		 * Whether this agent may move tool calls to the background (bash with
		 * background, and the wait_for_jobs tool). Permitted unless explicitly
		 * false; when false the agent's background job table is withheld so
		 * backgroundable calls run synchronously.
		 */
		readonly canBackgroundJobs?: boolean;
	};
};

export type AgentProfileOverride = Partial<Omit<AgentProfile, "id">>;

export type AgentProfileMissingExtensionSeverity =
	| "ignore"
	| "warning"
	| "error";

export type AgentProfileReference = {
	readonly id: string;
	readonly label?: string;
};

export type AgentProfileDiagnosticCode =
	| "profile.file_info_failed"
	| "profile.list_failed"
	| "profile.read_failed"
	| "profile.parse_failed"
	| "profile.invalid_metadata"
	| "profile.invalid"
	| "profile.id_filename_mismatch"
	| "profile.duplicate_id"
	| "profile.source_overridden"
	| "profile.id_case_conflict"
	| "profile.missing"
	| "profile.disabled"
	| "profile.override_not_persistable"
	| "profile.source_missing";

export type AgentProfileDiagnosticSeverity = DiagnosticSeverity;

export type AgentProfileSourceKind =
	| "settings"
	| "cwd"
	| "agent_dir"
	| "memory"
	| "builtin";

export type AgentProfileSource = {
	readonly kind: AgentProfileSourceKind;
	readonly priority: number;
	readonly path?: string;
	readonly label?: string;
};

export type AgentProfileDiagnostic = CoreDiagnostic;

export type SourcedAgentProfile = {
	readonly profile: AgentProfile;
	readonly source: AgentProfileSource;
	readonly entryId: string;
};

export type AgentProfileSummary = {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly persist: boolean;
	readonly source: AgentProfileSource;
	readonly entryId: string;
};

export type ProfileCandidateStatus =
	| "available"
	| "shadowed"
	| "duplicate"
	| "invalid"
	| "parse_failed";

export type ProfileCandidate = {
	readonly entryId: string;
	readonly profileId?: string;
	readonly filenameId?: string;
	readonly label?: string;
	readonly description?: string;
	readonly source: AgentProfileSource;
	readonly status: ProfileCandidateStatus;
	readonly diagnostics: AgentProfileDiagnostic[];
};

export type ResolveProfileFailureReason =
	| "profile_missing"
	| "parse_failed"
	| "invalid_profile"
	| "duplicate_profile_id";

export type ResolveProfileResult =
	| {
			readonly ok: true;
			readonly profile: AgentProfile;
			readonly source: AgentProfileSource;
			readonly entryId: string;
			readonly diagnostics: AgentProfileDiagnostic[];
	  }
	| {
			readonly ok: false;
			readonly reason: ResolveProfileFailureReason;
			readonly profileId: string;
			readonly diagnostics: AgentProfileDiagnostic[];
	  };

export type ListProfilesResult = {
	readonly profiles: AgentProfileSummary[];
	readonly diagnostics: AgentProfileDiagnostic[];
};

export type InspectProfilesResult = {
	readonly candidates: ProfileCandidate[];
	readonly diagnostics: AgentProfileDiagnostic[];
};

export type ProfileStorageEntry = {
	readonly entryId: string;
	readonly source: AgentProfileSource;
	readonly displayName?: string;
	readonly filenameId?: string;
};

export type ProfileStorageListResult = {
	readonly entries: ProfileStorageEntry[];
	readonly diagnostics: AgentProfileDiagnostic[];
};

export type ProfileStorageReadResult =
	| {
			readonly ok: true;
			readonly entry: ProfileStorageEntry;
			readonly content: string;
	  }
	| {
			readonly ok: false;
			readonly diagnostic: AgentProfileDiagnostic;
	  };

export interface ProfileStorageBackend {
	listEntries(): Promise<ProfileStorageListResult>;
	readEntry(entryId: string): Promise<ProfileStorageReadResult>;
}

export type FileProfileRoot = {
	readonly kind: Exclude<AgentProfileSourceKind, "memory" | "builtin">;
	readonly path: string;
	readonly priority: number;
	readonly missingBehavior: "silent" | "diagnostic";
	readonly label?: string;
};

type AgentProfileFrontmatter = {
	readonly id?: unknown;
	readonly label?: unknown;
	readonly description?: unknown;
	readonly persist?: unknown;
	readonly tools?: unknown;
	readonly skills?: unknown;
	readonly promptTemplates?: unknown;
	readonly "prompt-templates"?: unknown;
	readonly extensions?: unknown;
	readonly capabilities?: unknown;
	readonly missingExtensionSeverity?: unknown;
	readonly "missing-extension-severity"?: unknown;
	readonly [key: string]: unknown;
};

type ParsedProfileMarkdown = {
	readonly frontmatter: AgentProfileFrontmatter;
	readonly body: string;
};

type ProfileMetadata = {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly persist: boolean;
	readonly filenameId?: string;
};

type ParsedProfileCandidate = {
	readonly entry: ProfileStorageEntry;
	readonly metadata?: ProfileMetadata;
	readonly markdown?: ParsedProfileMarkdown;
	readonly diagnostics: AgentProfileDiagnostic[];
	readonly status: ProfileCandidateStatus;
	readonly blockingProfileId?: string;
};

type ProfileIndex = {
	readonly candidates: ParsedProfileCandidate[];
	readonly candidatesByProfileId: Map<string, ParsedProfileCandidate[]>;
	readonly diagnostics: AgentProfileDiagnostic[];
};

const BUILTIN_DEFAULT_PROFILE: AgentProfile = {
	id: "default",
	label: "Default Agent",
	systemPrompt: "You are WIDI.",
	persist: true,
};

export function toAgentProfileReference(
	profile: Pick<AgentProfile, "id" | "label">,
): AgentProfileReference {
	return {
		id: profile.id,
		label: profile.label,
	};
}

/**
 * Narrow an untyped session header metadata value to a profile reference.
 * Storage keeps header metadata opaque, so consumers validate the shape here.
 */
export function parseAgentProfileReference(
	value: unknown,
): AgentProfileReference | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as { id?: unknown; label?: unknown };
	if (typeof record.id !== "string" || !record.id) return undefined;
	return {
		id: record.id,
		label: typeof record.label === "string" ? record.label : undefined,
	};
}

export function createDefaultProfileRoots(options: {
	readonly executionEnv: ExecutionEnv;
	readonly cwd: string;
	readonly agentDir: string;
	readonly settingsProfilePaths?: readonly string[];
}): Promise<FileProfileRoot[]> {
	return resolveDefaultProfileRoots(options);
}

export function createBuiltinProfileStorageBackend(
	profile: AgentProfile = BUILTIN_DEFAULT_PROFILE,
	priority = 0,
): InMemoryProfileStorageBackend {
	return InMemoryProfileStorageBackend.fromProfiles([
		{
			profile,
			entryId: `builtin:${profile.id}`,
			source: {
				kind: "builtin",
				priority,
				label: "builtin",
			},
		},
	]);
}

export class FileProfileStorageBackend implements ProfileStorageBackend {
	private readonly executionEnv: ExecutionEnv;
	private readonly roots: readonly FileProfileRoot[];
	private readonly entries: Map<string, ProfileStorageEntry> = new Map();

	constructor(executionEnv: ExecutionEnv, roots: readonly FileProfileRoot[]) {
		this.executionEnv = executionEnv;
		this.roots = [...roots];
	}

	async listEntries(): Promise<ProfileStorageListResult> {
		this.entries.clear();
		const entries: ProfileStorageEntry[] = [];
		const diagnostics: AgentProfileDiagnostic[] = [];

		for (let index = 0; index < this.roots.length; index += 1) {
			const root = this.roots[index];
			const result = await this.listRoot(root, index);
			entries.push(...result.entries);
			diagnostics.push(...result.diagnostics);
		}

		return {
			entries: entries.sort((a, b) => a.entryId.localeCompare(b.entryId)),
			diagnostics,
		};
	}

	async readEntry(entryId: string): Promise<ProfileStorageReadResult> {
		const entry = this.entries.get(entryId);
		if (!entry?.source.path) {
			return {
				ok: false,
				diagnostic: createProfileDiagnostic({
					severity: "error",
					code: "profile.read_failed",
					message: `Unknown profile storage entry: ${entryId}`,
					entryId,
					source: entry?.source,
				}),
			};
		}

		const result = await this.executionEnv.readTextFile(entry.source.path);
		if (!result.ok) {
			return {
				ok: false,
				diagnostic: fileErrorDiagnostic(
					"profile.read_failed",
					result.error,
					entry.source,
					entryId,
				),
			};
		}

		return { ok: true, entry, content: result.value };
	}

	private async listRoot(
		root: FileProfileRoot,
		rootIndex: number,
	): Promise<ProfileStorageListResult> {
		const source: AgentProfileSource = {
			kind: root.kind,
			priority: root.priority,
			path: root.path,
			label: root.label,
		};
		const infoResult = await this.executionEnv.fileInfo(root.path);
		if (!infoResult.ok) {
			if (
				infoResult.error.code === "not_found" &&
				root.missingBehavior === "silent"
			) {
				return { entries: [], diagnostics: [] };
			}
			return {
				entries: [],
				diagnostics: [
					fileErrorDiagnostic(
						infoResult.error.code === "not_found"
							? "profile.source_missing"
							: "profile.file_info_failed",
						infoResult.error,
						source,
					),
				],
			};
		}

		const kind = await this.resolveKind(infoResult.value);
		if (kind === "directory") {
			return await this.listDirectory(infoResult.value.path, source, rootIndex);
		}
		if (kind === "file" && infoResult.value.name.endsWith(".md")) {
			const entry = this.createFileEntry(infoResult.value, source, rootIndex);
			return { entries: [entry], diagnostics: [] };
		}

		return { entries: [], diagnostics: [] };
	}

	private async listDirectory(
		path: string,
		source: AgentProfileSource,
		rootIndex: number,
	): Promise<ProfileStorageListResult> {
		const entriesResult = await this.executionEnv.listDir(path);
		if (!entriesResult.ok) {
			return {
				entries: [],
				diagnostics: [
					fileErrorDiagnostic(
						"profile.list_failed",
						entriesResult.error,
						source,
					),
				],
			};
		}

		const entries: ProfileStorageEntry[] = [];
		for (const entry of entriesResult.value.sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const kind = await this.resolveKind(entry);
			if (kind !== "file" || !entry.name.endsWith(".md")) continue;
			entries.push(
				this.createFileEntry(entry, { ...source, path: entry.path }, rootIndex),
			);
		}
		return { entries, diagnostics: [] };
	}

	private createFileEntry(
		info: FileInfo,
		source: AgentProfileSource,
		rootIndex: number,
	): ProfileStorageEntry {
		const entry: ProfileStorageEntry = {
			entryId: `file:${rootIndex}:${info.path}`,
			source: { ...source, path: info.path },
			displayName: info.name,
			filenameId: basenameEnvPath(info.path).replace(/\.md$/i, ""),
		};
		this.entries.set(entry.entryId, entry);
		return entry;
	}

	private async resolveKind(
		info: FileInfo,
	): Promise<"file" | "directory" | undefined> {
		if (info.kind === "file" || info.kind === "directory") {
			return info.kind;
		}

		const canonicalPath = await this.executionEnv.canonicalPath(info.path);
		if (!canonicalPath.ok) {
			return undefined;
		}
		const target = await this.executionEnv.fileInfo(canonicalPath.value);
		if (!target.ok) {
			return undefined;
		}
		return target.value.kind === "file" || target.value.kind === "directory"
			? target.value.kind
			: undefined;
	}
}

export class InMemoryProfileStorageBackend implements ProfileStorageBackend {
	private readonly entries: Map<
		string,
		{ entry: ProfileStorageEntry; content: string }
	> = new Map();

	constructor(
		entries: readonly {
			readonly entryId: string;
			readonly content: string;
			readonly source?: AgentProfileSource;
			readonly displayName?: string;
			readonly filenameId?: string;
		}[],
	) {
		for (const item of entries) {
			const entry: ProfileStorageEntry = {
				entryId: item.entryId,
				source: item.source ?? { kind: "memory", priority: 0 },
				displayName: item.displayName,
				filenameId: item.filenameId,
			};
			this.entries.set(item.entryId, { entry, content: item.content });
		}
	}

	static fromProfiles(
		profiles: readonly {
			readonly profile: AgentProfile;
			readonly entryId?: string;
			readonly source?: AgentProfileSource;
		}[],
	): InMemoryProfileStorageBackend {
		return new InMemoryProfileStorageBackend(
			profiles.map(({ profile, entryId, source }) => ({
				entryId: entryId ?? `memory:${profile.id}`,
				source: source ?? { kind: "memory", priority: 0 },
				filenameId: profile.id,
				displayName: `${profile.id}.md`,
				content: serializeProfile(profile),
			})),
		);
	}

	async listEntries(): Promise<ProfileStorageListResult> {
		return {
			entries: [...this.entries.values()].map(({ entry }) => entry),
			diagnostics: [],
		};
	}

	async readEntry(entryId: string): Promise<ProfileStorageReadResult> {
		const item = this.entries.get(entryId);
		if (!item) {
			return {
				ok: false,
				diagnostic: createProfileDiagnostic({
					severity: "error",
					code: "profile.read_failed",
					message: `Unknown profile storage entry: ${entryId}`,
					entryId,
				}),
			};
		}
		return { ok: true, entry: item.entry, content: item.content };
	}
}

export class CompositeProfileStorageBackend implements ProfileStorageBackend {
	private readonly backends: readonly ProfileStorageBackend[];
	private readonly entrySources: Map<
		string,
		{ backend: ProfileStorageBackend; entryId: string }
	> = new Map();

	constructor(backends: readonly ProfileStorageBackend[]) {
		this.backends = [...backends];
	}

	async listEntries(): Promise<ProfileStorageListResult> {
		this.entrySources.clear();
		const entries: ProfileStorageEntry[] = [];
		const diagnostics: AgentProfileDiagnostic[] = [];

		for (let index = 0; index < this.backends.length; index += 1) {
			const backend = this.backends[index];
			const result = await backend.listEntries();
			diagnostics.push(...result.diagnostics);
			for (const entry of result.entries) {
				const compositeEntryId = `${index}:${entry.entryId}`;
				this.entrySources.set(compositeEntryId, {
					backend,
					entryId: entry.entryId,
				});
				entries.push({ ...entry, entryId: compositeEntryId });
			}
		}

		return { entries, diagnostics };
	}

	async readEntry(entryId: string): Promise<ProfileStorageReadResult> {
		const source = this.entrySources.get(entryId);
		if (!source) {
			return {
				ok: false,
				diagnostic: createProfileDiagnostic({
					severity: "error",
					code: "profile.read_failed",
					message: `Unknown profile storage entry: ${entryId}`,
					entryId,
				}),
			};
		}

		const result = await source.backend.readEntry(source.entryId);
		if (!result.ok) {
			return {
				ok: false,
				diagnostic: {
					...result.diagnostic,
					details: { ...result.diagnostic.details, entryId },
				},
			};
		}
		return {
			ok: true,
			entry: { ...result.entry, entryId },
			content: result.content,
		};
	}
}

export class AgentProfileRegistry {
	private readonly storage: ProfileStorageBackend;
	private index: ProfileIndex | undefined;
	private readonly rawContent: Map<string, string> = new Map();

	constructor(storage: ProfileStorageBackend) {
		this.storage = storage;
	}

	reload(): void {
		this.index = undefined;
		this.rawContent.clear();
	}

	invalidate(): void {
		this.reload();
	}

	async resolveProfile(profileId: string): Promise<ResolveProfileResult> {
		const normalizedProfileId = profileId.trim();
		const index = await this.ensureIndex();
		const candidates =
			index.candidatesByProfileId.get(normalizedProfileId) ?? [];
		if (candidates.length === 0) {
			return {
				ok: false,
				reason: "profile_missing",
				profileId: normalizedProfileId,
				diagnostics: [
					...index.diagnostics,
					createProfileDiagnostic({
						severity: "error",
						code: "profile.missing",
						message: `Profile not found: ${normalizedProfileId}`,
						profileId: normalizedProfileId,
						phase: "resolve",
					}),
				],
			};
		}

		const selected = selectProfileCandidate(candidates);
		const diagnostics = [
			...index.diagnostics,
			...diagnosticsForProfileSelection(
				normalizedProfileId,
				candidates,
				selected,
			),
		];

		if (selected.status === "duplicate") {
			return {
				ok: false,
				reason: "duplicate_profile_id",
				profileId: normalizedProfileId,
				diagnostics,
			};
		}
		if (selected.status === "parse_failed") {
			return {
				ok: false,
				reason: "parse_failed",
				profileId: normalizedProfileId,
				diagnostics,
			};
		}
		if (selected.status === "invalid") {
			return {
				ok: false,
				reason: "invalid_profile",
				profileId: normalizedProfileId,
				diagnostics,
			};
		}

		const content = this.rawContent.get(selected.entry.entryId);
		if (content === undefined) {
			return {
				ok: false,
				reason: "profile_missing",
				profileId: normalizedProfileId,
				diagnostics,
			};
		}

		const parsed = parseProfileMarkdown(content);
		if (!parsed.ok) {
			return {
				ok: false,
				reason: "parse_failed",
				profileId: normalizedProfileId,
				diagnostics: [
					...diagnostics,
					diagnosticForEntry(
						selected.entry,
						"error",
						"profile.parse_failed",
						parsed.error,
						normalizedProfileId,
					),
				],
			};
		}

		const profileResult = parseAgentProfile(
			selected.entry,
			parsed.value,
			selected.entry.filenameId,
		);
		if (!profileResult.profile) {
			return {
				ok: false,
				reason: "invalid_profile",
				profileId: normalizedProfileId,
				diagnostics: [...diagnostics, ...profileResult.diagnostics],
			};
		}

		return {
			ok: true,
			profile: profileResult.profile,
			source: selected.entry.source,
			entryId: selected.entry.entryId,
			diagnostics,
		};
	}

	async listProfiles(): Promise<ListProfilesResult> {
		const index = await this.ensureIndex();
		const profiles: AgentProfileSummary[] = [];
		const diagnostics = [...index.diagnostics];

		for (const [profileId, candidates] of [...index.candidatesByProfileId].sort(
			([left], [right]) => left.localeCompare(right),
		)) {
			const selected = selectProfileCandidate(candidates);
			diagnostics.push(
				...diagnosticsForProfileSelection(profileId, candidates, selected),
			);
			if (selected.status !== "available" || !selected.metadata) continue;
			profiles.push({
				id: selected.metadata.id,
				label: selected.metadata.label,
				description: selected.metadata.description,
				persist: selected.metadata.persist,
				source: selected.entry.source,
				entryId: selected.entry.entryId,
			});
		}

		return { profiles, diagnostics };
	}

	async inspectProfiles(): Promise<InspectProfilesResult> {
		const index = await this.ensureIndex();
		return {
			candidates: index.candidates.map((candidate) => ({
				entryId: candidate.entry.entryId,
				profileId: candidate.metadata?.id ?? candidate.blockingProfileId,
				filenameId: candidate.entry.filenameId,
				label: candidate.metadata?.label,
				description: candidate.metadata?.description,
				source: candidate.entry.source,
				status: candidate.status,
				diagnostics: candidate.diagnostics,
			})),
			diagnostics: index.diagnostics,
		};
	}

	private async ensureIndex(): Promise<ProfileIndex> {
		if (this.index) {
			return this.index;
		}

		const listResult = await this.storage.listEntries();
		const candidates: ParsedProfileCandidate[] = [];
		const diagnostics: AgentProfileDiagnostic[] = [...listResult.diagnostics];

		for (const entry of listResult.entries) {
			const readResult = await this.storage.readEntry(entry.entryId);
			if (!readResult.ok) {
				diagnostics.push(readResult.diagnostic);
				candidates.push({
					entry,
					status: "parse_failed",
					blockingProfileId: entry.filenameId,
					diagnostics: [readResult.diagnostic],
				});
				continue;
			}

			this.rawContent.set(entry.entryId, readResult.content);
			const parsed = parseProfileMarkdown(readResult.content);
			if (!parsed.ok) {
				const diagnostic = diagnosticForEntry(
					entry,
					"error",
					"profile.parse_failed",
					parsed.error,
					entry.filenameId,
				);
				candidates.push({
					entry,
					status: "parse_failed",
					blockingProfileId: entry.filenameId,
					diagnostics: [diagnostic],
				});
				continue;
			}

			const metadataResult = parseAgentProfileMetadata(
				entry,
				parsed.value,
				entry.filenameId,
			);
			candidates.push({
				entry,
				markdown: parsed.value,
				metadata: metadataResult.metadata,
				status: metadataResult.metadata ? "available" : "invalid",
				blockingProfileId: metadataResult.blockingProfileId,
				diagnostics: metadataResult.diagnostics,
			});
		}

		const candidatesByProfileId = groupCandidatesByProfileId(candidates);
		applyCandidateStatuses(candidatesByProfileId);
		diagnostics.push(...caseConflictDiagnostics(candidatesByProfileId));
		this.index = { candidates, candidatesByProfileId, diagnostics };
		return this.index;
	}
}

async function resolveDefaultProfileRoots(options: {
	readonly executionEnv: ExecutionEnv;
	readonly cwd: string;
	readonly agentDir: string;
	readonly settingsProfilePaths?: readonly string[];
}): Promise<FileProfileRoot[]> {
	const roots: FileProfileRoot[] = [
		...(options.settingsProfilePaths ?? []).map(
			(path): FileProfileRoot => ({
				kind: "settings",
				path,
				priority: 300,
				missingBehavior: "diagnostic",
			}),
		),
	];
	const cwdProfilePath = await joinPathOrThrow(options.executionEnv, [
		options.cwd,
		".widi",
		DEFAULT_PROFILE_DIR,
	]);
	roots.push({
		kind: "cwd",
		path: cwdProfilePath,
		priority: 200,
		missingBehavior: "silent",
	});

	if (options.agentDir) {
		const agentProfilePath = await joinPathOrThrow(options.executionEnv, [
			options.agentDir,
			DEFAULT_PROFILE_DIR,
		]);
		roots.push({
			kind: "agent_dir",
			path: agentProfilePath,
			priority: 100,
			missingBehavior: "silent",
		});
	}

	// The agent dir may itself be the cwd's .widi directory; loading the same
	// root twice makes every profile report a bogus self-override diagnostic.
	const seenPaths = new Set<string>();
	return roots.filter((root) => {
		if (seenPaths.has(root.path)) return false;
		seenPaths.add(root.path);
		return true;
	});
}

function groupCandidatesByProfileId(
	candidates: readonly ParsedProfileCandidate[],
): Map<string, ParsedProfileCandidate[]> {
	const groups = new Map<string, ParsedProfileCandidate[]>();
	for (const candidate of candidates) {
		const profileId = candidate.metadata?.id ?? candidate.blockingProfileId;
		if (!profileId) continue;
		const group = groups.get(profileId) ?? [];
		group.push(candidate);
		groups.set(profileId, group);
	}
	return groups;
}

function applyCandidateStatuses(
	groups: Map<string, ParsedProfileCandidate[]>,
): void {
	for (const candidates of groups.values()) {
		const highestPriority = Math.max(
			...candidates.map(({ entry }) => entry.source.priority),
		);
		const highest = candidates.filter(
			({ entry }) => entry.source.priority === highestPriority,
		);

		if (highest.length > 1) {
			for (const candidate of highest) {
				mutateCandidateStatus(candidate, "duplicate");
			}
		}

		for (const candidate of candidates) {
			if (candidate.entry.source.priority < highestPriority) {
				mutateCandidateStatus(candidate, "shadowed");
			}
		}
	}
}

function mutateCandidateStatus(
	candidate: ParsedProfileCandidate,
	status: ProfileCandidateStatus,
): void {
	(candidate as { status: ProfileCandidateStatus }).status = status;
}

function selectProfileCandidate(
	candidates: readonly ParsedProfileCandidate[],
): ParsedProfileCandidate {
	const highestPriority = Math.max(
		...candidates.map(({ entry }) => entry.source.priority),
	);
	return candidates
		.filter(({ entry }) => entry.source.priority === highestPriority)
		.sort((left, right) =>
			left.entry.entryId.localeCompare(right.entry.entryId),
		)[0] as ParsedProfileCandidate;
}

function diagnosticsForProfileSelection(
	profileId: string,
	candidates: readonly ParsedProfileCandidate[],
	selected: ParsedProfileCandidate,
): AgentProfileDiagnostic[] {
	const diagnostics = candidates.flatMap((candidate) => candidate.diagnostics);
	const highestPriority = selected.entry.source.priority;
	const highest = candidates.filter(
		({ entry }) => entry.source.priority === highestPriority,
	);

	if (highest.length > 1) {
		diagnostics.push(
			createProfileDiagnostic({
				severity: "error",
				code: "profile.duplicate_id",
				message: `Duplicate profile id at the same priority: ${profileId}`,
				profileId,
				source: selected.entry.source,
				phase: "resolve",
			}),
		);
	}

	for (const candidate of candidates) {
		if (candidate.entry.source.priority >= highestPriority) continue;
		diagnostics.push(
			createProfileDiagnostic({
				severity: "info",
				code: "profile.source_overridden",
				message: `Profile ${profileId} from ${formatSource(candidate.entry.source)} is overridden by ${formatSource(selected.entry.source)}.`,
				profileId,
				entryId: candidate.entry.entryId,
				source: candidate.entry.source,
				phase: "resolve",
				details: {
					selectedEntryId: selected.entry.entryId,
					selectedSource: selected.entry.source,
				},
			}),
		);
	}

	return diagnostics;
}

function caseConflictDiagnostics(
	groups: Map<string, ParsedProfileCandidate[]>,
): AgentProfileDiagnostic[] {
	const byLowercase = new Map<string, string[]>();
	for (const id of groups.keys()) {
		const lowered = id.toLocaleLowerCase();
		const ids = byLowercase.get(lowered) ?? [];
		ids.push(id);
		byLowercase.set(lowered, ids);
	}

	const diagnostics: AgentProfileDiagnostic[] = [];
	for (const ids of byLowercase.values()) {
		const uniqueIds = [...new Set(ids)];
		if (uniqueIds.length <= 1) continue;
		diagnostics.push(
			createProfileDiagnostic({
				severity: "warning",
				code: "profile.id_case_conflict",
				message: `Profile ids differ only by case: ${uniqueIds.join(", ")}`,
				details: { profileIds: uniqueIds },
			}),
		);
	}
	return diagnostics;
}

function parseAgentProfile(
	entry: ProfileStorageEntry,
	parsed: ParsedProfileMarkdown,
	filenameId: string | undefined,
): {
	profile: AgentProfile | undefined;
	diagnostics: AgentProfileDiagnostic[];
} {
	const metadataResult = parseAgentProfileMetadata(entry, parsed, filenameId);
	if (!metadataResult.metadata) {
		return { profile: undefined, diagnostics: metadataResult.diagnostics };
	}
	const frontmatter = parsed.frontmatter;
	const diagnostics = [...metadataResult.diagnostics];
	const tools = readStringArray(frontmatter.tools, "tools", entry, diagnostics);
	const skills = readStringArray(
		frontmatter.skills,
		"skills",
		entry,
		diagnostics,
	);
	const promptTemplates = readStringArray(
		frontmatter.promptTemplates ?? frontmatter["prompt-templates"],
		"promptTemplates",
		entry,
		diagnostics,
	);
	const extensions = readStringArray(
		frontmatter.extensions,
		"extensions",
		entry,
		diagnostics,
	);
	const capabilities = readCapabilities(
		frontmatter.capabilities,
		entry,
		diagnostics,
	);
	const missingExtensionSeverity = readMissingExtensionSeverity(
		frontmatter.missingExtensionSeverity ??
			frontmatter["missing-extension-severity"],
		entry,
		diagnostics,
	);

	if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return { profile: undefined, diagnostics };
	}

	return {
		profile: {
			id: metadataResult.metadata.id,
			label: metadataResult.metadata.label,
			description: metadataResult.metadata.description,
			systemPrompt: parsed.body,
			persist: metadataResult.metadata.persist,
			tools,
			skills,
			promptTemplates,
			extensions,
			missingExtensionSeverity,
			capabilities,
		},
		diagnostics,
	};
}

function parseAgentProfileMetadata(
	entry: ProfileStorageEntry,
	parsed: ParsedProfileMarkdown,
	filenameId: string | undefined,
): {
	metadata: ProfileMetadata | undefined;
	blockingProfileId?: string;
	diagnostics: AgentProfileDiagnostic[];
} {
	const frontmatter = parsed.frontmatter;
	const diagnostics: AgentProfileDiagnostic[] = [];
	const rawId = readString(frontmatter.id);
	const id = rawId ?? filenameId;
	const label = readString(frontmatter.label) ?? id;
	const description = readString(frontmatter.description);
	const persist =
		readBoolean(frontmatter.persist, "persist", entry, diagnostics) ?? false;

	if (!id) {
		diagnostics.push(
			diagnosticForEntry(
				entry,
				"error",
				"profile.invalid",
				"Profile id is missing.",
			),
		);
		return { metadata: undefined, diagnostics };
	}

	const idValidation = validateProfileId(id);
	if (idValidation) {
		diagnostics.push(
			diagnosticForEntry(entry, "error", "profile.invalid", idValidation, id),
		);
		return {
			metadata: undefined,
			blockingProfileId: filenameId,
			diagnostics,
		};
	}

	if (rawId && filenameId && rawId !== filenameId) {
		diagnostics.push(
			diagnosticForEntry(
				entry,
				"warning",
				"profile.id_filename_mismatch",
				`Profile id "${rawId}" does not match filename-derived id "${filenameId}".`,
				rawId,
			),
		);
	}

	if (!parsed.body.trim()) {
		diagnostics.push(
			diagnosticForEntry(
				entry,
				"warning",
				"profile.invalid_metadata",
				"Profile markdown body is empty; systemPrompt will be empty until the schema is finalized.",
				id,
			),
		);
	}

	return {
		metadata: {
			id,
			label: label ?? id,
			description,
			persist,
			filenameId,
		},
		diagnostics,
	};
}

function parseProfileMarkdown(
	content: string,
): { ok: true; value: ParsedProfileMarkdown } | { ok: false; error: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return { ok: true, value: { frontmatter: {}, body: normalized.trim() } };
	}

	const endIndex = normalized.indexOf("\n---", 4);
	if (endIndex === -1) {
		return {
			ok: false,
			error: "Profile frontmatter is missing a closing --- marker.",
		};
	}

	const frontmatter: Record<string, unknown> = {};
	const lines = normalized.slice(4, endIndex).split("\n");
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			index += 1;
			continue;
		}
		const separatorIndex = trimmed.indexOf(":");
		if (separatorIndex === -1) {
			return { ok: false, error: `Cannot parse frontmatter line: ${trimmed}` };
		}

		const key = trimmed.slice(0, separatorIndex).trim();
		const rawValue = trimmed.slice(separatorIndex + 1).trim();
		if (rawValue !== "") {
			frontmatter[key] = parseSimpleFrontmatterValue(rawValue);
			index += 1;
			continue;
		}

		// A key without a value opens a one-level nested mapping, such as
		// "capabilities"; its entries are the indented lines.
		const indent = line.length - line.trimStart().length;
		const child: Record<string, unknown> = {};
		index += 1;
		while (index < lines.length) {
			const childLine = lines[index];
			const childTrimmed = childLine.trim();
			if (!childTrimmed || childTrimmed.startsWith("#")) {
				index += 1;
				continue;
			}
			if (childLine.length - childLine.trimStart().length <= indent) break;
			const childSeparatorIndex = childTrimmed.indexOf(":");
			const childRawValue =
				childSeparatorIndex === -1
					? ""
					: childTrimmed.slice(childSeparatorIndex + 1).trim();
			if (childSeparatorIndex === -1 || childRawValue === "") {
				return {
					ok: false,
					error: `Cannot parse nested frontmatter line: ${childTrimmed}`,
				};
			}
			child[childTrimmed.slice(0, childSeparatorIndex).trim()] =
				parseSimpleFrontmatterValue(childRawValue);
			index += 1;
		}
		frontmatter[key] = child;
	}

	return {
		ok: true,
		value: {
			frontmatter,
			body: normalized.slice(endIndex + 4).trim(),
		},
	};
}

function parseSimpleFrontmatterValue(value: string): unknown {
	if (value === "true") return true;
	if (value === "false") return false;
	if (value.startsWith("[") && value.endsWith("]")) {
		const inner = value.slice(1, -1).trim();
		if (!inner) return [];
		return inner
			.split(",")
			.map((item) => unquote(item.trim()))
			.filter(Boolean);
	}
	return unquote(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(
	value: unknown,
	fieldName: string,
	entry: ProfileStorageEntry,
	diagnostics: AgentProfileDiagnostic[],
): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	diagnostics.push(
		diagnosticForEntry(
			entry,
			"error",
			"profile.invalid_metadata",
			`Profile field "${fieldName}" must be a boolean.`,
		),
	);
	return undefined;
}

function readStringArray(
	value: unknown,
	fieldName: string,
	entry: ProfileStorageEntry,
	diagnostics: AgentProfileDiagnostic[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		diagnostics.push(
			diagnosticForEntry(
				entry,
				"error",
				"profile.invalid_metadata",
				`Profile field "${fieldName}" must be an array of strings.`,
			),
		);
		return undefined;
	}

	const items: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !item.trim()) {
			diagnostics.push(
				diagnosticForEntry(
					entry,
					"error",
					"profile.invalid_metadata",
					`Profile field "${fieldName}" must be an array of non-empty strings.`,
				),
			);
			return undefined;
		}
		items.push(item.trim());
	}
	return items.length > 0 ? items : undefined;
}

function readMissingExtensionSeverity(
	value: unknown,
	entry: ProfileStorageEntry,
	diagnostics: AgentProfileDiagnostic[],
): AgentProfileMissingExtensionSeverity | undefined {
	if (value === undefined) return undefined;
	if (value === "ignore" || value === "warning" || value === "error") {
		return value;
	}
	diagnostics.push(
		diagnosticForEntry(
			entry,
			"error",
			"profile.invalid_metadata",
			'Profile field "missingExtensionSeverity" must be "ignore", "warning", or "error".',
		),
	);
	return undefined;
}

function readCapabilities(
	value: unknown,
	entry: ProfileStorageEntry,
	diagnostics: AgentProfileDiagnostic[],
): AgentProfile["capabilities"] | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		diagnostics.push(
			diagnosticForEntry(
				entry,
				"error",
				"profile.invalid_metadata",
				'Profile field "capabilities" must be an object.',
			),
		);
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const capabilities: {
		acceptsUserInput?: boolean;
		canSpawn?: boolean;
		canRequestUser?: boolean;
		canBackgroundJobs?: boolean;
	} = {};
	for (const key of [
		"acceptsUserInput",
		"canSpawn",
		"canRequestUser",
		"canBackgroundJobs",
	] as const) {
		const fieldValue = record[key];
		if (fieldValue === undefined) continue;
		if (typeof fieldValue !== "boolean") {
			diagnostics.push(
				diagnosticForEntry(
					entry,
					"error",
					"profile.invalid_metadata",
					`Profile capability "${key}" must be a boolean.`,
				),
			);
			continue;
		}
		capabilities[key] = fieldValue;
	}
	return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function validateProfileId(id: string): string | undefined {
	if (!id.trim()) {
		return "Profile id must be non-empty.";
	}
	if (id !== id.trim()) {
		return "Profile id must not contain leading or trailing whitespace.";
	}
	if (id.includes("/") || id.includes("\\")) {
		return "Profile id must not contain slash or backslash.";
	}
	if (hasControlCharacter(id)) {
		return "Profile id must not contain control characters.";
	}
	return undefined;
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function diagnosticForEntry(
	entry: ProfileStorageEntry,
	severity: AgentProfileDiagnosticSeverity,
	code: AgentProfileDiagnosticCode,
	message: string,
	profileId?: string,
): AgentProfileDiagnostic {
	return createProfileDiagnostic({
		severity,
		code,
		message,
		entryId: entry.entryId,
		profileId,
		source: entry.source,
	});
}

function fileErrorDiagnostic(
	code: AgentProfileDiagnosticCode,
	error: FileError,
	source: AgentProfileSource,
	entryId?: string,
): AgentProfileDiagnostic {
	return createProfileDiagnostic({
		severity: code === "profile.source_missing" ? "warning" : "error",
		code,
		message: error.message,
		entryId,
		source,
	});
}

function createProfileDiagnostic(options: {
	readonly severity: AgentProfileDiagnosticSeverity;
	readonly code: AgentProfileDiagnosticCode;
	readonly message: string;
	readonly entryId?: string;
	readonly profileId?: string;
	readonly source?: AgentProfileSource;
	readonly phase?: CoreDiagnostic["phase"];
	readonly details?: Record<string, unknown>;
}): AgentProfileDiagnostic {
	return createDiagnostic({
		domain: "profile",
		code: options.code,
		severity: options.severity,
		disposition: options.severity === "error" ? "blocked" : "reported",
		recoverable: true,
		message: options.message,
		source: options.source
			? diagnosticSourceFromProfileSource(options.source, options.entryId)
			: options.profileId
				? { kind: "profile", id: options.profileId }
				: undefined,
		profileId: options.profileId,
		phase: options.phase ?? "load",
		details: {
			entryId: options.entryId,
			profileSource: options.source,
			...options.details,
		},
	});
}

function diagnosticSourceFromProfileSource(
	source: AgentProfileSource,
	entryId: string | undefined,
): DiagnosticSource {
	if (source.path) {
		return {
			kind: "path",
			path: source.path,
			label: source.label ?? source.kind,
		};
	}
	return {
		kind: "registry",
		name: "profile",
		key: entryId,
	};
}

function serializeProfile(profile: AgentProfile): string {
	const lines = [
		"---",
		`id: ${quoteFrontmatterString(profile.id)}`,
		`label: ${quoteFrontmatterString(profile.label)}`,
		`persist: ${profile.persist ? "true" : "false"}`,
	];
	if (profile.description) {
		lines.push(`description: ${quoteFrontmatterString(profile.description)}`);
	}
	if (profile.tools) {
		lines.push(`tools: ${serializeStringArray(profile.tools)}`);
	}
	if (profile.skills) {
		lines.push(`skills: ${serializeStringArray(profile.skills)}`);
	}
	if (profile.promptTemplates) {
		lines.push(
			`prompt-templates: ${serializeStringArray(profile.promptTemplates)}`,
		);
	}
	if (profile.extensions) {
		lines.push(`extensions: ${serializeStringArray(profile.extensions)}`);
	}
	if (profile.missingExtensionSeverity) {
		lines.push(
			`missing-extension-severity: ${profile.missingExtensionSeverity}`,
		);
	}
	if (profile.capabilities) {
		lines.push("capabilities:");
		for (const [key, value] of Object.entries(profile.capabilities)) {
			if (value !== undefined) lines.push(`  ${key}: ${value}`);
		}
	}
	lines.push("---", profile.systemPrompt);
	return lines.join("\n");
}

function serializeStringArray(values: readonly string[]): string {
	return `[${values.map(quoteFrontmatterString).join(", ")}]`;
}

function quoteFrontmatterString(value: string): string {
	return JSON.stringify(value);
}

function unquote(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function basenameEnvPath(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const slashIndex = normalized.lastIndexOf("/");
	return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

function formatSource(source: AgentProfileSource): string {
	return source.label ?? source.path ?? source.kind;
}

async function joinPathOrThrow(
	executionEnv: ExecutionEnv,
	parts: readonly string[],
): Promise<string> {
	const result = await executionEnv.joinPath([...parts]);
	if (!result.ok) {
		throw result.error;
	}
	return result.value;
}
