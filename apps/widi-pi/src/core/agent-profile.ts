import type { ExecutionEnv, FileInfo } from "@earendil-works/pi-agent-core";
import { DEFAULT_AGENT_DIR } from "./constants/config.js";
import {
	DEFAULT_PROFILE_DIR,
	DEFAULT_PROFILE_FILE_EXTENSION,
} from "./constants/resource.js";

export type AgentProfile = {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly systemPrompt: string;
	/** Whether the agent's state should be persisted. */
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
	};
};

export type AgentProfileMissingExtensionSeverity =
	| "ignore"
	| "warning"
	| "error";

export type AgentProfileReference = {
	readonly id: string;
	readonly label?: string;
};

export type AgentProfileDiagnosticCode =
	| "file_info_failed"
	| "list_failed"
	| "read_failed"
	| "parse_failed"
	| "invalid_metadata";

/** Warning produced while loading agent profiles. */
export type AgentProfileDiagnostic = {
	/** Diagnostic severity. Currently only warnings are emitted. */
	readonly type: "warning";
	/** Stable diagnostic code. */
	readonly code: AgentProfileDiagnosticCode;
	/** Human-readable diagnostic message. */
	readonly message: string;
	/** Path associated with the diagnostic. */
	readonly path: string;
	readonly source: AgentProfileSource;
};

export type AgentProfileSource =
	| { readonly kind: "agent_dir"; readonly path: string }
	| { readonly kind: "cwd"; readonly path: string }
	| { readonly kind: "path"; readonly path: string };

export type SourcedAgentProfile = {
	readonly profile: AgentProfile;
	readonly source: AgentProfileSource;
};

export interface AgentProfileLoaderOptions {
	readonly executionEnv: ExecutionEnv;
	readonly cwd: string;
	readonly agentDir?: string;
}

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
	readonly missingExtensionSeverity?: unknown;
	readonly "missing-extension-severity"?: unknown;
	readonly [key: string]: unknown;
};

export function toAgentProfileReference(
	profile: Pick<AgentProfile, "id" | "label">,
): AgentProfileReference {
	return {
		id: profile.id,
		label: profile.label,
	};
}

export class AgentProfileLoader {
	private readonly _executionEnv: ExecutionEnv;
	private readonly _cwd: string;
	private readonly _agentDir: string;

	constructor(options: AgentProfileLoaderOptions) {
		this._executionEnv = options.executionEnv;
		this._cwd = options.cwd;
		this._agentDir = options.agentDir ?? DEFAULT_AGENT_DIR;
	}

	/**
	 * Expected usage: `loadProfiles(profileNames)`.
	 * Empty or missing names load every markdown profile under each `.widi/profiles` root.
	 */
	async loadProfiles(
		profileNames: readonly string[] = [],
		profileDir: string = DEFAULT_PROFILE_DIR,
	): Promise<{
		profiles: SourcedAgentProfile[];
		diagnostics: AgentProfileDiagnostic[];
	}> {
		return await this._loadSourcedPaths(
			await this._resolveProfileNames(profileDir, profileNames),
		);
	}

	async loadProfile(profileName: string): Promise<{
		profile: AgentProfile | undefined;
		diagnostics: AgentProfileDiagnostic[];
	}> {
		const result = await this.loadProfiles([profileName]);
		return {
			profile: result.profiles[0]?.profile,
			diagnostics: result.diagnostics,
		};
	}

	/**
	 * Load markdown profile files from explicit files or direct children of directories.
	 */
	async loadProfilesFromPaths(paths: string | readonly string[]): Promise<{
		profiles: SourcedAgentProfile[];
		diagnostics: AgentProfileDiagnostic[];
	}> {
		return await this._loadSourcedPaths(
			(Array.isArray(paths) ? paths : [paths]).map((path) => ({
				path,
				source: { kind: "path", path },
			})),
		);
	}

	async loadProfileFromPath(path: string): Promise<{
		profile: AgentProfile | undefined;
		diagnostics: AgentProfileDiagnostic[];
	}> {
		const result = await this.loadProfilesFromPaths(path);
		return {
			profile: result.profiles[0]?.profile,
			diagnostics: result.diagnostics,
		};
	}

