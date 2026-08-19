/**
 * The frame stream as a person reads it.
 *
 * Deliberately not `tui/event-projector.ts`. That one maintains the timeline
 * model a terminal renders and re-renders from - selections, collapsed blocks,
 * a live footer - and none of it survives being written to a pipe. What is left
 * once you take the screen away is a small, forward-only rendering, and a small
 * one is what this is: assistant text as it streams, a line per tool call, a
 * line per extension event, and the report and the totals at the end.
 *
 * Two rules shape it. Assistant text goes out raw so `widi -p "..." > answer.md`
 * is the answer and not a transcript of one; everything else is prefixed, so
 * the two are told apart without a parser. And the agent id is written only when
 * the speaker changes, because a delegating run interleaves and an unlabelled
 * interleaving reads as one agent contradicting itself.
 */

import type { AgentId } from "../core/types.ts";
import type { WireHarnessEvent, WireOrchestratorEvent } from "../rpc/wire-event.ts";
import type { PrintFrame, PrintRunSummaryFrame } from "./frames.ts";
import type { PrintOutput, PrintWriter } from "./output.ts";

/** Beyond this a tool's arguments stop informing and start burying the output. */
const MAX_ARGUMENT_CHARS = 160;

export class PrintTextOutput implements PrintOutput {
	private readonly _writer: PrintWriter;
	private readonly _note: (text: string) => void;
	private _speaker: AgentId | undefined;
	private _atLineStart = true;

	constructor(options: { readonly writer: PrintWriter; readonly note?: (text: string) => void }) {
		this._writer = options.writer;
		this._note = options.note ?? (() => {});
	}

	emit(frame: PrintFrame): void {
		switch (frame.type) {
			case "ready":
				for (const diagnostic of frame.diagnostics) {
					this._note(`widi print: ${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.message}\n`);
				}
				return;
			case "event":
				this._event(frame.event);
				return;
			case "extension_event": {
				const payload = frame.event.payload === undefined ? "" : ` ${compact(frame.event.payload)}`;
				this._line(`« ${frame.event.name} [${frame.event.sourceExtensionId}]${payload}`);
				return;
			}
			case "report":
				this._line("");
				this._line("--- report ---");
				this._raw(frame.report === undefined ? "(the root agent's last run produced no text)\n" : `${frame.report}\n`);
				return;
			case "run_summary":
				this._summary(frame);
				return;
		}
	}

	async drain(): Promise<void> {
		await this._writer.drain();
	}

	private _event(event: WireOrchestratorEvent): void {
		switch (event.type) {
			case "agent_harness_event":
				this._harnessEvent(event.agentId, event.event);
				return;
			case "agent_spawned":
				this._line(`+ agent ${event.agentId} (${event.profile.id})`);
				return;
			case "agent_disposed":
				this._line(`- agent ${event.agentId}${event.reason === undefined ? "" : `: ${event.reason}`}`);
				return;
			case "input_blocked":
				this._line(`! input blocked by ${event.blockedBy}${event.reason === undefined ? "" : `: ${event.reason}`}`);
				return;
			case "extension_output":
			case "extension_notification":
				this._line(`« ${event.extensionId}: ${event.text}`);
				return;
			case "human_request_pending":
				// Nothing can answer it here; the broker is about to fail it. Saying so
				// is the difference between a confusing run and an explained one.
				this._line(`? unattended human request: ${event.request.title}`);
				return;
			case "diagnostic":
				this._note(`widi print: ${event.diagnostic.severity}: ${event.diagnostic.code}: ${event.diagnostic.message}\n`);
				return;
			default:
				return;
		}
	}

	private _harnessEvent(agentId: AgentId, event: WireHarnessEvent): void {
		switch (event.type) {
			case "message_update": {
				const inner = event.assistantMessageEvent;
				if (inner.type !== "text_delta" || inner.delta === "") return;
				this._speak(agentId);
				this._raw(inner.delta);
				return;
			}
			case "message_end":
				if (event.message.role === "assistant") this._endLine();
				return;
			case "tool_execution_start":
				this._line(`→ ${event.toolName} ${compact(event.args)}`);
				return;
			case "tool_execution_end":
				if (event.isError) this._line(`! ${event.toolName} failed`);
				return;
			case "session_compact":
				this._line("· context compacted");
				return;
			default:
				return;
		}
	}

	private _summary(frame: PrintRunSummaryFrame): void {
		const { total, durationMs } = { total: frame.summary.total, durationMs: frame.summary.durationMs };
		const tools = Object.entries(total.tools.byName)
			.map(([name, count]) => `${name}×${count}`)
			.join(" ");
		this._line("");
		this._line("--- run ---");
		this._line(`status       ${frame.status} (exit ${frame.exitCode})`);
		if (frame.error !== undefined) this._line(`error        ${frame.error}`);
		this._line(`duration     ${durationMs}ms across ${frame.summary.agents.length} agent(s)`);
		this._line(
			`turns        ${total.turns}, ${total.providerResponses} provider response(s), ${total.providerErrors} error(s)`,
		);
		this._line(
			`tokens       ${total.turnUsage.totalTokens} (in ${total.turnUsage.input}, out ${total.turnUsage.output}, cache ${total.turnUsage.cacheRead}/${total.turnUsage.cacheWrite})`,
		);
		this._line(`cost         ${total.turnUsage.cost.total}`);
		this._line(
			`tools        ${total.tools.calls} call(s), ${total.tools.failed} failed${tools === "" ? "" : ` — ${tools}`}`,
		);
		if (total.maintenance.compactions > 0 || total.maintenance.branchSummaries > 0) {
			this._line(
				`maintenance  ${total.maintenance.compactions} compaction(s), ${total.maintenance.branchSummaries} branch summary/summaries, ${total.maintenance.usage.totalTokens} token(s)`,
			);
		}
		if (total.humanRequests > 0) this._line(`human        ${total.humanRequests} request(s) nobody could answer`);
	}

	/** Label the speaker when it changes, so an interleaved tree stays readable. */
	private _speak(agentId: AgentId): void {
		if (this._speaker === agentId) return;
		this._speaker = agentId;
		this._line(`[${agentId}]`);
	}

	private _line(text: string): void {
		this._endLine();
		this._writer.write(`${text}\n`);
	}

	private _endLine(): void {
		if (this._atLineStart) return;
		this._writer.write("\n");
		this._atLineStart = true;
	}

	private _raw(text: string): void {
		if (text === "") return;
		this._writer.write(text);
		this._atLineStart = text.endsWith("\n");
	}
}

function compact(value: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? String(value);
	} catch {
		serialized = String(value);
	}
	const oneLine = serialized.replace(/\s+/g, " ");
	return oneLine.length <= MAX_ARGUMENT_CHARS ? oneLine : `${oneLine.slice(0, MAX_ARGUMENT_CHARS)}…`;
}
