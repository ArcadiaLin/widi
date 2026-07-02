import type {
	ExecutionEnv,
	ExecutionError,
	FileError,
	FileInfo,
	Result,
	ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import {
	err,
	ok,
	ExecutionError as PiExecutionError,
	FileError as PiFileError,
} from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	ExtensionLoader,
	type ExtensionModuleImporter,
} from "../../src/core/extension/index.ts";
import type { ExtensionFactory } from "../../src/core/extension/types.ts";

class MemoryExecutionEnv implements ExecutionEnv {
	cwd = "/workspace";
	readonly files = new Map<string, string>();
	readonly dirs = new Set<string>(["/"]);

	private normalize(path: string): string {
		const absolute = path.startsWith("/") ? path : `${this.cwd}/${path}`;
		return absolute.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
	}

	private dirname(path: string): string {
		const normalized = this.normalize(path);
		if (normalized === "/") return "/";
		const index = normalized.lastIndexOf("/");
		return index <= 0 ? "/" : normalized.slice(0, index);
	}

	private basename(path: string): string {
		const normalized = this.normalize(path);
		if (normalized === "/") return "/";
		const index = normalized.lastIndexOf("/");
		return index === -1 ? normalized : normalized.slice(index + 1);
	}

	addDir(path: string): void {
		const normalized = this.normalize(path);
		if (normalized === "/") {
			this.dirs.add("/");
			return;
		}
		this.addDir(this.dirname(normalized));
		this.dirs.add(normalized);
	}

	addFile(path: string, content = ""): void {
		const normalized = this.normalize(path);
		this.addDir(this.dirname(normalized));
		this.files.set(normalized, content);
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(this.normalize(path));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(this.normalize(parts.join("/")));
	}

	async readTextFile(path: string): Promise<Result<string, FileError>> {
		const normalized = this.normalize(path);
		const content = this.files.get(normalized);
		if (content === undefined) {
			return err(
				new PiFileError(
					"not_found",
					`File not found: ${normalized}`,
					normalized,
				),
			);
		}
		return ok(content);
	}

	async readTextLines(path: string): Promise<Result<string[], FileError>> {
		const result = await this.readTextFile(path);
		if (!result.ok) return result;
		return ok(result.value.split("\n"));
	}

	async readBinaryFile(): Promise<Result<Uint8Array, FileError>> {
		return err(new PiFileError("not_supported", "not supported"));
	}