	private async _loadSourcedPaths(
		paths: Array<{ path: string; source: AgentProfileSource }>,
	): Promise<{
		profiles: SourcedAgentProfile[];
		diagnostics: AgentProfileDiagnostic[];
	}> {
		const profiles: SourcedAgentProfile[] = [];
		const diagnostics: AgentProfileDiagnostic[] = [];

		for (const { path, source } of paths) {
			const result = await this._loadPath(path, source);
			profiles.push(...result.profiles);
			diagnostics.push(...result.diagnostics);
		}

		return { profiles, diagnostics };
	}

	private async _loadPath(
		path: string,
		source: AgentProfileSource,
	): Promise<{
		profiles: SourcedAgentProfile[];
		diagnostics: AgentProfileDiagnostic[];
	}> {
		const infoResult = await this._executionEnv.fileInfo(path);
		if (!infoResult.ok) {
			if (infoResult.error.code === "not_found") {
				return { profiles: [], diagnostics: [] };
			}
			return {
				profiles: [],
				diagnostics: [
					{
						type: "warning",
						code: "file_info_failed",
						message: infoResult.error.message,
						path,
						source,
					},
				],
			};
		}

		const kind = await this._resolveKind(infoResult.value);
		if (kind === "directory") {
			return await this._loadDirectory(infoResult.value.path, {
				...source,
				path: infoResult.value.path,
			});
		}
		if (kind === "file" && infoResult.value.name.endsWith(".md")) {
			const fileSource = { ...source, path: infoResult.value.path };
			const result = await this._loadFile(infoResult.value.path, fileSource);
			return {
				profiles: result.profile
					? [{ profile: result.profile, source: fileSource }]
					: [],
				diagnostics: result.diagnostics,
			};
		}

		return { profiles: [], diagnostics: [] };
	}

	private async _loadDirectory(
		path: string,
		source: AgentProfileSource,
	): Promise<{
		profiles: SourcedAgentProfile[];
		diagnostics: AgentProfileDiagnostic[];
	}> {
		const entriesResult = await this._executionEnv.listDir(path);
		if (!entriesResult.ok) {
			return {
				profiles: [],
				diagnostics: [
					{
						type: "warning",
						code: "list_failed",
						message: entriesResult.error.message,
						path,
						source,
					},
				],
			};
		}

		const profiles: SourcedAgentProfile[] = [];
		const diagnostics: AgentProfileDiagnostic[] = [];
		for (const entry of entriesResult.value.sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const kind = await this._resolveKind(entry);
			if (kind !== "file" || !entry.name.endsWith(".md")) continue;

			const fileSource = { ...source, path: entry.path };
			const result = await this._loadFile(entry.path, fileSource);
			if (result.profile) {
				profiles.push({ profile: result.profile, source: fileSource });
			}
			diagnostics.push(...result.diagnostics);
		}

		return { profiles, diagnostics };
	}

	private async _loadFile(
		path: string,
		source: AgentProfileSource,
	): Promise<{
		profile: AgentProfile | undefined;
		diagnostics: AgentProfileDiagnostic[];
	}> {
		const rawContent = await this._executionEnv.readTextFile(path);
		if (!rawContent.ok) {
			return {
				profile: undefined,
				diagnostics: [
					{
						type: "warning",
						code: "read_failed",
						message: rawContent.error.message,
						path,
						source,
					},
				],
			};
		}

		const parsed = parseProfileMarkdown(rawContent.value);
		if (!parsed.ok) {
			return {
				profile: undefined,
				diagnostics: [
					{
						type: "warning",
						code: "parse_failed",
						message: parsed.error,
						path,
						source,
					},
				],
			};
		}

		const { frontmatter, body } = parsed.value;
		const diagnostics: AgentProfileDiagnostic[] = [];
		const id =
			readString(frontmatter.id) ?? basenameEnvPath(path).replace(/\.md$/i, "");
		const label = readString(frontmatter.label) ?? id;
		const description = readString(frontmatter.description);
		const persist = readBoolean(frontmatter.persist) ?? false;
		const tools = readStringArray(frontmatter.tools);
		const skills = readStringArray(frontmatter.skills);
		const promptTemplates = readStringArray(
			frontmatter.promptTemplates ?? frontmatter["prompt-templates"],
		);
		const extensions = readStringArray(frontmatter.extensions);
		const missingExtensionSeverity = readMissingExtensionSeverity(
			frontmatter.missingExtensionSeverity ??
				frontmatter["missing-extension-severity"],
		);

		if (!id) {
			diagnostics.push({
				type: "warning",
				code: "invalid_metadata",
				message: "Profile id is missing.",
				path,
				source,
			});
			return { profile: undefined, diagnostics };
		}

		if (!body.trim()) {
			diagnostics.push({
				type: "warning",
				code: "invalid_metadata",
				message:
					"Profile markdown body is empty; systemPrompt will be empty until the schema is finalized.",
				path,
				source,
			});
		}

		return {
			profile: {
				id,
				label,
				description,
				systemPrompt: body,
				persist,
				tools,
				skills,
				promptTemplates,
				extensions,
				missingExtensionSeverity,
			},
			diagnostics,
		};
	}

