import type {
	ExecutionEnv,
	FileError,
	FileInfo,
} from "@earendil-works/pi-agent-core";
import {
	type CoreDiagnostic,
	createDiagnostic,
	type DiagnosticDisposition,
	type DiagnosticSeverity,
} from "../diagnostics.ts";
import {
	EXTENSION_API_VERSION,
	isSupportedExtensionApiVersion,
	MIN_SUPPORTED_EXTENSION_API_VERSION,
} from "./api.ts";
import {
	type ExtensionModuleImporter,
	JitiExtensionModuleImporter,
} from "./module-importer.ts";
import type {
	ExtensionActivationApi,
	ExtensionDisposeHandler,
	ExtensionFactory,
	ExtensionInterceptorFor,
	ExtensionInterceptorName,
	ExtensionModule,
	ExtensionObservedEventName,
	ExtensionObserver,
	ExtensionProviderConfig,
	ToolDefinition,
	ToolDefinitionPatch,
	ToolSource,
} from "./types.ts";

type ExtensionToolDefinition = ToolDefinition;
type ExtensionToolDefinitionPatch = ToolDefinitionPatch;

export interface ExtensionProviderContribution {
	readonly extensionId: string;
	readonly providerName: string;
	readonly config: ExtensionProviderConfig;
}

export interface ExtensionObserverRegistration {
	extensionId: string;
	eventName: ExtensionObservedEventName;
	handler: ExtensionObserver;
}

export interface ExtensionInterceptorRegistration<
	TName extends ExtensionInterceptorName,
> {
	extensionId: string;
	eventName: TName;
	handler: ExtensionInterceptorFor<TName>;
}

export interface ExtensionDisposeRegistration {
	readonly extensionId: string;
	readonly handler: ExtensionDisposeHandler;
}

export interface LoadExtensionScopeOptions {
	agentId: string;
	profileId: string;
	extensionIds?: readonly string[];
	missingExtensionSeverity?: "ignore" | "warning" | "error";
}

export type ExtensionSource =
	| { readonly kind: "factory" }
	| {
			readonly kind: "file";
			readonly path: string;
			readonly resolvedPath: string;
			readonly root: ExtensionRoot;
	  }
	| {
			readonly kind: "package";
			readonly path: string;
			readonly resolvedPath: string;
			readonly entryPath: string;
			readonly root: ExtensionRoot;
	  };

export interface ExtensionIdentity {
	readonly id: string;
	readonly source: ExtensionSource;
}

export type ExtensionToolContribution =
	| {
			kind: "define";
			extensionId: string;
			definition: ExtensionToolDefinition;
			source: ToolSource;
	  }
	| {
			kind: "patch";
			extensionId: string;
			targetToolName: string;
			patch: ExtensionToolDefinitionPatch;
			source: ToolSource;
	  };

export interface ExtensionRoot {
	readonly kind: "agent_dir" | "cwd" | "settings";
	readonly path: string;
}

export type ExtensionDiscoveryCandidateKind = "directory" | "file";

export interface ExtensionDiscoveryCandidate {
	readonly id: string;
	readonly root: ExtensionRoot;
	readonly path: string;
	readonly kind: ExtensionDiscoveryCandidateKind;
}

export interface ExtensionDiscoveryResult {
	readonly roots: readonly ExtensionRoot[];
	readonly candidates: readonly ExtensionDiscoveryCandidate[];
	readonly diagnostics: readonly CoreDiagnostic[];
}

export interface ExtensionLoaderOptions {
	readonly roots?: readonly ExtensionRoot[];
	readonly moduleImporter?: ExtensionModuleImporter;
}

export interface ExtensionLoadAvailableResult {
	readonly discovery: ExtensionDiscoveryResult;
	readonly loaded: readonly ExtensionIdentity[];
	readonly diagnostics: readonly CoreDiagnostic[];
}

