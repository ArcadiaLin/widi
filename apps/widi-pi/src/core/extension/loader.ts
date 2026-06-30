import type {
	ExecutionEnv,
	FileError,
	FileInfo,
} from "@earendil-works/pi-agent-core";
import {
	type CoreDiagnostic,
	createDiagnostic,
	type DiagnosticSeverity,
} from "../diagnostics.ts";
import type {
	ExtensionActivationApi,
	ExtensionFactory,
	ExtensionInterceptorFor,
	ExtensionInterceptorName,
	ExtensionObservedEventName,
	ExtensionObserverFor,
	ToolDefinition,
	ToolDefinitionPatch,
	ToolSource,
} from "./types.ts";

type ExtensionToolDefinition = ToolDefinition;
type ExtensionToolDefinitionPatch = ToolDefinitionPatch;

export interface ExtensionObserverRegistration<
	TName extends ExtensionObservedEventName,
> {
	extensionId: string;
	eventName: TName;
	handler: ExtensionObserverFor<TName>;
}

export interface ExtensionInterceptorRegistration<
	TName extends ExtensionInterceptorName,
> {
	extensionId: string;
	eventName: TName;
	handler: ExtensionInterceptorFor<TName>;
}

export interface LoadExtensionScopeOptions {
	agentId: string;
	profileId: string;
	extensionIds?: readonly string[];
	missingExtensionSeverity?: "ignore" | "warning" | "error";
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
}

export interface LoadedExtensionScope {
	agentId: string;
	profileId: string;
	extensionIds: readonly string[];
	diagnostics: readonly CoreDiagnostic[];
	toolContributions: readonly ExtensionToolContribution[];
	observerHandlers: ReadonlyMap<
		ExtensionObservedEventName,
		readonly ExtensionObserverRegistration<ExtensionObservedEventName>[]
	>;
	interceptorHandlers: ReadonlyMap<
		ExtensionInterceptorName,
		readonly ExtensionInterceptorRegistration<ExtensionInterceptorName>[]
	>;
}

export class ExtensionLoader {
	private readonly _factories = new Map<string, ExtensionFactory>();
	private readonly _roots: readonly ExtensionRoot[];

	constructor(options: ExtensionLoaderOptions = {}) {
		this._roots = options.roots ? [...options.roots] : [];
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

	registerExtensionFactory(
		extensionId: string,
		factory: ExtensionFactory,
	): () => void {
		const normalizedId = extensionId.trim();
		if (!normalizedId) {
			throw new Error("Extension id must not be empty.");
		}
		this._factories.set(normalizedId, factory);
		return () => {
			if (this._factories.get(normalizedId) === factory) {
				this._factories.delete(normalizedId);
			}
		};
	}

	async loadForAgent(
		options: LoadExtensionScopeOptions,
	): Promise<LoadedExtensionScope> {
		const diagnostics: CoreDiagnostic[] = [];
		const toolContributions: ExtensionToolContribution[] = [];
		const observerHandlers = new Map<
			ExtensionObservedEventName,
			ExtensionObserverRegistration<ExtensionObservedEventName>[]
		>();
		const interceptorHandlers = new Map<
			ExtensionInterceptorName,
			ExtensionInterceptorRegistration<ExtensionInterceptorName>[]
		>();
		const extensionIds = normalizeExtensionIds(options.extensionIds ?? []);

		for (const extensionId of extensionIds) {
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
				await factory(
					createActivationApi({
						extensionId,
						agentId: options.agentId,
						profileId: options.profileId,
						toolContributions,
						observerHandlers,
						interceptorHandlers,
					}),
				);
			} catch (error) {
				diagnostics.push(
					createExtensionDiagnostic({
						code: "extension.activation_failed",
						severity: "error",
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
			diagnostics,
			toolContributions,
			observerHandlers,
			interceptorHandlers,
		};
	}
}

function createActivationApi(options: {
	extensionId: string;
	agentId: string;
	profileId: string;
	toolContributions: ExtensionToolContribution[];
	observerHandlers: Map<
		ExtensionObservedEventName,
		ExtensionObserverRegistration<ExtensionObservedEventName>[]
	>;
	interceptorHandlers: Map<
		ExtensionInterceptorName,
		ExtensionInterceptorRegistration<ExtensionInterceptorName>[]
	>;
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
		observe: (eventName, handler) => {
			const registrations = options.observerHandlers.get(eventName) ?? [];
			registrations.push({
				extensionId: options.extensionId,
				eventName,
				handler: handler as ExtensionObserverFor<ExtensionObservedEventName>,
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
	for (const extension of [".js", ".mjs", ".cjs", ".ts"]) {
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
		message: `Extension '${options.extensionId}' is requested by profile '${options.profileId}' but no factory is registered.`,
		extensionId: options.extensionId,
		agentId: options.agentId,
		profileId: options.profileId,
	});
}

function createExtensionDiagnostic(options: {
	code: string;
	severity: DiagnosticSeverity;
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
		disposition: options.severity === "error" ? "degraded" : "reported",
		recoverable: true,
		message: options.message,
		source: { kind: "extension", id: options.extensionId },
		phase: "resolve",
		agentId: options.agentId,
		profileId: options.profileId,
		extensionId: options.extensionId,
		details: options.details,
	});
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
