import { Type } from "typebox";
import {
	EXTENSION_API_VERSION,
	type ExtensionDefinition,
} from "../../src/core/extension/api.ts";

export const THIRD_PARTY_NOTE_ENTRY_TYPE = "note";

export interface ThirdPartyObservedFact {
	readonly source: "harness";
	readonly name: string;
}

export interface ThirdPartyExtension {
	readonly definition: ExtensionDefinition;
	readonly observed: ThirdPartyObservedFact[];
}

/**
 * Third-party acceptance consumer (ME slice 10): a versioned extension that
 * combines a tool, a line command, an inline command, and observers while
 * importing nothing but the frozen author contract (`extension/api.ts`) and
 * the upstream types enumerated in the public contract. Closure state stands
 * in for extension-owned data; the note ledger goes through the session
 * custom-entry facade.
 */
export function createThirdPartyExtension(
	glossary: Readonly<Record<string, string>> = {},
): ThirdPartyExtension {
	const observed: ThirdPartyObservedFact[] = [];
	const definition: ExtensionDefinition = {
		apiVersion: EXTENSION_API_VERSION,
		activate: (api) => {
			api.registerTool({
				name: "tp_echo",
				label: "Third-party echo",
				description: "Echo the given text back.",
				parameters: Type.Object({ text: Type.String() }),
				execute: async (_toolCallId, params) => ({
					content: [{ type: "text", text: `echo: ${params.text}` }],
					details: undefined,
				}),
			});
			api.registerCommand({
				name: "tp-note",
				description: "Record a note into the session ledger.",
				handler: async (args, context) => {
					await context.session.appendEntry(THIRD_PARTY_NOTE_ENTRY_TYPE, {
						text: args,
					});
				},
			});
			api.registerCommand({
				name: "tp-term",
				placement: "inline",
				description: "Expand a glossary term.",
				expand: (argument) => glossary[argument] ?? argument,
			});
			api.observe("agent_harness_event", (event) => {
				observed.push({ source: "harness", name: event.event.type });
			});
		},
	};
	return { definition, observed };
}