export interface LoadedExtensionScope {
	agentId: string;
	profileId: string;
	extensionIds: readonly string[];
	extensions: readonly ExtensionIdentity[];
	diagnostics: readonly CoreDiagnostic[];
	toolContributions: readonly ExtensionToolContribution[];
	providerContributions: readonly ExtensionProviderContribution[];
	observerHandlers: ReadonlyMap<
		ExtensionObservedEventName,
		readonly ExtensionObserverRegistration[]
	>;
	interceptorHandlers: ReadonlyMap<
		ExtensionInterceptorName,
		readonly ExtensionInterceptorRegistration<ExtensionInterceptorName>[]
	>;
	disposeHandlers: readonly ExtensionDisposeRegistration[];
}

interface IncompatibleExtensionRecord {
	readonly identity: ExtensionIdentity;
	readonly declaredApiVersion: number;
	readonly fromModule: boolean;
}

export class ExtensionLoader {
	private readonly _factories = new Map<string, ExtensionFactory>();
	private readonly _factoryIdentities = new Map<string, ExtensionIdentity>();
	private readonly _incompatible = new Map<
		string,
		IncompatibleExtensionRecord
	>();
	private readonly _moduleFactories = new Map<string, ExtensionFactory>();
	private readonly _moduleImporter: ExtensionModuleImporter;
	private readonly _roots: readonly ExtensionRoot[];

	constructor(options: ExtensionLoaderOptions = {}) {
		this._roots = options.roots ? [...options.roots] : [];
		this._moduleImporter =
			options.moduleImporter ?? new JitiExtensionModuleImporter();
	}

	getRoots(): readonly ExtensionRoot[] {
		return [...this._roots];
	}

	async discover(
		executionEnv: ExecutionEnv,
	): Promise<ExtensionDiscoveryResult> {
		const candidates: ExtensionDiscoveryCandidate[] = [];
		const diagnostics: CoreDiagnostic[] = [];

		for (const root of this._roots) {
			const infoResult = await executionEnv.fileInfo(root.path);
			if (!infoResult.ok) {
				if (infoResult.error.code === "not_found" && root.kind !== "settings") {
					continue;
				}
				diagnostics.push(
					createExtensionDiscoveryDiagnostic({
						code:
							infoResult.error.code === "not_found"
								? "extension.source_missing"
								: "extension.file_info_failed",
						severity:
							infoResult.error.code === "not_found" ? "warning" : "error",
						message:
							infoResult.error.code === "not_found"
								? `Extension source not found: ${root.path}`
								: `Failed to inspect extension source ${root.path}: ${infoResult.error.message}`,
						root,
						error: infoResult.error,
					}),
				);
				continue;
			}

			if (
				infoResult.value.kind === "directory" &&
				(await hasDirectoryEntry(executionEnv, infoResult.value.path))
			) {
				candidates.push({
					id: basename(infoResult.value.path),
					root,
					path: infoResult.value.path,
					kind: "directory",
				});
				continue;
			}

			if (infoResult.value.kind === "directory") {
				const result = await discoverDirectory(executionEnv, root);
				candidates.push(...result.candidates);
				diagnostics.push(...result.diagnostics);
				continue;
			}

			const candidate = candidateFromFileInfo(root, infoResult.value);
			if (candidate) {
				candidates.push(candidate);
			}
		}

		return {
			roots: this.getRoots(),
			candidates: candidates.sort((left, right) =>
				left.path.localeCompare(right.path),
			),
			diagnostics,
		};
	}

	clearExtensionModuleCache(): void {
		this._moduleImporter.clearCache();
	}

	registerExtension(extensionId: string, module: ExtensionModule): () => void {
		const normalizedId = extensionId.trim();
		if (!normalizedId) {
			throw new Error("Extension id must not be empty.");
		}
		const resolved = resolveExtensionModule(module);
		if (!resolved) {
			throw new Error(
				"Extension module must be a factory function or an { apiVersion, activate } definition.",
			);
		}
		const identity: ExtensionIdentity = {
			id: normalizedId,
			source: { kind: "factory" },
		};

		if (
			resolved.declaredApiVersion !== undefined &&
			!isSupportedExtensionApiVersion(resolved.declaredApiVersion)
		) {
			this._factories.delete(normalizedId);
			this._factoryIdentities.delete(normalizedId);
			const record: IncompatibleExtensionRecord = {
				identity,
				declaredApiVersion: resolved.declaredApiVersion,
				fromModule: false,
			};
			this._incompatible.set(normalizedId, record);
			return () => {
				if (this._incompatible.get(normalizedId) === record) {
					this._incompatible.delete(normalizedId);
				}
			};
		}

		this._incompatible.delete(normalizedId);
		const factory = resolved.factory;
		this._factories.set(normalizedId, factory);
		this._factoryIdentities.set(normalizedId, identity);
		return () => {
			if (this._factories.get(normalizedId) === factory) {
				this._factories.delete(normalizedId);
				this._factoryIdentities.delete(normalizedId);
			}
		};
	}

