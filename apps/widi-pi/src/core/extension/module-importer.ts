import { createJiti } from "jiti";
import type { ExtensionFactory } from "./types.ts";

export interface ExtensionModuleImporter {
	importFactory(entryPath: string): Promise<ExtensionFactory | undefined>;
	clearCache(): void;
}

export class JitiExtensionModuleImporter implements ExtensionModuleImporter {
	private readonly factories = new Map<string, ExtensionFactory | undefined>();
	private readonly jiti = createJiti(import.meta.url, {
		moduleCache: false,
	});
	private generation = 0;

	async importFactory(
		entryPath: string,
	): Promise<ExtensionFactory | undefined> {
		const cacheKey = `${this.generation}:${entryPath}`;
		if (this.factories.has(cacheKey)) {
			return this.factories.get(cacheKey);
		}

		const module = await this.jiti.import(entryPath, { default: true });
		const factory = typeof module === "function" ? module : undefined;
		this.factories.set(cacheKey, factory as ExtensionFactory | undefined);
		return factory as ExtensionFactory | undefined;
	}

	clearCache(): void {
		this.factories.clear();
		this.generation++;
	}
}
