import type { KeyId } from "@earendil-works/pi-tui";
import type { CommandDefinition } from "../commands/types.ts";
import type { ToolPresenter } from "../tool-presenter.ts";

/**
 * The `tui` half of the dual-entry extension contract (host doc §6.2). A
 * package keeps its core half on the default export and puts the TUI half on
 * the `tui` named export; the two hosts load them independently and never see
 * each other. Extensions without a `tui` export are pure core extensions and
 * are skipped silently.
 */
export const TUI_EXTENSION_API_VERSION = 1;

/** What a shortcut handler learns about its own invocation. Grows in Step 6b. */
export interface TuiExtensionShortcutContext {
	readonly extensionId: string;
	readonly actionId: string;
}

export interface TuiExtensionShortcutOptions {
	/** Default key sequence(s); the user can override them in keybindings.json. */
	readonly defaultKeys: KeyId | KeyId[];
	readonly description?: string;
	readonly handler: (context: TuiExtensionShortcutContext) => void;
}

/**
 * The API object the host hands to a `tui` half at activation. Step 6a covers
 * the registration-class surface; Step 6b adds the component-class methods
 * (widgets, overlays, theme, editor text, renderers) onto this same object.
 */
export interface WidiTuiExtensionApi {
	readonly extensionId: string;

	/** Slash command, into the TUI command engine. Name conflicts are refused. */
	registerCommand(definition: CommandDefinition): void;

	/**
	 * A binding id, not a raw key sequence: the action id is namespaced as
	 * `ext.<extensionId>.<bindingId>`, the default keys join the configurable
	 * keybindings table, and keybindings.json can override them.
	 */
	registerShortcut(bindingId: string, options: TuiExtensionShortcutOptions): void;

	/** Presenter for a tool name, into the tool-presenter registry. */
	registerToolPresenter(toolName: string, presenter: ToolPresenter): void;

	/** Cleanup run when the host shuts down; disposers run in reverse order. */
	onDispose(handler: () => void | Promise<void>): void;
}

export type TuiExtensionDispose = () => void | Promise<void>;

/**
 * Activation contract: the function receives the host API object and may
 * return a dispose callback (or a promise of one). Throwing is contained -
 * the host reports a diagnostic and leaves the rest of the extensions alone.
 */
export type TuiExtensionActivateResult = void | TuiExtensionDispose | Promise<void> | Promise<TuiExtensionDispose>;

export type TuiExtensionActivate = (api: WidiTuiExtensionApi) => TuiExtensionActivateResult;

/** The shapes accepted on the `tui` named export, mirroring the core half. */
export type TuiExtensionModule =
	| TuiExtensionActivate
	| { readonly apiVersion?: number; readonly activate: TuiExtensionActivate };