	async loadAvailableExtensions(
		executionEnv: ExecutionEnv,
	): Promise<ExtensionLoadAvailableResult> {
		this._removeModuleFactories();
		const discovery = await this.discover(executionEnv);
		const diagnostics: CoreDiagnostic[] = [...discovery.diagnostics];
		const loaded: ExtensionIdentity[] = [];

		for (const candidate of discovery.candidates) {
			const entry = await resolveCandidateEntry(executionEnv, candidate);
			diagnostics.push(...entry.diagnostics);
			if (!entry.entry) continue;

			const registeredIncompatible = this._incompatible.get(candidate.id);
			if (
				this._factories.has(candidate.id) ||
				(registeredIncompatible && !registeredIncompatible.fromModule)
			) {
				diagnostics.push(
					createExtensionLoadDiagnostic({
						code: "extension.id_conflict",
						severity: "warning",
						message: `Extension '${candidate.id}' from ${entry.entry.entryPath} conflicts with an already registered factory and was skipped.`,
						extensionId: candidate.id,
						source: entry.entry.source,
						details: { candidate },
					}),
				);
				continue;
			}

			let moduleExport: unknown;
			try {
				moduleExport = await this._moduleImporter.importModule(
					entry.entry.entryPath,
				);
			} catch (error) {
				diagnostics.push(
					createExtensionLoadDiagnostic({
						code: "extension.load_failed",
						severity: "error",
						message: `Failed to load extension '${candidate.id}' from ${entry.entry.entryPath}: ${formatError(error)}`,
						extensionId: candidate.id,
						source: entry.entry.source,
						details: { candidate, errorMessage: formatError(error) },
					}),
				);
				continue;
			}

			const resolved = resolveExtensionModule(moduleExport);
			if (!resolved) {
				diagnostics.push(
					createExtensionLoadDiagnostic({
						code: "extension.factory_invalid",
						severity: "error",
						message: `Extension '${candidate.id}' from ${entry.entry.entryPath} does not default-export a factory function or an { apiVersion, activate } definition.`,
						extensionId: candidate.id,
						source: entry.entry.source,
						details: { candidate },
					}),
				);
				continue;
			}

			const identity = {
				id: candidate.id,
				source: entry.entry.source,
			};

			if (
				resolved.declaredApiVersion !== undefined &&
				!isSupportedExtensionApiVersion(resolved.declaredApiVersion)
			) {
				this._incompatible.set(candidate.id, {
					identity,
					declaredApiVersion: resolved.declaredApiVersion,
					fromModule: true,
				});
				diagnostics.push(
					createExtensionLoadDiagnostic({
						code: "extension.version_incompatible",
						severity: "error",
						message: `Extension '${candidate.id}' from ${entry.entry.entryPath} targets extension API version ${resolved.declaredApiVersion}; this runtime supports ${formatSupportedApiVersions()}.`,
						extensionId: candidate.id,
						source: entry.entry.source,
						details: {
							candidate,
							declaredApiVersion: resolved.declaredApiVersion,
							supportedApiVersions: supportedApiVersionsDetail(),
						},
					}),
				);
				continue;
			}

			this._factories.set(candidate.id, resolved.factory);
			this._moduleFactories.set(candidate.id, resolved.factory);
			this._factoryIdentities.set(candidate.id, identity);
			loaded.push(identity);
		}

		return {
			discovery,
			loaded,
			diagnostics,
		};
	}

