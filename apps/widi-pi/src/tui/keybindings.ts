import {
	type KeybindingDefinitions,
	KeybindingsManager,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"app.agents.open": true;
		"app.interrupt": true;
		"app.exit": true;
		"app.tools.expand": true;
		"app.steer": true;
		"app.request.open": true;
		"app.request.previous": true;
		"app.request.next": true;
	}
}

export const WIDI_KEYBINDINGS = {
	"app.agents.open": {
		defaultKeys: "left",
		description: "Open the agent selector when the editor is empty",
	},
	"app.interrupt": {
		defaultKeys: "escape",
		description: "Close the current interaction or abort the active agent",
	},
	"app.exit": {
		defaultKeys: "ctrl+d",
		description: "Exit when the editor is empty",
	},
	"app.tools.expand": {
		defaultKeys: "ctrl+o",
		description: "Toggle expanded tool output in the transcript",
	},
	"app.steer": {
		defaultKeys: "ctrl+s",
		description: "Send the editor text as a steer to the running agent",
	},
	"app.request.open": {
		defaultKeys: "ctrl+r",
		description: "Jump to the most recent pending human request",
	},
	"app.request.previous": {
		defaultKeys: "left",
		description: "Focus the previous pending human request",
	},
	"app.request.next": {
		defaultKeys: "right",
		description: "Focus the next pending human request",
	},
} as const satisfies KeybindingDefinitions;

export function createWidiKeybindings(): KeybindingsManager {
	return new KeybindingsManager({
		...TUI_KEYBINDINGS,
		...WIDI_KEYBINDINGS,
	});
}
