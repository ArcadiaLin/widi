import type {
	ExecutionEnv,
	FileError,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
	AgentOrchestrator,
	type AgentOrchestratorConfigs,
} from "./agent-orchestrator.js";
import {
	AgentProfileRegistry,
	type AgentProfileSource,
	createBuiltinProfileStorageBackend,
	createDefaultProfileRoots,
	type FileProfileRoot,
	FileProfileStorageBackend,
	type ProfileStorageBackend,
	type ProfileStorageListResult,
	type ProfileStorageReadResult,
} from "./agent-profile.js";
import { AuthStorage } from "./auth-storage.js";
import {
	DEFAULT_AGENT_DIR,
	DEFAULT_AGENT_PERSISTENCE_DIR,
	DEFAULT_MODELSJSON_PATH,
} from "./constants.js";
import {
	type CoreDiagnostic,
	createDiagnostic,
	OrchestratorError,
} from "./diagnostics.ts";
import {
	type ExtensionDiscoveryResult,
	type ExtensionLoadAvailableResult,
	ExtensionLoader,
	type ExtensionModuleImporter,
	type ExtensionRoot,
} from "./extension/index.ts";
import {
	HumanRequestBroker,
	type HumanRequestHandler,
} from "./human-request.ts";
import { ModelRegistry } from "./model-registry.js";
import {
	createProjectExtensionTrustDiagnostics,
	type ProjectTrustResolution,
	ProjectTrustStore,
	resolveProjectTrust,
} from "./project-trust.js";
import { ConfigValueResolver } from "./resolve-config-value.js";
import { ResourceLoader, type ResourceRoot } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingManager } from "./setting-manager.js";
import { ToolRegistry } from "./tool-registry.ts";
import { registerCoreCodingTools } from "./tools/coding/builtin.ts";
import { registerCoreInteractionTools } from "./tools/interaction/builtin.ts";
import { registerCoreJobTools } from "./tools/jobs/builtin.ts";
import type { RuntimeModel } from "./types.ts";

export interface CreateWidiRuntimeOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly projectConfigDir?: string;
	readonly executionEnv?: ExecutionEnv;
	readonly trustOverride?: boolean;
	readonly requestHuman?: HumanRequestHandler;
	readonly sessionRoot?: string;
	readonly defaultProfileId?: string;
	readonly defaultModel?: RuntimeModel;
	readonly defaultThinkingLevel?: ThinkingLevel;
	readonly enabledProfileIds?: readonly string[];
	readonly toolRegistry?: ToolRegistry;
	readonly extensionLoader?: ExtensionLoader;
	readonly extensionModuleImporter?: ExtensionModuleImporter;
}

export type RuntimeDefaultProfileSource =
	| "runtime_override"
	| "settings"
	| "builtin_fallback";
export type RuntimeDefaultModelSource =
	| "runtime_override"
	| "settings"
	| "available_fallback";
export type RuntimeDefaultThinkingLevelSource =
	| "runtime_override"
	| "settings"
	| "builtin_fallback";

export interface RuntimeDefaultProfileResolution {
	readonly id: string;
	readonly source: RuntimeDefaultProfileSource;
	readonly profileSource: AgentProfileSource;
}

export interface RuntimeDefaultModelResolution {
	readonly provider: string;
	readonly modelId: string;
	readonly source: RuntimeDefaultModelSource;
}

export interface RuntimeDefaultThinkingLevelResolution {
	readonly level: ThinkingLevel;
	readonly requestedLevel: ThinkingLevel;
	readonly source: RuntimeDefaultThinkingLevelSource;
	readonly clamped: boolean;
}

export interface WidiRuntimeServices {
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectConfigDir: string;
	readonly sessionRoot: string;
	readonly projectTrust: ProjectTrustResolution;
	readonly profileRoots: readonly FileProfileRoot[];
	readonly defaultProfile: RuntimeDefaultProfileResolution;
	readonly defaultModel: RuntimeDefaultModelResolution;
	readonly defaultThinkingLevel: RuntimeDefaultThinkingLevelResolution;
	readonly extensionDiscovery: ExtensionDiscoveryResult;
	readonly extensionLoad: ExtensionLoadAvailableResult;
	readonly executionEnv: ExecutionEnv;
	readonly settingManager: SettingManager;
	readonly configValueResolver: ConfigValueResolver;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly profileRegistry: AgentProfileRegistry;
	readonly resourceLoader: ResourceLoader;
	readonly sessionManager: SessionManager;
	readonly toolRegistry: ToolRegistry;
	readonly extensionLoader: ExtensionLoader;
}

