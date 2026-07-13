import type { ExtensionFactory } from "../../src/core/extension/index.ts";

export interface ResourceExtensionOptions {
	readonly skillPaths?: readonly string[];
	readonly promptTemplatePaths?: readonly string[];
}

/**
 * Anchor consumer for ME slice 8: declares skill / prompt template paths at
 * activation and nothing else. The consumers of the loaded resources are the
 * existing core pipelines - `<skill:...>` / `<prompt:...>` expansion,
 * candidate listing, and the harness system prompt - so the integration
 * tests exercise the contribution surface end to end.
 */
export function createResourceExtension(
	options: ResourceExtensionOptions,
): ExtensionFactory {
	return (api) => {
		api.contributeResources({
			skillPaths: options.skillPaths,
			promptTemplatePaths: options.promptTemplatePaths,
		});
	};
}
