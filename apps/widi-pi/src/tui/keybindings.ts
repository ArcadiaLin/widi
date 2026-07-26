import {
	getKeybindings,
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
		"app.jobs.expand": true;
		"app.steer": true;
		"app.request.open": true;
		"app.request.previous": true;
		"app.request.next": true;
		"app.request.toggle": true;
		"app.request.option1": true;
		"app.request.option2": true;
		"app.request.option3": true;
		"app.request.option4": true;
		"app.request.option5": true;
		"app.request.option6": true;
		"app.request.option7": true;
		"app.request.option8": true;
		"app.request.option9": true;
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
	"app.jobs.expand": {
		defaultKeys: "ctrl+t",
		description: "Toggle expanded background job panel",
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
		defaultKeys: ["right", "tab"],
		description: "Focus the next request tab",
	},
	"app.request.toggle": {
		defaultKeys: "space",
		description: "Toggle the highlighted option in a multi-select request",
	},
	"app.request.option1": {
		defaultKeys: "1",
		description: "Choose the first option in a human request",
	},
	"app.request.option2": {
		defaultKeys: "2",
		description: "Choose the second option in a human request",
	},
	"app.request.option3": {
		defaultKeys: "3",
		description: "Choose the third option in a human request",
	},
	"app.request.option4": {
		defaultKeys: "4",
		description: "Choose the fourth option in a human request",
	},
	"app.request.option5": {
		defaultKeys: "5",
		description: "Choose the fifth option in a human request",
	},
	"app.request.option6": {
		defaultKeys: "6",
		description: "Choose the sixth option in a human request",
	},
	"app.request.option7": {
		defaultKeys: "7",
		description: "Choose the seventh option in a human request",
	},
	"app.request.option8": {
		defaultKeys: "8",
		description: "Choose the eighth option in a human request",
	},
	"app.request.option9": {
		defaultKeys: "9",
		description: "Choose the ninth option in a human request",
	},
} as const satisfies KeybindingDefinitions;

const REQUEST_OPTION_KEYS = [
	"app.request.option1",
	"app.request.option2",
	"app.request.option3",
	"app.request.option4",
	"app.request.option5",
	"app.request.option6",
	"app.request.option7",
	"app.request.option8",
	"app.request.option9",
] as const;

/**
 * The 0-based index of the number key just pressed (1 → 0, 9 → 8), or
 * undefined when the input is not one of the option shortcuts. Callers map the
 * index onto the request's options list themselves.
 */
export function matchRequestOptionIndex(data: string): number | undefined {
	const keybindings = getKeybindings();
	for (let index = 0; index < REQUEST_OPTION_KEYS.length; index++) {
		if (keybindings.matches(data, REQUEST_OPTION_KEYS[index])) return index;
	}
	return undefined;
}

export function createWidiKeybindings(): KeybindingsManager {
	return new KeybindingsManager({
		...TUI_KEYBINDINGS,
		...WIDI_KEYBINDINGS,
	});
}
