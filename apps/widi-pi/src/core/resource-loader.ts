import type {
	ExecutionEnv,
	PromptTemplate,
	PromptTemplateDiagnostic,
	Skill,
	SkillDiagnostic,
} from "@earendil-works/pi-agent-core";
import {
	loadSourcedPromptTemplates,
	loadSourcedSkills,
} from "@earendil-works/pi-agent-core";
import {
	DEFAULT_AGENT_DIR,
	DEFAULT_PROMPT_TEMPLATE_DIR,
	DEFAULT_PROMPT_TEMPLATE_FILE_EXTENSION,
	DEFAULT_SKILL_DIR,
} from "./constants.js";

export type ResourceSource =
	| { readonly kind: "agent_dir"; readonly path: string }
	| { readonly kind: "cwd"; readonly path: string }
	| { readonly kind: "settings"; readonly path: string };
// Future consider to support loading from third-party directories.
// | { readonly kind: "third_party"; readonly path: string; readonly root: string; readonly skillDir: string };

export interface ResourceRoot {
	readonly kind: "agent_dir" | "cwd" | "settings";
	readonly path: string;
}

/**
 * A resource a profile named explicitly that no root produced. Loading skips
 * missing paths silently, which is right for an absent resource directory but
 * hides a typo or a stale entry in a profile's own list.
 */
export interface MissingResourceDiagnostic {
	readonly type: "warning";
	readonly code: "not_found";
	readonly message: string;
	readonly path: string;
}

interface ResourceInput {
	readonly path: string;
	readonly source: ResourceSource;
	/** The profile-supplied name, absent when loading a whole root. */
	readonly name?: string;
}

export interface ResourceLoaderOptions {
	executionEnv: ExecutionEnv;
	cwd: string;
	agentDir?: string;
	skillRoots?: readonly ResourceRoot[];
	promptTemplateRoots?: readonly ResourceRoot[];
}

export class ResourceLoader {
	private readonly _executionEnv: ExecutionEnv;
	private readonly _cwd: string;
	private readonly _agentDir!: string;
	private readonly _skillRoots: readonly ResourceRoot[] | undefined;
	private readonly _promptTemplateRoots: readonly ResourceRoot[] | undefined;

	constructor(options: ResourceLoaderOptions) {
		this._executionEnv = options.executionEnv;
		this._cwd = options.cwd;
		this._agentDir = options.agentDir ?? DEFAULT_AGENT_DIR;
		this._skillRoots = options.skillRoots ? [...options.skillRoots] : undefined;
		this._promptTemplateRoots = options.promptTemplateRoots
			? [...options.promptTemplateRoots]
			: undefined;
	}

	getSkillRoots(): readonly ResourceRoot[] {
		return [...(this._skillRoots ?? [])];
	}

	getPromptTemplateRoots(): readonly ResourceRoot[] {
		return [...(this._promptTemplateRoots ?? [])];
	}

	/**
	 * Expected usage: `loadSkills(profile.skills)`.
	 * Empty or missing names load every skill under each `.widi/skills` root.
	 */
	async loadSkills(
		skillNames: readonly string[] = [],
		skillDir: string = DEFAULT_SKILL_DIR,
	): Promise<{
		skills: Array<{ skill: Skill; source: ResourceSource }>;
		diagnostics: Array<
			(SkillDiagnostic | MissingResourceDiagnostic) & {
				source: ResourceSource;
			}
		>;
	}> {
		const inputs = await this._resolveResourceNames(skillDir, skillNames);
		const loaded = await loadSourcedSkills(this._executionEnv, inputs);
		return {
			skills: loaded.skills,
			diagnostics: [
				...loaded.diagnostics,
				...missingNameDiagnostics(
					skillNames,
					inputs,
					loaded.skills.map(({ source }) => source),
				),
			],
		};
	}

	/**
	 * Expected usage: `loadPromptTemplates(profile.promptTemplates)`.
	 * Empty or missing names load every prompt template under each `.widi/prompts` root.
	 */
	async loadPromptTemplates(
		promptTemplateNames: readonly string[] = [],
	): Promise<{
		promptTemplates: Array<{
			promptTemplate: PromptTemplate;
			source: ResourceSource;
		}>;
		diagnostics: Array<
			(PromptTemplateDiagnostic | MissingResourceDiagnostic) & {
				source: ResourceSource;
			}
		>;
	}> {
		const inputs = await this._resolveResourceNames(
			DEFAULT_PROMPT_TEMPLATE_DIR,
			promptTemplateNames,
			{ fileExtension: DEFAULT_PROMPT_TEMPLATE_FILE_EXTENSION },
		);
		const loaded = await loadSourcedPromptTemplates(this._executionEnv, inputs);
		return {
			promptTemplates: loaded.promptTemplates,
			diagnostics: [
				...loaded.diagnostics,
				...missingNameDiagnostics(
					promptTemplateNames,
					inputs,
					loaded.promptTemplates.map(({ source }) => source),
				),
			],
		};
	}