export interface WidiRuntime {
	readonly services: WidiRuntimeServices;
	readonly orchestrator: AgentOrchestrator;
	readonly diagnostics: readonly CoreDiagnostic[];
}

function fileSystemValueOrThrow<TValue>(
	result: { ok: true; value: TValue } | { ok: false; error: FileError },
): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

class CompositeProfileStorageBackend implements ProfileStorageBackend {
	private readonly backends: readonly ProfileStorageBackend[];
	private readonly entries = new Map<string, ProfileStorageBackend>();

	constructor(backends: readonly ProfileStorageBackend[]) {
		this.backends = [...backends];
	}

	async listEntries(): Promise<ProfileStorageListResult> {
		this.entries.clear();
		const entries: ProfileStorageListResult["entries"] = [];
		const diagnostics: ProfileStorageListResult["diagnostics"] = [];

		for (const backend of this.backends) {
			const result = await backend.listEntries();
			entries.push(...result.entries);
			diagnostics.push(...result.diagnostics);
			for (const entry of result.entries) {
				this.entries.set(entry.entryId, backend);
			}
		}

		return { entries, diagnostics };
	}

	async readEntry(entryId: string): Promise<ProfileStorageReadResult> {
		const backend = this.entries.get(entryId);
		if (!backend) {
			return {
				ok: false,
				diagnostic: createDiagnostic({
					domain: "profile",
					code: "profile.read_failed",
					severity: "error",
					disposition: "degraded",
					recoverable: true,
					message: `Unknown profile storage entry: ${entryId}`,
					phase: "load",
				}),
			};
		}
		return await backend.readEntry(entryId);
	}
}

async function joinPath(
	executionEnv: ExecutionEnv,
	parts: readonly string[],
): Promise<string> {
	return fileSystemValueOrThrow(await executionEnv.joinPath([...parts]));
}

async function absolutePath(
	executionEnv: ExecutionEnv,
	path: string,
): Promise<string> {
	return fileSystemValueOrThrow(await executionEnv.absolutePath(path));
}

async function resolveSettingsPaths(
	executionEnv: ExecutionEnv,
	paths: readonly string[],
): Promise<ResourceRoot[]> {
	return await Promise.all(
		paths.map(async (path) => ({
			kind: "settings" as const,
			path: await absolutePath(executionEnv, path),
		})),
	);
}

async function createResourceRoots(options: {
	readonly executionEnv: ExecutionEnv;
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectConfigDir: string;
	readonly projectTrusted: boolean;
	readonly settingsPaths: readonly string[];
}): Promise<ResourceRoot[]> {
	return [
		...(await resolveSettingsPaths(
			options.executionEnv,
			options.settingsPaths,
		)),
		...(options.projectTrusted
			? [
					{
						kind: "cwd" as const,
						path: options.cwd,
					},
				]
			: []),
		{
			kind: "agent_dir" as const,
			path: options.agentDir,
		},
	];
}

async function createExtensionRoots(options: {
	readonly executionEnv: ExecutionEnv;
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectConfigDir: string;
	readonly projectTrusted: boolean;
	readonly settingsPaths: readonly string[];
}): Promise<ExtensionRoot[]> {
	const settingsRoots = await Promise.all(
		options.settingsPaths.map(async (path) => ({
			kind: "settings" as const,
			path: await absolutePath(options.executionEnv, path),
		})),
	);
	return [
		...settingsRoots,
		...(options.projectTrusted
			? [
					{
						kind: "cwd" as const,
						path: await joinPath(options.executionEnv, [
							options.cwd,
							options.projectConfigDir,
							"extensions",
						]),
					},
				]
			: []),
		{
			kind: "agent_dir" as const,
			path: await joinPath(options.executionEnv, [
				options.agentDir,
				"extensions",
			]),
		},
	];
}

