import type { CommandHost } from "../../src/tui/commands/built-in/index.ts";
import { DiagnosticsLog } from "../../src/tui/diagnostics-log.ts";

/** The application surface commands are built against, with nothing behind it. */
export function stubCommandHost(overrides: Partial<CommandHost> = {}): CommandHost {
	return {
		quit: () => {},
		newAgent: async () => {},
		newSession: async () => {},
		disposeAgent: async () => {},
		switchToAgent: async () => {},
		setEditorText: () => {},
		restoreSubmittedText: () => {},
		diagnostics: new DiagnosticsLog(),
		copyText: async () => {},
		...overrides,
	};
}
