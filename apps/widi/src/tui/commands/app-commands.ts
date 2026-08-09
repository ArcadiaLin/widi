import { diagnosticGlyph } from "../components/common.ts";
import type { DiagnosticsLog } from "../diagnostics-log.ts";
import { diagnosticSource, formatDiagnosticRecord } from "../diagnostics-log.ts";
import { singleLine } from "../format.ts";
import { VOICE_PACK_IDS, type VoicePackId } from "../voice.ts";
import type { CommandDefinition } from "./types.ts";

const VOICE_PACK_DESCRIPTIONS: Readonly<Record<VoicePackId, string>> = {
	off: "Plain wording: Working, Done, Stopped.",
	peon: "Orc peon.",
	peasant: "Human peasant.",
	random: "Either voice, rolled per line.",
};

function isVoicePackId(value: string): value is VoicePackId {
	return (VOICE_PACK_IDS as readonly string[]).includes(value);
}

/**
 * Application-level actions exposed to application-owned commands. quit()
 * must be fire-and-forget: the TUI awaits in-flight submit tasks during
 * shutdown, so awaiting shutdown inside a command's execute would deadlock
 * the submit task that is running the command.
 */
export interface ApplicationCommandHost {
	quit(): void;
	/** Close the current agent and stage an empty session on the same profile. */
	newSession(sourceAgentId: string | undefined): Promise<void>;
	disposeAgent(agentId: string): Promise<void>;
	readonly diagnostics: DiagnosticsLog;
	/** Put text on the system clipboard; throws when no clipboard could be reached. */
	copyText(text: string): Promise<void>;
	setVoicePack(pack: VoicePackId): void;
}

/** Commands that operate on the application itself, not the orchestrator. */
export function applicationCommands(host: ApplicationCommandHost): readonly CommandDefinition[] {
	const quit = async () => {
		host.quit();
		return undefined;
	};
	// One conversation ends and an empty one begins on the same role: the two
	// names users reach for mean the same thing, so they are the same command.
	const newSession = async (context: { agentId?: string }) => {
		await host.newSession(context.agentId);
		return undefined;
	};
	return [
		{ kind: "action", agentPolicy: "runtime", name: "quit", description: "Exit the application.", execute: quit },
		{ kind: "action", agentPolicy: "runtime", name: "exit", description: "Exit the application.", execute: quit },
		{
			kind: "action",
			agentPolicy: "runtime",
			name: "new",
			description: "Close the current agent and start a new session on the same profile.",
			execute: newSession,
		},
		{
			kind: "action",
			agentPolicy: "runtime",
			name: "clear",
			description: "Close the current agent and start a new session on the same profile.",
			execute: newSession,
		},
		{
			kind: "action",
			agentPolicy: "runtime",
			name: "diagnostics",
			description: "Browse the warnings and errors reported this session.",
			argumentHint: "[entry]",
			argumentCompletes: true,
			// Severity, code, source and phase all live in the label because the
			// selector filters on label and value only: "extension" narrows to
			// what the extensions reported, "startup" to the boot batch.
			complete: async () =>
				host.diagnostics
					.list()
					.map((record) => ({
						value: record.id,
						label: `${diagnosticGlyph(record.diagnostic)} ${record.diagnostic.code}${
							record.count > 1 ? ` ×${record.count}` : ""
						} · ${diagnosticSource(record.diagnostic)} · ${record.phase}`,
						description: singleLine(record.diagnostic.message, 200),
					})),
			// Reached with an empty argument only when there is nothing to pick
			// from: with candidates the engine opens the selector instead.
			execute: async (_context, argument) => {
				const id = argument.trim();
				if (!id) return "No diagnostics reported this session.";
				const record = host.diagnostics.get(id);
				if (!record) throw new Error(`No diagnostic ${id} was reported this session.`);
				await host.copyText(formatDiagnosticRecord(record));
				return `Copied ${record.diagnostic.code} to the clipboard.`;
			},
		},
		{
			kind: "action",
			agentPolicy: "runtime",
			name: "voice",
			description: "Choose the voice the working line speaks in.",
			argumentHint: "[pack]",
			argumentCompletes: true,
			complete: async () =>
				VOICE_PACK_IDS.map((id) => ({ value: id, label: id, description: VOICE_PACK_DESCRIPTIONS[id] })),
			execute: async (_context, argument) => {
				const pack = argument.trim();
				if (!isVoicePackId(pack)) {
					throw new Error(`Unknown voice ${pack}. Pick one of ${VOICE_PACK_IDS.join(", ")}.`);
				}
				host.setVoicePack(pack);
				return `Working line voice: ${pack}.`;
			},
		},
		{
			kind: "action",
			agentPolicy: "active",
			name: "dispose",
			description: "Close the current runtime agent without deleting its session.",
			execute: async (context) => {
				if (!context.agentId) {
					throw new Error("Command /dispose requires an active agent.");
				}
				await host.disposeAgent(context.agentId);
				return undefined;
			},
		},
	];
}