async function createProfileRegistry(options: {
	readonly executionEnv: ExecutionEnv;
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectTrusted: boolean;
}): Promise<{
	readonly registry: AgentProfileRegistry;
	readonly roots: readonly FileProfileRoot[];
}> {
	const roots = await createDefaultProfileRoots({
		executionEnv: options.executionEnv,
		cwd: options.cwd,
		agentDir: options.agentDir,
	});
	const trustedRoots = options.projectTrusted
		? roots
		: roots.filter((root) => root.kind !== "cwd");
	return {
		registry: new AgentProfileRegistry(
			new CompositeProfileStorageBackend([
				new FileProfileStorageBackend(options.executionEnv, trustedRoots),
				createBuiltinProfileStorageBackend(),
			]),
		),
		roots: trustedRoots,
	};
}

/**
 * Interactive half of the "ask" trust policy: runs the fixed confirm request
 * through the human-request machinery so clients see the usual envelope.
 * Failures (no handler, abort, timeout) leave the project untrusted; the
 * broker's diagnostic is forwarded to the startup diagnostics.
 */
async function confirmProjectTrustViaHumanRequest(options: {
	readonly cwd: string;
	readonly requestHuman: HumanRequestHandler;
	readonly publishDiagnostic: (diagnostic: CoreDiagnostic) => Promise<void>;
}): Promise<boolean> {
	const broker = new HumanRequestBroker({
		findHumanRequestHandler: () => options.requestHuman,
		// No orchestrator event bus exists this early; request events go nowhere.
		emit: async () => {},
		publishDiagnostic: options.publishDiagnostic,
		recordAgentLifecycleFailure: async () => {},
	});
	try {
		const response = await broker.request({
			source: { kind: "system" },
			kind: "confirm",
			title: "Trust this project?",
			message: `WIDI found project-local configuration in ${options.cwd} (settings, profiles, skills, prompts, extensions). It stays disabled until the project is trusted.\n\nTrust this project and remember the decision?`,
		});
		return response.kind === "confirm" && response.confirmed;
	} catch {
		// The broker already published a diagnostic; stay untrusted.
		return false;
	}
}

async function resolveDefaultProfileId(options: {
	readonly profileRegistry: AgentProfileRegistry;
	readonly explicitDefaultProfileId?: string;
	readonly settingsDefaultProfileId?: string;
}): Promise<{
	readonly resolution: RuntimeDefaultProfileResolution;
	readonly diagnostics: readonly CoreDiagnostic[];
}> {
	const profileId =
		options.explicitDefaultProfileId ??
		options.settingsDefaultProfileId ??
		"default";
	const source: RuntimeDefaultProfileSource =
		options.explicitDefaultProfileId !== undefined
			? "runtime_override"
			: options.settingsDefaultProfileId !== undefined
				? "settings"
				: "builtin_fallback";
	const result = await options.profileRegistry.resolveProfile(profileId);
	if (!result.ok) {
		throw new OrchestratorError(
			createDiagnostic({
				domain: "profile",
				code: "profile.default_resolution_failed",
				severity: "error",
				disposition: "blocked",
				recoverable: true,
				message: `Cannot resolve default profile ${profileId}: ${result.reason}.`,
				source: { kind: "profile", id: profileId },
				phase: "resolve",
				profileId,
				details: { defaultSource: source },
			}),
		);
	}
	const resolution: RuntimeDefaultProfileResolution = {
		id: result.profile.id,
		source,
		profileSource: result.source,
	};
	return {
		resolution,
		diagnostics: [
			...result.diagnostics,
			createDefaultProfileResolvedDiagnostic(resolution),
		],
	};
}

function createDefaultProfileResolvedDiagnostic(
	resolution: RuntimeDefaultProfileResolution,
): CoreDiagnostic {
	return createDiagnostic({
		domain: "profile",
		code: "profile.default_resolved",
		severity: "info",
		disposition: "reported",
		recoverable: true,
		message: `Default profile resolved to ${resolution.id} from ${resolution.source}.`,
		source: { kind: "profile", id: resolution.id },
		phase: "resolve",
		profileId: resolution.id,
		details: {
			defaultSource: resolution.source,
			profileSource: resolution.profileSource,
		},
	});
}