	private async _resolveKind(
		info: FileInfo,
	): Promise<"file" | "directory" | undefined> {
		if (info.kind === "file" || info.kind === "directory") {
			return info.kind;
		}

		const canonicalPath = await this._executionEnv.canonicalPath(info.path);
		if (!canonicalPath.ok) {
			return undefined;
		}
		const target = await this._executionEnv.fileInfo(canonicalPath.value);
		if (!target.ok) {
			return undefined;
		}
		return target.value.kind === "file" || target.value.kind === "directory"
			? target.value.kind
			: undefined;
	}

	private async _resolveProfileNames(
		profileDirName: string,
		names: readonly string[],
	): Promise<Array<{ path: string; source: AgentProfileSource }>> {
		const roots = [
			...(this._agentDir
				? [{ kind: "agent_dir" as const, path: this._agentDir }]
				: []),
			{ kind: "cwd" as const, path: this._cwd },
		];
		const resolved: Array<{ path: string; source: AgentProfileSource }> = [];

		for (const root of roots) {
			const rootPath =
				root.kind === "cwd"
					? await this._joinPath(root.path, DEFAULT_AGENT_DIR)
					: root.path;
			const profileRoot = await this._joinPath(rootPath, profileDirName);
			const paths =
				names.length === 0
					? [profileRoot]
					: await Promise.all(
							names.map((name) =>
								this._joinPath(
									profileRoot,
									this._withFileExtension(name, DEFAULT_PROFILE_FILE_EXTENSION),
								),
							),
						);

			for (const path of paths) {
				resolved.push({ path, source: { kind: root.kind, path } });
			}
		}

		return resolved;
	}

	private _withFileExtension(name: string, extension: string): string {
		if (name.endsWith(extension)) {
			return name;
		}
		return `${name}${extension}`;
	}

	private async _joinPath(...parts: string[]): Promise<string> {
		const result = await this._executionEnv.joinPath(parts);
		if (!result.ok) {
			throw result.error;
		}
		return result.value;
	}
}

function parseProfileMarkdown(
	content: string,
):
	| { ok: true; value: { frontmatter: AgentProfileFrontmatter; body: string } }
	| { ok: false; error: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return { ok: true, value: { frontmatter: {}, body: normalized } };
	}

	const endIndex = normalized.indexOf("\n---", 4);
	if (endIndex === -1) {
		return {
			ok: false,
			error: "Profile frontmatter is missing a closing --- marker.",
		};
	}

	const frontmatter: Record<string, unknown> = {};
	const frontmatterText = normalized.slice(4, endIndex);
	for (const line of frontmatterText.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const separatorIndex = trimmed.indexOf(":");
		if (separatorIndex === -1) {
			return { ok: false, error: `Cannot parse frontmatter line: ${trimmed}` };
		}

		const key = trimmed.slice(0, separatorIndex).trim();
		const rawValue = trimmed.slice(separatorIndex + 1).trim();
		frontmatter[key] = parseSimpleFrontmatterValue(rawValue);
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

function readBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value
		.filter(
			(item): item is string =>
				typeof item === "string" && item.trim().length > 0,
		)
		.map((item) => item.trim());
	return items.length > 0 ? items : undefined;
}

function readMissingExtensionSeverity(
	value: unknown,
): AgentProfileMissingExtensionSeverity | undefined {
	if (value === "ignore" || value === "warning" || value === "error") {
		return value;
	}
	return undefined;
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