	async writeFile(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async appendFile(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const normalized = this.normalize(path);
		if (this.files.has(normalized)) {
			return ok({
				name: this.basename(normalized),
				path: normalized,
				kind: "file",
				size: this.files.get(normalized)?.length ?? 0,
				mtimeMs: 0,
			});
		}
		if (this.dirs.has(normalized)) {
			return ok({
				name: this.basename(normalized),
				path: normalized,
				kind: "directory",
				size: 0,
				mtimeMs: 0,
			});
		}
		return err(
			new PiFileError("not_found", `File not found: ${normalized}`, normalized),
		);
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		const dir = this.normalize(path);
		if (!this.dirs.has(dir)) {
			return err(
				new PiFileError("not_found", `Directory not found: ${dir}`, dir),
			);
		}

		const result: FileInfo[] = [];
		for (const filePath of this.files.keys()) {
			if (this.dirname(filePath) !== dir) continue;
			result.push({
				name: this.basename(filePath),
				path: filePath,
				kind: "file",
				size: this.files.get(filePath)?.length ?? 0,
				mtimeMs: 0,
			});
		}
		for (const directory of this.dirs) {
			if (directory === dir || this.dirname(directory) !== dir) continue;
			result.push({
				name: this.basename(directory),
				path: directory,
				kind: "directory",
				size: 0,
				mtimeMs: 0,
			});
		}
		return ok(
			result.sort((left, right) => left.path.localeCompare(right.path)),
		);
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		return ok(this.normalize(path));
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		const normalized = this.normalize(path);
		return ok(this.files.has(normalized) || this.dirs.has(normalized));
	}

	async createDir(path: string): Promise<Result<void, FileError>> {
		this.addDir(path);
		return ok(undefined);
	}

	async remove(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async createTempDir(): Promise<Result<string, FileError>> {
		return ok("/tmp/widi-extension-test");
	}

	async createTempFile(): Promise<Result<string, FileError>> {
		return ok("/tmp/widi-extension-test/file");
	}

	async cleanup(): Promise<void> {}

	async exec(
		_command: string,
		_options?: ShellExecOptions,
	): Promise<
		Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
	> {
		return err(new PiExecutionError("shell_unavailable", "not supported"));
	}
}

class FakeModuleImporter implements ExtensionModuleImporter {
	readonly imports: string[] = [];
	private readonly factories = new Map<string, ExtensionFactory | undefined>();
	clearCalls = 0;

	setFactory(path: string, factory: ExtensionFactory | undefined): void {
		this.factories.set(path, factory);
	}

	async importFactory(path: string): Promise<ExtensionFactory | undefined> {
		this.imports.push(path);
		return this.factories.get(path);
	}

	clearCache(): void {
		this.clearCalls++;
	}
}

describe("ExtensionLoader file/module loading", () => {
	it("loads direct file factories and exposes source facts", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/extensions/sample.ts");
		const importer = new FakeModuleImporter();
		let activationCount = 0;
		importer.setFactory("/extensions/sample.ts", () => {
			activationCount++;
		});
		const loader = new ExtensionLoader({
			roots: [{ kind: "settings", path: "/extensions" }],
			moduleImporter: importer,
		});

		const result = await loader.loadAvailableExtensions(env);
		const scope = await loader.loadForAgent({
			agentId: "agent",
			profileId: "profile",
			extensionIds: ["sample"],
		});

		expect(result.loaded).toEqual([
			{
				id: "sample",
				source: {
					kind: "file",
					path: "/extensions/sample.ts",
					resolvedPath: "/extensions/sample.ts",
					root: { kind: "settings", path: "/extensions" },
				},
			},
		]);
		expect(scope.extensions).toEqual(result.loaded);
		expect(activationCount).toBe(1);
	});

	it("loads the first package manifest entry and warns about extras", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile(
			"/extensions/package-extension/package.json",
			JSON.stringify({
				widi: { extensions: ["./main.ts", "./extra.ts"] },
			}),
		);
		env.addFile("/extensions/package-extension/main.ts");
		env.addFile("/extensions/package-extension/extra.ts");
		const importer = new FakeModuleImporter();
		importer.setFactory("/extensions/package-extension/main.ts", () => {});
		importer.setFactory("/extensions/package-extension/extra.ts", () => {});
		const loader = new ExtensionLoader({
			roots: [{ kind: "settings", path: "/extensions" }],
			moduleImporter: importer,
		});

		const result = await loader.loadAvailableExtensions(env);

		expect(importer.imports).toEqual(["/extensions/package-extension/main.ts"]);
		expect(result.loaded).toEqual([
			{
				id: "package-extension",
				source: {
					kind: "package",
					path: "/extensions/package-extension",
					resolvedPath: "/extensions/package-extension/package.json",
					entryPath: "/extensions/package-extension/main.ts",
					root: { kind: "settings", path: "/extensions" },
				},
			},
		]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "extension.extra_entries_ignored",
				extensionId: "package-extension",
			}),
		);
	});

	it("does not overwrite existing factory ids with module factories", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/extensions/sample.ts");
		const importer = new FakeModuleImporter();
		let activationSource = "";
		importer.setFactory("/extensions/sample.ts", () => {
			activationSource = "module";
		});
		const loader = new ExtensionLoader({
			roots: [{ kind: "settings", path: "/extensions" }],
			moduleImporter: importer,
		});
		loader.registerExtensionFactory("sample", () => {
			activationSource = "memory";
		});

		const result = await loader.loadAvailableExtensions(env);
		await loader.loadForAgent({
			agentId: "agent",
			profileId: "profile",
			extensionIds: ["sample"],
		});

		expect(result.loaded).toEqual([]);
		expect(importer.imports).toEqual([]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "extension.id_conflict",
				extensionId: "sample",
			}),
		);
		expect(activationSource).toBe("memory");
	});

	it("clears the module cache before reloading available extensions", async () => {
		const env = new MemoryExecutionEnv();
		env.addFile("/extensions/sample.ts");
		const importer = new FakeModuleImporter();
		importer.setFactory("/extensions/sample.ts", () => {});
		const loader = new ExtensionLoader({
			roots: [{ kind: "settings", path: "/extensions" }],
			moduleImporter: importer,
		});

		await loader.loadAvailableExtensions(env);
		await loader.reloadAvailableExtensions(env);

		expect(importer.clearCalls).toBe(1);
		expect(importer.imports).toEqual([
			"/extensions/sample.ts",
			"/extensions/sample.ts",
		]);
	});
});
