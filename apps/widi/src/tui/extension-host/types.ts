import type { Component, KeyId } from "@earendil-works/pi-tui";
import type { CommandDefinition } from "../commands/types.ts";
import type { AppOverlayHandle, ShowOverlayOptions } from "../layout/overlay-stack.ts";
import type { Theme, ThemeInfo } from "../theme/theme.ts";
import type { ToolPresenter } from "../tool-presenter.ts";
import type { TuiExtensionEntryRenderer, TuiExtensionMessageRenderer } from "./renderers.ts";

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
 * Instantiates a component the extension mounts into the layout or shows as
 * an overlay. An optional dispose() on the component runs when the host
 * removes it. Factories get no arguments: the live `theme` holder on the API
 * object is the painting resource, and it survives theme switches.
 */
export type TuiExtensionComponentFactory = () => Component;

export interface TuiExtensionWidgetOptions {
	/**
	 * Which named slot the widget joins. Host doc §6.3 also sketches an
	 * "agent" scope (render only while that agent is visible); the layout
	 * registry implements "global" only, so scope is not an option yet.
	 */
	readonly placement: "aboveEditor" | "belowEditor";
}

/** The slice of the TUI editor the host hands extensions for text access. */
export interface TuiExtensionEditorAccess {
	getText(): string;
	setText(text: string): void;
	insertTextAtCursor?(text: string): void;
}

/**
 * The API object the host hands to a `tui` half at activation: the
 * registration-class surface (commands, shortcuts, presenters, renderers)
 * plus the component-class surface (widgets, overlays, theme, editor text).
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

	/**
	 * Renderer for this extension's published messages of one kind (including
	 * an override of a built-in kind for this extension's own messages). It
	 * replaces the body of the built-in frame; a throwing renderer degrades to
	 * the built-in body and reports one diagnostic.
	 */
	registerMessageRenderer(kind: string, render: TuiExtensionMessageRenderer): void;

	/**
	 * Whole-frame renderer for this extension's messages of one kind. The
	 * context's renderBody() supplies the message-renderer-or-built-in body,
	 * so an entry renderer wraps whatever the body would have been.
	 */
	registerEntryRenderer(kind: string, render: TuiExtensionEntryRenderer): void;

	/**
	 * Mount a component into a named layout slot. The key is namespaced to the
	 * extension, so two extensions cannot collide; re-setting the same key
	 * replaces the widget, and a undefined factory removes it. Removal and
	 * replacement both dispose the previous component.
	 */
	setWidget(key: string, factory: TuiExtensionComponentFactory | undefined, options: TuiExtensionWidgetOptions): void;

	/** An extension segment appended after the built-in footer. */
	setFooter(factory: TuiExtensionComponentFactory | undefined): void;

	/** An extension segment appended after the built-in header. */
	setHeader(factory: TuiExtensionComponentFactory | undefined): void;

	/**
	 * Open a component on the application overlay stack. Extension overlays are
	 * dismissible by default (interrupt closes them before the agent); the
	 * returned handle closes the overlay, and the host closes anything still
	 * open when the extension is disposed.
	 */
	showOverlay(component: Component, options?: ShowOverlayOptions): AppOverlayHandle;

	/** The editor's current draft text. */
	getEditorText(): string;

	/** Replace the editor's draft text. */
	setEditorText(text: string): void;

	/** Insert text at the cursor, keeping the rest of the draft. */
	pasteToEditor(text: string): void;

	/**
	 * The live theme holder: paints read through it always reflect the active
	 * theme, so components can capture it once at factory time.
	 */
	readonly theme: Theme;

	/** Switch the active theme by name; false when the name is unknown. */
	setTheme(name: string): boolean;

	/** Every registered theme, the default first. */
	getAllThemes(): ThemeInfo[];

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
