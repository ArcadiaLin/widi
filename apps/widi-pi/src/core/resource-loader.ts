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
import { DEFAULT_AGENT_DIR } from "./constants/config.js";
import {
	DEFAULT_PROMPTTEMPLATE_DIR,
	DEFAULT_PROMPTtEMPALTE_FILE_EXTENSION,
	DEFAULT_SKILL_DIR,
} from "./constants/resource.js";

type ResourceSource =
	| { readonly kind: "agent_dir"; readonly path: string }
	| { readonly kind: "cwd"; readonly path: string }
	| { readonly kind: "settings"; readonly path: string };
// Future consider to support loading from third-party directories.
// | { readonly kind: "third_party"; readonly path: string; readonly root: string; readonly skillDir: string };

export interface ResourceRoot {
	readonly kind: "agent_dir" | "cwd" | "settings";
	readonly path: string;
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
	 * Expected usage: `loadPromptTemplates(profile.promptTemplates)`.
	 * Empty or missing names load every prompt template under each `.widi/prompt-templates` root.
	 */
	async loadSkills(
		skillName: readonly string[] = [],
		skillDir: string = DEFAULT_SKILL_DIR,
	): Promise<{
		skills: Array<{ skill: Skill; source: ResourceSource }>;
		diagnostics: Array<SkillDiagnostic & { source: ResourceSource }>;
	}> {
		return loadSourcedSkills(
			this._executionEnv,
			await this._resolveResourceNames(skillDir, skillName),
		);
	}

	/**
	 * Expected usage: `loadPromptTemplates(profile.promptTemplates)`.
	 * Empty or missing names load every prompt template under each `.widi/prompt-templates` root.
	 */
	async loadPromptTemplates(
		promptTemplateNames: readonly string[] = [],
	): Promise<{
		promptTemplates: Array<{
			promptTemplate: PromptTemplate;
			source: ResourceSource;
		}>;
		diagnostics: Array<PromptTemplateDiagnostic & { source: ResourceSource }>;
	}> {
		return loadSourcedPromptTemplates(
			this._executionEnv,
			await this._resolveResourceNames(
				DEFAULT_PROMPTTEMPLATE_DIR,
				promptTemplateNames,
				{
					fileExtension: DEFAULT_PROMPTtEMPALTE_FILE_EXTENSION,
				},
			),
		);
	}

	private async _resolveResourceNames(
		resourceDirName: string,
		names: readonly string[],
		options?: { fileExtension: string },
	): Promise<Array<{ path: string; source: ResourceSource }>> {
		const roots = this._getRoots(resourceDirName);
		const resolved: Array<{ path: string; source: ResourceSource }> = [];

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
			// Empty names mean "load the whole resource directory". Otherwise each name is resolved as a direct child.
			// future skill meybe support namespace like "namespace/skill_name", then we need to resolve each part of the path.
			const paths =
				names.length === 0
					? [resourceRoot]
					: await Promise.all(
							names.map((name) =>
								this._joinPath(
									resourceRoot,
									this._withFileExtension(name, options?.fileExtension),
								),
							),
						);

			for (const path of paths) {
				resolved.push({ path, source: { kind: root.kind, path: path } });
			}
		}

		return resolved;
	}

	private _getRoots(resourceDirName: string): readonly ResourceRoot[] {
		if (resourceDirName === DEFAULT_SKILL_DIR && this._skillRoots) {
			return this._skillRoots;
		}
		if (
			resourceDirName === DEFAULT_PROMPTTEMPLATE_DIR &&
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