	private async _resolveResourceNames(
		resourceDirName: string,
		names: readonly string[],
		options?: { fileExtension: string },
	): Promise<ResourceInput[]> {
		const roots = this._getRoots(resourceDirName);
		const resolved: ResourceInput[] = [];
		// The agent dir may itself be the cwd's .widi directory; without dedupe
		// every resource loads twice and appears as duplicate candidates.
		const seenRoots = new Set<string>();

		for (const root of roots) {
			// For "cwd", we load from a subdirectory (e.g. ".widi/skills") to avoid potential conflicts with user files. For "agent_dir", we load directly from the specified directory to allow flexible project structures.
			const resourceRoot =
				root.kind === "settings"
					? root.path
					: await this._joinPath(
							root.kind === "cwd"
								? await this._joinPath(root.path, DEFAULT_AGENT_DIR)
								: root.path,
							resourceDirName,
						);
			if (seenRoots.has(resourceRoot)) continue;
			seenRoots.add(resourceRoot);
			// Empty names mean "load the whole resource directory". Otherwise each name is resolved as a direct child.
			// future skill meybe support namespace like "namespace/skill_name", then we need to resolve each part of the path.
			const entries =
				names.length === 0
					? [{ path: resourceRoot, name: undefined }]
					: await Promise.all(
							names.map(async (name) => ({
								path: await this._joinPath(
									resourceRoot,
									this._withFileExtension(name, options?.fileExtension),
								),
								name,
							})),
						);

			for (const entry of entries) {
				resolved.push({
					path: entry.path,
					name: entry.name,
					source: { kind: root.kind, path: entry.path },
				});
			}
		}

		return resolved;
	}

	private _getRoots(resourceDirName: string): readonly ResourceRoot[] {
		if (resourceDirName === DEFAULT_SKILL_DIR && this._skillRoots) {
			return this._skillRoots;
		}
		if (
			resourceDirName === DEFAULT_PROMPT_TEMPLATE_DIR &&
			this._promptTemplateRoots
		) {
			return this._promptTemplateRoots;
		}
		return [
			...(this._agentDir
				? [{ kind: "agent_dir" as const, path: this._agentDir }]
				: []),
			{ kind: "cwd" as const, path: this._cwd },
		];
	}

	// extension name such as load prompttemplate from ".md" file
	private _withFileExtension(name: string, extension?: string): string {
		if (!extension || name.endsWith(extension)) {
			return name;
		}
		return `${name}${extension}`;
	}

	// private _withNamespace

	private async _joinPath(...parts: string[]): Promise<string> {
		const result = await this._executionEnv.joinPath(parts);
		if (!result.ok) {
			throw result.error;
		}
		return result.value;
	}
}

/**
 * Report every explicitly named resource that no root produced. A name is
 * tried once per root, so it only counts as missing when all of its candidate
 * paths came back empty. Loading a whole root (no names) reports nothing.
 */
function missingNameDiagnostics(
	names: readonly string[],
	inputs: readonly ResourceInput[],
	loadedSources: readonly ResourceSource[],
): Array<MissingResourceDiagnostic & { source: ResourceSource }> {
	if (names.length === 0) return [];
	const loadedPaths = new Set(loadedSources.map((source) => source.path));
	const diagnostics: Array<
		MissingResourceDiagnostic & { source: ResourceSource }
	> = [];
	for (const name of names) {
		const candidates = inputs.filter((input) => input.name === name);
		if (candidates.length === 0) continue;
		if (candidates.some((candidate) => loadedPaths.has(candidate.path))) {
			continue;
		}
		const tried = candidates.map((candidate) => candidate.path).join(", ");
		diagnostics.push({
			type: "warning",
			code: "not_found",
			message: `"${name}" was not found in any resource root (tried ${tried})`,
			path: candidates[0]?.path ?? name,
			source: candidates[0]?.source ?? { kind: "cwd", path: name },
		});
	}
	return diagnostics;
}