	async reloadAvailableExtensions(
		executionEnv: ExecutionEnv,
	): Promise<ExtensionLoadAvailableResult> {
		this.clearExtensionModuleCache();
		return await this.loadAvailableExtensions(executionEnv);
	}

	async loadForAgent(
		options: LoadExtensionScopeOptions,
	): Promise<LoadedExtensionScope> {
		const diagnostics: CoreDiagnostic[] = [];
		const toolContributions: ExtensionToolContribution[] = [];
		const providerContributions: ExtensionProviderContribution[] = [];
		const observerHandlers = new Map<
			ExtensionObservedEventName,
			ExtensionObserverRegistration[]
		>();
		const interceptorHandlers = new Map<
			ExtensionInterceptorName,
			ExtensionInterceptorRegistration<ExtensionInterceptorName>[]
		>();
		const disposeHandlers: ExtensionDisposeRegistration[] = [];
		const extensionIds = normalizeExtensionIds(options.extensionIds ?? []);
		const extensions: ExtensionIdentity[] = [];

		for (const extensionId of extensionIds) {
			const incompatible = this._incompatible.get(extensionId);
			if (incompatible) {
				diagnostics.push(
					createExtensionDiagnostic({
						code: "extension.version_incompatible",
						severity: "error",
						disposition: "blocked",
						phase: "resolve",
						message: `Extension '${extensionId}' targets extension API version ${incompatible.declaredApiVersion}; this runtime supports ${formatSupportedApiVersions()}.`,
						extensionId,
						agentId: options.agentId,
						profileId: options.profileId,
						details: {
							declaredApiVersion: incompatible.declaredApiVersion,
							supportedApiVersions: supportedApiVersionsDetail(),
						},
					}),
				);
				continue;
			}

			const factory = this._factories.get(extensionId);
			if (!factory) {
				const diagnostic = createMissingFactoryDiagnostic({
					extensionId,
					agentId: options.agentId,
					profileId: options.profileId,
					severity: options.missingExtensionSeverity ?? "warning",
				});
				if (diagnostic) diagnostics.push(diagnostic);
				continue;
			}

			try {
				extensions.push(
					this._factoryIdentities.get(extensionId) ?? {
						id: extensionId,
						source: { kind: "factory" },
					},
				);
				await factory(
					createActivationApi({
						extensionId,
						agentId: options.agentId,
						profileId: options.profileId,
						toolContributions,
						providerContributions,
						observerHandlers,
						interceptorHandlers,
						disposeHandlers,
					}),
				);
			} catch (error) {
				diagnostics.push(
					createExtensionDiagnostic({
						code: "extension.activation_failed",
						severity: "error",
						disposition: "blocked",
						phase: "create",
						message: `Extension '${extensionId}' activation failed: ${formatError(error)}`,
						extensionId,
						agentId: options.agentId,
						profileId: options.profileId,
					}),
				);
			}
		}

		return {
			agentId: options.agentId,
			profileId: options.profileId,
			extensionIds,
			extensions,
			diagnostics,
			toolContributions,
			providerContributions,
			observerHandlers,
			interceptorHandlers,
			disposeHandlers,
		};
	}

	private _removeModuleFactories(): void {
		for (const [extensionId, factory] of this._moduleFactories) {
			if (this._factories.get(extensionId) === factory) {
				this._factories.delete(extensionId);
				this._factoryIdentities.delete(extensionId);
			}
		}
		this._moduleFactories.clear();
		for (const [extensionId, record] of this._incompatible) {
			if (record.fromModule) {
				this._incompatible.delete(extensionId);
			}
		}
	}
}

interface ResolvedExtensionModule {
	readonly factory: ExtensionFactory;
	readonly declaredApiVersion?: number;
}

function resolveExtensionModule(
	module: unknown,
): ResolvedExtensionModule | undefined {
	if (typeof module === "function") {
		return { factory: module as ExtensionFactory };
	}
	if (
		isRecord(module) &&
		typeof module.activate === "function" &&
		typeof module.apiVersion === "number"
	) {
		return {
			factory: module.activate as ExtensionFactory,
			declaredApiVersion: module.apiVersion,
		};
	}
	return undefined;
}