async function resolveDefaultModel(options: {
	readonly modelRegistry: ModelRegistry;
	readonly settingManager: SettingManager;
	readonly explicitDefaultModel?: RuntimeModel;
}): Promise<{
	readonly model: RuntimeModel;
	readonly resolution: RuntimeDefaultModelResolution;
	readonly diagnostic: CoreDiagnostic;
}> {
	if (options.explicitDefaultModel) {
		const resolution: RuntimeDefaultModelResolution = {
			provider: options.explicitDefaultModel.provider,
			modelId: options.explicitDefaultModel.id,
			source: "runtime_override",
		};
		return {
			model: options.explicitDefaultModel,
			resolution,
			diagnostic: createDefaultModelResolvedDiagnostic(resolution),
		};
	}

	const defaultProvider = options.settingManager.getDefaultProvider();
	const defaultModelId = options.settingManager.getDefaultModel();
	if (defaultProvider && defaultModelId) {
		const model = options.modelRegistry.find(defaultProvider, defaultModelId);
		if (model && (await options.modelRegistry.hasConfiguredAuth(model))) {
			const resolution: RuntimeDefaultModelResolution = {
				provider: model.provider,
				modelId: model.id,
				source: "settings",
			};
			return {
				model,
				resolution,
				diagnostic: createDefaultModelResolvedDiagnostic(resolution),
			};
		}
		throw new OrchestratorError(
			createDiagnostic({
				domain: "model",
				code: "model.default_unavailable",
				severity: "error",
				disposition: "blocked",
				recoverable: true,
				message: `Default model is unavailable: ${defaultProvider}/${defaultModelId}.`,
				source: {
					kind: "registry",
					name: "model",
					key: `${defaultProvider}/${defaultModelId}`,
				},
				phase: "resolve",
				provider: defaultProvider,
				modelId: defaultModelId,
				details: { defaultSource: "settings" },
			}),
		);
	}

	const [availableModel] = await options.modelRegistry.getAvailable();
	if (availableModel) {
		const resolution: RuntimeDefaultModelResolution = {
			provider: availableModel.provider,
			modelId: availableModel.id,
			source: "available_fallback",
		};
		return {
			model: availableModel,
			resolution,
			diagnostic: createDefaultModelResolvedDiagnostic(resolution),
		};
	}

	throw new OrchestratorError(
		createDiagnostic({
			domain: "model",
			code: "model.default_missing",
			severity: "error",
			disposition: "blocked",
			recoverable: true,
			message:
				"No configured model is available. Configure auth or pass an explicit default model.",
			source: { kind: "registry", name: "model" },
			phase: "resolve",
		}),
	);
}

function createDefaultModelResolvedDiagnostic(
	resolution: RuntimeDefaultModelResolution,
): CoreDiagnostic {
	return createDiagnostic({
		domain: "model",
		code: "model.default_resolved",
		severity: "info",
		disposition: "reported",
		recoverable: true,
		message: `Default model resolved to ${resolution.provider}/${resolution.modelId} from ${resolution.source}.`,
		source: {
			kind: "registry",
			name: "model",
			key: `${resolution.provider}/${resolution.modelId}`,
		},
		phase: "resolve",
		provider: resolution.provider,
		modelId: resolution.modelId,
		details: { defaultSource: resolution.source },
	});
}

const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

function resolveDefaultThinkingLevel(options: {
	readonly model: RuntimeModel;
	readonly explicitDefaultThinkingLevel?: ThinkingLevel;
	readonly settingsDefaultThinkingLevel?: ThinkingLevel;
}): {
	readonly resolution: RuntimeDefaultThinkingLevelResolution;
	readonly diagnostic: CoreDiagnostic;
} {
	const requestedLevel =
		options.explicitDefaultThinkingLevel ??
		options.settingsDefaultThinkingLevel ??
		DEFAULT_THINKING_LEVEL;
	const source: RuntimeDefaultThinkingLevelSource =
		options.explicitDefaultThinkingLevel !== undefined
			? "runtime_override"
			: options.settingsDefaultThinkingLevel !== undefined
				? "settings"
				: "builtin_fallback";
	const level = clampThinkingLevel(
		options.model,
		requestedLevel,
	) as ThinkingLevel;
	const resolution: RuntimeDefaultThinkingLevelResolution = {
		level,
		requestedLevel,
		source,
		clamped: level !== requestedLevel,
	};
	return {
		resolution,
		diagnostic: createDefaultThinkingLevelResolvedDiagnostic(resolution),
	};
}

