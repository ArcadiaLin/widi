// The extension-author API surface lives in api.ts (the frozen contract, ME
// slice 10); this barrel adds the core-internal binding surface on top.
export * from "./api.ts";
export {
	type ExtensionDiscoveryCandidate,
	type ExtensionDiscoveryCandidateKind,
	type ExtensionDiscoveryResult,
	type ExtensionIdentity,
	type ExtensionInterceptorRegistration,
	type ExtensionLoadAvailableResult,
	ExtensionLoader,
	type ExtensionObserverRegistration,
	type ExtensionProviderContribution,
	type ExtensionRoot,
	type ExtensionSource,
	type ExtensionToolContribution,
	type LoadExtensionScopeOptions,
	type LoadedExtensionScope,
} from "./loader.ts";
export {
	type ExtensionModuleImporter,
	JitiExtensionModuleImporter,
} from "./module-importer.ts";
export {
	type ExtensionHookSnapshot,
	type ExtensionInputInterceptRun,
	type ExtensionProviderContributionSnapshot,
	ExtensionRunner,
	type ExtensionRunnerOptions,
	type ExtensionRunnerSnapshot,
	type ExtensionToolContributionSnapshot,
} from "./runner.ts";
export type {
	ExtensionActionFailure,
	ExtensionCompactionResult,
	ExtensionContextActions,
	ExtensionCoreActions,
	ExtensionSessionActions,
} from "./types.ts";