function formatSupportedApiVersions(): string {
	return MIN_SUPPORTED_EXTENSION_API_VERSION === EXTENSION_API_VERSION
		? `version ${EXTENSION_API_VERSION}`
		: `versions ${MIN_SUPPORTED_EXTENSION_API_VERSION} through ${EXTENSION_API_VERSION}`;
}

function supportedApiVersionsDetail(): { min: number; max: number } {
	return {
		min: MIN_SUPPORTED_EXTENSION_API_VERSION,
		max: EXTENSION_API_VERSION,
	};
}

interface ResolvedExtensionEntry {
	readonly entryPath: string;
	readonly source: ExtensionSource;
}

interface ResolveCandidateEntryResult {
	readonly entry?: ResolvedExtensionEntry;
	readonly diagnostics: readonly CoreDiagnostic[];
}

const EXTENSION_FILE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"] as const;

async function resolveCandidateEntry(
	executionEnv: ExecutionEnv,
	candidate: ExtensionDiscoveryCandidate,
): Promise<ResolveCandidateEntryResult> {
	if (candidate.kind === "file") {
		return {
			entry: {
				entryPath: candidate.path,
				source: {
					kind: "file",
					path: candidate.path,
					resolvedPath: candidate.path,
					root: candidate.root,
				},
			},
			diagnostics: [],
		};
	}

	const packageEntry = await resolvePackageEntry(executionEnv, candidate);
	if (packageEntry.entry || packageEntry.hasManifest) {
		return {
			entry: packageEntry.entry,
			diagnostics: packageEntry.diagnostics,
		};
	}

	const indexEntry = await resolveDirectoryIndexEntry(executionEnv, candidate);
	if (indexEntry) {
		return {
			entry: indexEntry,
			diagnostics: [],
		};
	}

	return {
		diagnostics: [
			createExtensionLoadDiagnostic({
				code: "extension.entry_missing",
				severity: "warning",
				message: `Extension '${candidate.id}' has no package entry or index file.`,
				extensionId: candidate.id,
				source: {
					kind: "file",
					path: candidate.path,
					resolvedPath: candidate.path,
					root: candidate.root,
				},
				details: { candidate },
			}),
		],
	};
}

async function resolvePackageEntry(
	executionEnv: ExecutionEnv,
	candidate: ExtensionDiscoveryCandidate,
): Promise<
	ResolveCandidateEntryResult & {
		readonly hasManifest: boolean;
	}
> {
	const packageJsonPath = joinPath(candidate.path, "package.json");
	const infoResult = await executionEnv.fileInfo(packageJsonPath);
	if (!infoResult.ok || infoResult.value.kind !== "file") {
		return { hasManifest: false, diagnostics: [] };
	}

	const contentResult = await executionEnv.readTextFile(packageJsonPath);
	if (!contentResult.ok) {
		return {
			hasManifest: true,
			diagnostics: [
				createExtensionLoadDiagnostic({
					code: "extension.invalid_manifest",
					severity: "error",
					message: `Failed to read extension manifest ${packageJsonPath}: ${contentResult.error.message}`,
					extensionId: candidate.id,
					source: {
						kind: "package",
						path: candidate.path,
						resolvedPath: packageJsonPath,
						entryPath: packageJsonPath,
						root: candidate.root,
					},
					details: { candidate, errorMessage: contentResult.error.message },
				}),
			],
		};
	}

	const manifest = parseExtensionPackageManifest(contentResult.value);
	if (!manifest.ok) {
		return {
			hasManifest: true,
			diagnostics: [
				createExtensionLoadDiagnostic({
					code: "extension.invalid_manifest",
					severity: "error",
					message: `Invalid extension manifest ${packageJsonPath}: ${manifest.reason}`,
					extensionId: candidate.id,
					source: {
						kind: "package",
						path: candidate.path,
						resolvedPath: packageJsonPath,
						entryPath: packageJsonPath,
						root: candidate.root,
					},
					details: { candidate, reason: manifest.reason },
				}),
			],
		};
	}

	if (!manifest.entries) {
		return { hasManifest: false, diagnostics: [] };
	}

	const diagnostics: CoreDiagnostic[] = [];
	const [firstEntry, ...extraEntries] = manifest.entries;
	if (!firstEntry) {
		return { hasManifest: true, diagnostics };
	}
	if (extraEntries.length > 0) {
		diagnostics.push(
			createExtensionLoadDiagnostic({
				code: "extension.extra_entries_ignored",
				severity: "warning",
				message: `Extension '${candidate.id}' declares multiple entries; only ${firstEntry} will be used.`,
				extensionId: candidate.id,
				source: {
					kind: "package",
					path: candidate.path,
					resolvedPath: packageJsonPath,
					entryPath: resolvePath(candidate.path, firstEntry),
					root: candidate.root,
				},
				details: { candidate, ignoredEntries: extraEntries },
			}),
		);
	}

	const entryPath = resolvePath(candidate.path, firstEntry);
	const entryInfo = await executionEnv.fileInfo(entryPath);
	if (!entryInfo.ok || entryInfo.value.kind !== "file") {
		diagnostics.push(
			createExtensionLoadDiagnostic({
				code: "extension.entry_missing",
				severity: "warning",
				message: `Extension '${candidate.id}' entry does not exist: ${entryPath}`,
				extensionId: candidate.id,
				source: {
					kind: "package",
					path: candidate.path,
					resolvedPath: packageJsonPath,
					entryPath,
					root: candidate.root,
				},
				details: { candidate, entry: firstEntry },
			}),
		);
		return { hasManifest: true, diagnostics };
	}

	return {
		hasManifest: true,
		entry: {
			entryPath,
			source: {
				kind: "package",
				path: candidate.path,
				resolvedPath: packageJsonPath,
				entryPath,
				root: candidate.root,
			},
		},
		diagnostics,
	};
}

