import type { KeybindingDefinitions, KeybindingsConfig } from "@earendil-works/pi-tui";
import type { OrchestratorDiagnostic } from "../../core/diagnostics.ts";
import type { ExtensionIdentity, ExtensionSource } from "../../core/extension/loader.ts";
import { JitiExtensionModuleImporter } from "../../core/extension/module-importer.ts";
import { formatError } from "../../utils/errors.ts";
import type { CommandEngine } from "../commands/engine.ts";
import type { CommandDefinition } from "../commands/types.ts";
import type { LayoutSlots } from "../layout/slots.ts";
import { registerToolPresenter } from "../tool-presenter.ts";
import { ExtensionShortcutRegistry } from "./shortcuts.ts";
import {
	TUI_EXTENSION_API_VERSION,
	type TuiExtensionActivate,
	type TuiExtensionComponentFactory,
	type TuiExtensionDispose,
	type TuiExtensionShortcutOptions,
	type TuiExtensionWidgetOptions,
	type WidiTuiExtensionApi,
} from "./types.ts";

/**
 * Imports the full module namespace of an extension entry: the `tui` named
 * export lives beside the core half's default export, so the default-export
 * importer the core loader uses cannot see it.
 */
export interface TuiExtensionModuleImporter {
	importModuleNamespace(entryPath: string): Promise<unknown>;
}

export interface TuiExtensionHostOptions {
	/**
	 * Extensions the core discovery/load pipeline already resolved - the host
	 * reuses that output (`services.extensionLoad.loaded`, derived from
	 * `ExtensionDiscoveryResult`) instead of walking the file system again.
	 * Programmatically registered factory extensions have no entry file and
	 * cannot carry a `tui` half; they are skipped.
	 */
	readonly identities: readonly ExtensionIdentity[];
	readonly commandEngine: CommandEngine;
	/** The mounted layout the application assembled; widgets join it at runtime. */
	readonly layout: LayoutSlots;
	readonly reportDiagnostic: (diagnostic: OrchestratorDiagnostic) => void;
	readonly moduleImporter?: TuiExtensionModuleImporter;
}

interface HostDisposer {
	readonly extensionId: string;
	readonly dispose: TuiExtensionDispose;
}

/**
 * Runtime-level singleton that activates the `tui` halves of extensions
 * (host doc §6.1/§6.5). It is a TUI application module, not a core extension:
 * discovery and entry resolution come from the core pipeline's output, import
 * goes through a namespace-reading jiti importer, activation hands each
 * extension the `WidiTuiExtensionApi`, and every failure is isolated to a
 * diagnostic - a broken extension can never abort TUI startup.
 */
export class TuiExtensionHost {
	readonly shortcuts: ExtensionShortcutRegistry;

	private readonly identities: readonly ExtensionIdentity[];
	private readonly commandEngine: CommandEngine;
	private readonly layout: LayoutSlots;
	private readonly reportDiagnostic: (diagnostic: OrchestratorDiagnostic) => void;
	private readonly moduleImporter: TuiExtensionModuleImporter;
	private readonly disposers: HostDisposer[] = [];
	private activated = false;

	constructor(options: TuiExtensionHostOptions) {
		this.identities = options.identities;
		this.commandEngine = options.commandEngine;
		this.layout = options.layout;
		this.reportDiagnostic = options.reportDiagnostic;
		this.moduleImporter = options.moduleImporter ?? new JitiExtensionModuleImporter();
		this.shortcuts = new ExtensionShortcutRegistry({ reportDiagnostic: options.reportDiagnostic });
	}

	/** Shortcut definitions registered so far, for the global keybindings merge. */
	get keybindingDefinitions(): KeybindingDefinitions {
		return this.shortcuts.keybindingDefinitions;
	}

	/** The user's keybindings.json config, once the application has loaded it. */
	setUserKeybindings(bindings: KeybindingsConfig): void {
		this.shortcuts.setUserBindings(bindings);
	}

	/** Editor input hook: consume the keystroke when an extension shortcut claims it. */
	handleShortcut(data: string): boolean {
		return this.shortcuts.dispatch(data);
	}

	async activate(): Promise<void> {
		if (this.activated) return;
		this.activated = true;
		for (const identity of this.identities) {
			await this.activateOne(identity);
		}
	}

	/** Reverse-order dispose; each failure is reported and the rest still run. */
	async dispose(): Promise<void> {
		const pending = this.disposers.splice(0).reverse();
		for (const disposer of pending) {
			try {
				await disposer.dispose();
			} catch (error) {
				this.reportDiagnostic({
					severity: "warning",
					code: "tui_extension.dispose_failed",
					message: `Extension '${disposer.extensionId}' dispose failed: ${formatError(error)}`,
					extensionId: disposer.extensionId,
				});
			}
		}
	}