function createDefaultThinkingLevelResolvedDiagnostic(
	resolution: RuntimeDefaultThinkingLevelResolution,
): CoreDiagnostic {
	return createDiagnostic({
		domain: "model",
		code: "model.default_thinking_level_resolved",
		severity: "info",
		disposition: "reported",
		recoverable: true,
		message: `Default thinking level resolved to ${resolution.level} from ${resolution.source}.`,
		source: { kind: "registry", name: "model", key: "thinkingLevel" },
		phase: "resolve",
		details: {
			defaultSource: resolution.source,
			level: resolution.level,
			requestedLevel: resolution.requestedLevel,
			clamped: resolution.clamped,
		},
	});
}

export async function createWidiRuntime(
	options: CreateWidiRuntimeOptions,
): Promise<WidiRuntime> {
	const executionEnv =
		options.executionEnv ?? new NodeExecutionEnv({ cwd: options.cwd });
	const cwd = await absolutePath(executionEnv, options.cwd);
	const agentDir = await absolutePath(
		executionEnv,
		options.agentDir ?? DEFAULT_AGENT_DIR,
	);
	const projectConfigDir = options.projectConfigDir ?? DEFAULT_AGENT_DIR;

	const globalSettingManager = await SettingManager.create(executionEnv, {
		cwd,
		agentDir,
		projectConfigDir,
		projectTrusted: false,
	});
	const trustStore = new ProjectTrustStore({ executionEnv, agentDir });
	const defaultProjectTrust = globalSettingManager.getDefaultProjectTrust();
	const trustPromptDiagnostics: CoreDiagnostic[] = [];
	let projectTrust = await resolveProjectTrust({
		cwd,
		executionEnv,
		trustStore,
		trustOverride: options.trustOverride,
		defaultProjectTrust,
		projectConfigDir,
	});
	if (
		!projectTrust.trusted &&
		projectTrust.source === "settings_default" &&
		(defaultProjectTrust ?? "ask") === "ask" &&
		options.requestHuman !== undefined
	) {
		// "ask" genuinely asks: a confirmed prompt persists the decision and
		// re-resolves so every loader below sees the project as trusted.
		const confirmed = await confirmProjectTrustViaHumanRequest({
			cwd,
			requestHuman: options.requestHuman,
			publishDiagnostic: async (diagnostic) => {
				trustPromptDiagnostics.push(diagnostic);
			},
		});
		if (confirmed) {
			await trustStore.set(cwd, true);
			projectTrust = await resolveProjectTrust({
				cwd,
				executionEnv,
				trustStore,
				trustOverride: options.trustOverride,
				defaultProjectTrust,
				projectConfigDir,
			});
		}
	}
	const projectExtensionTrustDiagnostics =
		await createProjectExtensionTrustDiagnostics({
			executionEnv,
			cwd,
			projectConfigDir,
			projectTrusted: projectTrust.trusted,
		});

	const settingManager = await SettingManager.create(executionEnv, {
		cwd,
		agentDir,
		projectConfigDir,
		projectTrusted: projectTrust.trusted,
	});
	const configValueResolver = new ConfigValueResolver(executionEnv);
	const authStorage = AuthStorage.create(
		executionEnv,
		{
			configValueResolver,
		},
		await joinPath(executionEnv, [agentDir, "auth.json"]),
	);
	const modelRegistry = await ModelRegistry.create({
		executionEnv,
		authStorage,
		configValueResolver,
		modelsJsonPath: await joinPath(executionEnv, [
			agentDir,
			DEFAULT_MODELSJSON_PATH,
		]),
	});
	const profileRegistryResult = await createProfileRegistry({
		executionEnv,
		cwd,
		agentDir,
		projectTrusted: projectTrust.trusted,
	});
	const profileRegistry = profileRegistryResult.registry;
	const defaultProfile = await resolveDefaultProfileId({
		profileRegistry,
		explicitDefaultProfileId: options.defaultProfileId,
		settingsDefaultProfileId: settingManager.getDefaultProfile(),
	});
	const defaultModel = await resolveDefaultModel({
		modelRegistry,
		settingManager,
		explicitDefaultModel: options.defaultModel,
	});
	const defaultThinkingLevel = resolveDefaultThinkingLevel({
		model: defaultModel.model,
		explicitDefaultThinkingLevel: options.defaultThinkingLevel,
		settingsDefaultThinkingLevel: settingManager.getDefaultThinkingLevel(),
	});
	const sessionRoot = await absolutePath(
		executionEnv,
		options.sessionRoot ??
			settingManager.getSessionDir() ??
			(await joinPath(executionEnv, [agentDir, DEFAULT_AGENT_PERSISTENCE_DIR])),
	);
	const skillRoots = await createResourceRoots({
		executionEnv,
		cwd,
		agentDir,
		projectConfigDir,
		projectTrusted: projectTrust.trusted,
		settingsPaths: settingManager.getSkillPaths(),
	});
	const promptTemplateRoots = await createResourceRoots({
		executionEnv,
		cwd,
		agentDir,
		projectConfigDir,
		projectTrusted: projectTrust.trusted,
		settingsPaths: settingManager.getPromptTemplatePaths(),
	});
	const resourceLoader = new ResourceLoader({
		executionEnv,
		cwd,
		agentDir,
		skillRoots,
		promptTemplateRoots,
	});
	const sessionManager = new SessionManager({
		fs: executionEnv,
		cwd,
		sessionsRoot: sessionRoot,
	});
	const extensionLoader =
		options.extensionLoader ??
		new ExtensionLoader({
			moduleImporter: options.extensionModuleImporter,
			roots: await createExtensionRoots({
				executionEnv,
				cwd,
				agentDir,
				projectConfigDir,
				projectTrusted: projectTrust.trusted,
				settingsPaths: settingManager.getExtensionPaths(),
			}),
		});
	const extensionLoad =
		await extensionLoader.loadAvailableExtensions(executionEnv);
	const extensionDiscovery = extensionLoad.discovery;
	const toolRegistry = options.toolRegistry ?? new ToolRegistry();
	const imageSettings = settingManager.getImageSettings();
	registerCoreCodingTools(toolRegistry, cwd, {
		shellPath: settingManager.getShellPath(),
		shellCommandPrefix: settingManager.getShellCommandPrefix(),
		rgPath: settingManager.getRgPath(),
		autoResizeImages: imageSettings.autoResize,
		blockImages: imageSettings.blockImages,
	});
	registerCoreInteractionTools(toolRegistry);
	registerCoreJobTools(toolRegistry);
	const orchestratorConfig: AgentOrchestratorConfigs = {
		executionEnv,
		resourceLoader,
		sessionManager,
		settingManager,
		modelRegistry,
		profileRegistry,
		toolRegistry,
		extensionLoader,
		defaultProfileId: defaultProfile.resolution.id,
		enabledProfileIds:
			options.enabledProfileIds ?? settingManager.getEnabledProfiles(),
		defaultModel: defaultModel.model,
		defaultThinkingLevel: defaultThinkingLevel.resolution.level,
	};
	const orchestrator = new AgentOrchestrator(orchestratorConfig);
	const services: WidiRuntimeServices = {
		cwd,
		agentDir,
		projectConfigDir,
		sessionRoot,
		projectTrust,
		profileRoots: profileRegistryResult.roots,
		defaultProfile: defaultProfile.resolution,
		defaultModel: defaultModel.resolution,
		defaultThinkingLevel: defaultThinkingLevel.resolution,
		extensionDiscovery,
		extensionLoad,
		executionEnv,
		settingManager,
		configValueResolver,
		authStorage,
		modelRegistry,
		profileRegistry,
		resourceLoader,
		sessionManager,
		toolRegistry,
		extensionLoader,
	};
	const diagnostics = [
		...globalSettingManager.drainDiagnostics(),
		...(projectTrust.diagnostic ? [projectTrust.diagnostic] : []),
		...trustPromptDiagnostics,
		...settingManager.drainDiagnostics(),
		...authStorage.drainDiagnostics(),
		...modelRegistry.drainDiagnostics(),
		...defaultProfile.diagnostics,
		defaultModel.diagnostic,
		defaultThinkingLevel.diagnostic,
		...projectExtensionTrustDiagnostics,
		...extensionLoad.diagnostics,
	];

	return {
		services,
		orchestrator,
		diagnostics,
	};
}