async function resolveDirectoryIndexEntry(
	executionEnv: ExecutionEnv,
	candidate: ExtensionDiscoveryCandidate,
): Promise<ResolvedExtensionEntry | undefined> {
	for (const extension of EXTENSION_FILE_EXTENSIONS) {
		const entryPath = joinPath(candidate.path, `index${extension}`);
		const infoResult = await executionEnv.fileInfo(entryPath);
		if (infoResult.ok && infoResult.value.kind === "file") {
			return {
				entryPath,
				source: {
					kind: "file",
					path: entryPath,
					resolvedPath: entryPath,
					root: candidate.root,
				},
			};
		}
	}
	return undefined;
}

async function hasDirectoryEntry(
	executionEnv: ExecutionEnv,
	directoryPath: string,
): Promise<boolean> {
	const packageInfo = await executionEnv.fileInfo(
		joinPath(directoryPath, "package.json"),
	);
	if (packageInfo.ok && packageInfo.value.kind === "file") {
		return true;
	}

	for (const extension of EXTENSION_FILE_EXTENSIONS) {
		const indexInfo = await executionEnv.fileInfo(
			joinPath(directoryPath, `index${extension}`),
		);
		if (indexInfo.ok && indexInfo.value.kind === "file") {
			return true;
		}
	}
	return false;
}

type ManifestParseResult =
	| { readonly ok: true; readonly entries?: readonly string[] }
	| { readonly ok: false; readonly reason: string };