	private async activateOne(identity: ExtensionIdentity): Promise<void> {
		const entryPath = entryPathOf(identity.source);
		if (!entryPath) return;
		const extensionId = identity.id;

		let module: unknown;
		try {
			module = await this.moduleImporter.importModuleNamespace(entryPath);
		} catch (error) {
			this.reportDiagnostic({
				severity: "error",
				code: "tui_extension.load_failed",
				message: `Failed to load the TUI half of extension '${extensionId}' from ${entryPath}: ${formatError(error)}`,
				extensionId,
			});
			return;
		}

		const tuiHalf = resolveTuiHalf(module);
		// No `tui` export: a pure core extension, the normal case, no diagnostic.
		if (tuiHalf === undefined) return;
		if (tuiHalf === "invalid") {
			this.reportDiagnostic({
				severity: "error",
				code: "tui_extension.definition_invalid",
				message: `Extension '${extensionId}' has an invalid 'tui' export; expected an activation function or an { apiVersion, activate } definition.`,
				extensionId,
			});
			return;
		}
		if (tuiHalf.apiVersion !== undefined && tuiHalf.apiVersion !== TUI_EXTENSION_API_VERSION) {
			// Only this half is refused (host doc open question 4): the core half
			// already loaded on its own version terms.
			this.reportDiagnostic({
				severity: "error",
				code: "tui_extension.version_incompatible",
				message: `Extension '${extensionId}' targets TUI extension API version ${tuiHalf.apiVersion}; this host supports version ${TUI_EXTENSION_API_VERSION}.`,
				extensionId,
			});
			return;
		}

		try {
			const dispose = await tuiHalf.activate(this.createApi(extensionId));
			if (typeof dispose === "function") {
				this.disposers.push({ extensionId, dispose });
			}
		} catch (error) {
			// Disposers the extension registered before throwing stay on the list;
			// their cleanup is still owed at shutdown.
			this.reportDiagnostic({
				severity: "error",
				code: "tui_extension.activation_failed",
				message: `Extension '${extensionId}' TUI activation failed: ${formatError(error)}`,
				extensionId,
			});
		}
	}

	private createApi(extensionId: string): WidiTuiExtensionApi {
		// Layout keys this extension owns; one cleanup disposer removes them all
		// when the host shuts down.
		const layoutKeys = new Set<string>();
		let layoutCleanupRegistered = false;
		const setLayoutComponent = (
			slot: "header" | "aboveEditor" | "belowEditor" | "footer",
			key: string,
			factory: TuiExtensionComponentFactory | undefined,
		) => {
			if (factory === undefined) {
				layoutKeys.delete(key);
				this.layout.unregister(key);
				return;
			}
			if (!layoutCleanupRegistered) {
				layoutCleanupRegistered = true;
				this.disposers.push({
					extensionId,
					dispose: () => {
						for (const layoutKey of layoutKeys) this.layout.unregister(layoutKey);
					},
				});
			}
			// Re-setting a key replaces the widget; unregister disposes the old one.
			this.layout.unregister(key);
			const diagnostic = this.layout.register({ key, slot, scope: "global", factory });
			if (diagnostic) {
				this.reportDiagnostic({ ...diagnostic, extensionId });
				return;
			}
			layoutKeys.add(key);
		};
		return {
			extensionId,
			registerCommand: (definition: CommandDefinition) => {
				const diagnostic = this.commandEngine.register(definition);
				if (diagnostic) this.reportDiagnostic({ ...diagnostic, extensionId });
			},
			registerShortcut: (bindingId: string, options: TuiExtensionShortcutOptions) => {
				const diagnostic = this.shortcuts.register(extensionId, bindingId, options);
				if (diagnostic) this.reportDiagnostic(diagnostic);
			},
			registerToolPresenter: (toolName, presenter) => {
				const diagnostic = registerToolPresenter(toolName, presenter);
				if (diagnostic) this.reportDiagnostic({ ...diagnostic, extensionId });
			},
			setWidget: (
				key: string,
				factory: TuiExtensionComponentFactory | undefined,
				options: TuiExtensionWidgetOptions,
			) => {
				const normalizedKey = key.trim();
				if (!normalizedKey || /\s/.test(normalizedKey)) {
					this.reportDiagnostic({
						severity: "warning",
						code: "tui_extension.widget_invalid",
						message: `Extension '${extensionId}' set a widget with an invalid key; it was refused.`,
						extensionId,
					});
					return;
				}
				setLayoutComponent(options.placement, `ext.${extensionId}.${normalizedKey}`, factory);
			},
			setFooter: (factory: TuiExtensionComponentFactory | undefined) => {
				setLayoutComponent("footer", `ext.${extensionId}.footer`, factory);
			},
			setHeader: (factory: TuiExtensionComponentFactory | undefined) => {
				setLayoutComponent("header", `ext.${extensionId}.header`, factory);
			},
			onDispose: (handler) => {
				this.disposers.push({ extensionId, dispose: handler });
			},
		};
	}
}

/** The importable entry of a discovered extension; factory sources have none. */
function entryPathOf(source: ExtensionSource): string | undefined {
	if (source.kind === "package") return source.entryPath;
	if (source.kind === "file") return source.path;
	return undefined;
}

type ResolvedTuiHalf = { readonly activate: TuiExtensionActivate; readonly apiVersion?: number };

function resolveTuiHalf(module: unknown): ResolvedTuiHalf | "invalid" | undefined {
	if (!isRecord(module)) return undefined;
	const tui = module.tui;
	if (tui === undefined) return undefined;
	if (typeof tui === "function") return { activate: tui as TuiExtensionActivate };
	if (isRecord(tui) && typeof tui.activate === "function") {
		const apiVersion = tui.apiVersion;
		if (apiVersion !== undefined && typeof apiVersion !== "number") return "invalid";
		return { activate: tui.activate as TuiExtensionActivate, ...(apiVersion !== undefined ? { apiVersion } : {}) };
	}
	return "invalid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
