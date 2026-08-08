import { getKeybindings } from "@earendil-works/pi-tui";
import { formatOperationHintKey } from "../components/operation-hint.ts";

/** What an open selector contributes to the operation hint line. */
export interface SelectorHintContext {
	readonly title: string;
	readonly description?: string;
	readonly confirmVerb: "apply" | "switch";
	readonly itemCount: number;
}

export interface SelectorKeyHintOptions {
	/** Include the "type to filter" hint; only selectors with a filter line do. */
	readonly filter?: boolean;
	/** Verb shown for the confirm key; defaults to "select". */
	readonly confirmLabel?: string;
}

/**
 * Bottom key-hint line shared by the selector family: a navigate pair, an
 * optional filter hint, and confirm/cancel, all read from the live keybindings
 * so user remaps show up here.
 */
export function selectorKeyHints(options: SelectorKeyHintOptions = {}): string {
	const keybindings = getKeybindings();
	const key = (action: Parameters<typeof keybindings.getKeys>[0]): string | undefined => {
		const keyId = keybindings.getKeys(action)[0];
		return keyId ? formatOperationHintKey(keyId) : undefined;
	};
	const keyAction = (action: Parameters<typeof keybindings.getKeys>[0], label: string): string | undefined => {
		const keyId = key(action);
		return keyId ? `${keyId} ${label}` : undefined;
	};
	const navigate = [key("tui.select.up"), key("tui.select.down")]
		.filter((candidate): candidate is string => candidate !== undefined)
		.join("/");
	const parts = [
		navigate ? `${navigate} navigate` : undefined,
		options.filter ? "type to filter" : undefined,
		keyAction("tui.select.confirm", options.confirmLabel ?? "select"),
		keyAction("tui.select.cancel", "cancel"),
	];
	return parts.filter((part): part is string => part !== undefined).join("  ");
}