function parseExtensionPackageManifest(content: string): ManifestParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		return {
			ok: false,
			reason: formatError(error),
		};
	}

	if (!isRecord(parsed)) {
		return { ok: false, reason: "package.json must contain an object." };
	}

	const section = isRecord(parsed.widi)
		? parsed.widi
		: isRecord(parsed.pi)
			? parsed.pi
			: undefined;
	if (!section) {
		return { ok: true };
	}

	if (!("extensions" in section)) {
		return { ok: true };
	}
	if (!Array.isArray(section.extensions)) {
		return {
			ok: false,
			reason: "extensions must be an array of entry paths.",
		};
	}

	const entries: string[] = [];
	for (const entry of section.extensions) {
		if (typeof entry !== "string") {
			return {
				ok: false,
				reason: "extensions must only contain string entry paths.",
			};
		}
		const normalized = entry.trim();
		if (normalized) entries.push(normalized);
	}

	return { ok: true, entries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createActivationApi(options: {
	extensionId: string;
	agentId: string;
	profileId: string;
	toolContributions: ExtensionToolContribution[];
	providerContributions: ExtensionProviderContribution[];
	observerHandlers: Map<
		ExtensionObservedEventName,
		ExtensionObserverRegistration[]
	>;
	interceptorHandlers: Map<
		ExtensionInterceptorName,
		ExtensionInterceptorRegistration<ExtensionInterceptorName>[]
	>;
	disposeHandlers: ExtensionDisposeRegistration[];
}): ExtensionActivationApi {
	return {
		extensionId: options.extensionId,
		agentId: options.agentId,
		profileId: options.profileId,
		registerTool: (tool) => {
			options.toolContributions.push({
				kind: "define",
				extensionId: options.extensionId,
				definition: tool as ExtensionToolDefinition,
				source: { kind: "extension", id: options.extensionId },
			});
		},
		patchTool: (targetToolName, patch) => {
			options.toolContributions.push({
				kind: "patch",
				extensionId: options.extensionId,
				targetToolName,
				patch: patch as ExtensionToolDefinitionPatch,
				source: { kind: "extension", id: options.extensionId },
			});
		},
		registerProvider: (providerName, config) => {
			const normalized = providerName.trim();
			if (!normalized) {
				throw new Error("Extension provider name must not be empty.");
			}
			options.providerContributions.push({
				extensionId: options.extensionId,
				providerName: normalized,
				config,
			});
		},
		observe: (eventName, handler) => {
			const registrations = options.observerHandlers.get(eventName) ?? [];
			registrations.push({
				extensionId: options.extensionId,
				eventName,
				handler: handler as unknown as ExtensionObserver,
			});
			options.observerHandlers.set(eventName, registrations);
		},
		intercept: (eventName, handler) => {
			const registrations = options.interceptorHandlers.get(eventName) ?? [];
			registrations.push({
				extensionId: options.extensionId,
				eventName,
				handler:
					handler as unknown as ExtensionInterceptorFor<ExtensionInterceptorName>,
			});
			options.interceptorHandlers.set(eventName, registrations);
		},
		onDispose: (handler) => {
			options.disposeHandlers.push({
				extensionId: options.extensionId,
				handler,
			});
		},
	};
}

function normalizeExtensionIds(extensionIds: readonly string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const rawId of extensionIds) {
		const extensionId = rawId.trim();
		if (!extensionId || seen.has(extensionId)) continue;
		seen.add(extensionId);
		normalized.push(extensionId);
	}
	return normalized;
}

async function discoverDirectory(
	executionEnv: ExecutionEnv,
	root: ExtensionRoot,
): Promise<{
	readonly candidates: readonly ExtensionDiscoveryCandidate[];
	readonly diagnostics: readonly CoreDiagnostic[];
}> {
	const listResult = await executionEnv.listDir(root.path);
	if (!listResult.ok) {
		return {
			candidates: [],
			diagnostics: [
				createExtensionDiscoveryDiagnostic({
					code: "extension.list_failed",
					severity: "error",
					message: `Failed to list extension source ${root.path}: ${listResult.error.message}`,
					root,
					error: listResult.error,
				}),
			],
		};
	}

	return {
		candidates: listResult.value.flatMap((entry) => {
			const candidate = candidateFromFileInfo(root, entry);
			return candidate ? [candidate] : [];
		}),
		diagnostics: [],
	};
}

function candidateFromFileInfo(
	root: ExtensionRoot,
	fileInfo: FileInfo,
): ExtensionDiscoveryCandidate | undefined {
	if (fileInfo.kind === "directory") {
		return {
			id: basename(fileInfo.path),
			root,
			path: fileInfo.path,
			kind: "directory",
		};
	}
	if (fileInfo.kind !== "file") {
		return undefined;
	}

	const id = extensionFileId(fileInfo.path);
	if (!id) {
		return undefined;
	}
	return {
		id,
		root,
		path: fileInfo.path,
		kind: "file",
	};
}

function extensionFileId(path: string): string | undefined {
	const name = basename(path);
	for (const extension of EXTENSION_FILE_EXTENSIONS) {
		if (name.endsWith(extension) && name.length > extension.length) {
			return name.slice(0, -extension.length);
		}
	}
	return undefined;
}

function basename(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const index = normalized.lastIndexOf("/");
	return index === -1 ? normalized : normalized.slice(index + 1);
}

function joinPath(basePath: string, childPath: string): string {
	return resolvePath(basePath, childPath);
}

function resolvePath(basePath: string, path: string): string {
	if (path.startsWith("/")) return normalizePath(path);
	return normalizePath(`${basePath}/${path}`);
}

function normalizePath(path: string): string {
	const absolute = path.startsWith("/");
	const segments: string[] = [];
	for (const segment of path.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	const normalized = segments.join("/");
	if (absolute) return `/${normalized}`.replace(/\/$/, "") || "/";
	return normalized || ".";
}

function createExtensionDiscoveryDiagnostic(options: {
	code:
		| "extension.source_missing"
		| "extension.file_info_failed"
		| "extension.list_failed";
	severity: DiagnosticSeverity;
	message: string;
	root: ExtensionRoot;
	error?: FileError;
}): CoreDiagnostic {
	return createDiagnostic({
		domain: "extension",
		code: options.code,
		severity: options.severity,
		disposition: options.severity === "error" ? "degraded" : "reported",
		recoverable: true,
		message: options.message,
		source: {
			kind: "extension",
			id: basename(options.root.path),
			path: options.root.path,
		},
		phase: "load",
		details: {
			root: options.root,
			errorCode: options.error?.code,
			errorMessage: options.error?.message,
		},
	});
}

function createExtensionLoadDiagnostic(options: {
	code:
		| "extension.entry_missing"
		| "extension.extra_entries_ignored"
		| "extension.factory_invalid"
		| "extension.id_conflict"
		| "extension.invalid_manifest"
		| "extension.load_failed"
		| "extension.version_incompatible";
	severity: DiagnosticSeverity;
	message: string;
	extensionId: string;
	source: ExtensionSource;
	details?: Record<string, unknown>;
}): CoreDiagnostic {
	const sourcePath =
		options.source.kind === "file"
			? options.source.resolvedPath
			: options.source.kind === "package"
				? options.source.entryPath
				: undefined;
	return createDiagnostic({
		domain: "extension",
		code: options.code,
		severity: options.severity,
		disposition: options.severity === "error" ? "degraded" : "reported",
		recoverable: true,
		message: options.message,
		source: {
			kind: "extension",
			id: options.extensionId,
			path: sourcePath,
		},
		phase: "load",
		extensionId: options.extensionId,
		details: {
			...options.details,
			extensionSource: options.source,
		},
	});
}

function createMissingFactoryDiagnostic(options: {
	extensionId: string;
	agentId: string;
	profileId: string;
	severity: "ignore" | "warning" | "error";
}): CoreDiagnostic | undefined {
	if (options.severity === "ignore") return undefined;
	return createExtensionDiagnostic({
		code: "extension.factory_missing",
		severity: options.severity,
		disposition: options.severity === "error" ? "blocked" : "degraded",
		phase: "resolve",
		message: `Extension '${options.extensionId}' is requested by profile '${options.profileId}' but no factory is registered.`,
		extensionId: options.extensionId,
		agentId: options.agentId,
		profileId: options.profileId,
	});
}

function createExtensionDiagnostic(options: {
	code: string;
	severity: DiagnosticSeverity;
	disposition?: DiagnosticDisposition;
	phase?: CoreDiagnostic["phase"];
	message: string;
	extensionId: string;
	agentId: string;
	profileId: string;
	details?: Record<string, unknown>;
}): CoreDiagnostic {
	return createDiagnostic({
		domain: "extension",
		code: options.code,
		severity: options.severity,
		disposition:
			options.disposition ??
			(options.severity === "error" ? "degraded" : "reported"),
		recoverable: true,
		message: options.message,
		source: { kind: "extension", id: options.extensionId },
		phase: options.phase ?? "resolve",
		agentId: options.agentId,
		profileId: options.profileId,
		extensionId: options.extensionId,
		details: options.details,
	});
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
