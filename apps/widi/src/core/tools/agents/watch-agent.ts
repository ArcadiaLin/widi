import { type Static, Type } from "typebox";
import { AgentGoneError, type AgentStop, type AgentToOrchestratorHost } from "../../host.ts";
import type { AgentNotice } from "../../message.ts";
import type { AgentId } from "../../types.ts";
import type { ToolDefinition } from "../types.ts";
import { requireAgentHost } from "./shared.ts";

/**
 * `taken` means another agent already watches the target: a stop has exactly
 * one reader. The rest mirror the dispose vocabulary.
 */
export type AgentWatchOutcome = "watching" | "not_watching" | "taken" | "outside_tree" | "self" | "unknown";

/**
 * Who is waiting on whom, and the reporting that follows from it.
 *
 * The runtime answers three questions - has this agent stopped, what did it
 * say, put this text in my inbox - and every judgement built on those answers
 * is here: which idles count as a stop, that a stop has one reader, that a
 * subscription is spent on the stop it reports, and what the report says.
 *
 * One table per runtime, since exclusivity is a claim on the target. In memory
 * only - a resume brings back no subagents to watch.
 */
export class AgentWatches {
	private readonly _watchers = new Map<AgentId, AgentId>();

	start(host: AgentToOrchestratorHost, targetAgentId: AgentId): AgentWatchOutcome {
		if (targetAgentId === host.agentId) return "self";
		if (!host.describe(targetAgentId)) return "unknown";
		if (!host.sharesTree(targetAgentId)) return "outside_tree";
		const current = this._watchers.get(targetAgentId);
		if (current === host.agentId) return "watching";
		if (current !== undefined) return "taken";
		this._watchers.set(targetAgentId, host.agentId);
		void this._report(host, targetAgentId);
		return "watching";
	}

	/** Never fails: whatever the reason, the caller is not watching afterwards. */
	stop(host: AgentToOrchestratorHost, targetAgentId: AgentId): AgentWatchOutcome {
		if (this._watchers.get(targetAgentId) === host.agentId) this._watchers.delete(targetAgentId);
		return "not_watching";
	}

	isWatchedBy(targetAgentId: AgentId, watcherAgentId: AgentId): boolean {
		return this._watchers.get(targetAgentId) === watcherAgentId;
	}

	/** Whether this agent is itself waiting on a subagent. */
	private _holdsWatches(agentId: AgentId): boolean {
		for (const watcherAgentId of this._watchers.values()) {
			if (watcherAgentId === agentId) return true;
		}
		return false;
	}

	/**
	 * Wait for a stop worth reporting, report it once, and let the subscription
	 * go. Looping is what keeps the gates below simple: an idle that is not the
	 * agent stopping leaves the subscription armed for the next one.
	 */
	private async _report(host: AgentToOrchestratorHost, targetAgentId: AgentId): Promise<void> {
		for (;;) {
			let stop: AgentStop;
			try {
				stop = await host.waitForAgentStop(targetAgentId);
			} catch (error) {
				if (!this.isWatchedBy(targetAgentId, host.agentId)) return;
				this._watchers.delete(targetAgentId);
				// A watcher that is gone has no turn left to read anything in.
				if (error instanceof AgentGoneError && error.agentId === targetAgentId) {
					await this._deliver(host, targetAgentId, { status: "gone" });
				}
				return;
			}
			if (!this.isWatchedBy(targetAgentId, host.agentId)) return;
			// `ready` and `maintenance` have no turn behind them; live jobs and watches
			// of its own mean it is waiting on work that will wake it.
			if (stop.reason === "ready" || stop.reason === "maintenance") continue;
			if (stop.liveJobCount > 0) continue;
			if (this._holdsWatches(targetAgentId)) continue;
			this._watchers.delete(targetAgentId);
			await this._deliver(host, targetAgentId, { status: "idle", reason: stop.reason });
			return;
		}
	}

	/**
	 * The subscription is revoked before this runs, so a failure loses the notice
	 * rather than duplicating it. Swallowed because the party that would be told
	 * is the one that could not be reached.
	 */
	private async _deliver(host: AgentToOrchestratorHost, targetAgentId: AgentId, notice: AgentNotice): Promise<void> {
		const report = await host.readAgentReport(targetAgentId).catch(() => undefined);
		try {
			await host.notifySelf(targetAgentId, notice, formatNoticeBody(targetAgentId, notice, report));
		} catch {
			return;
		}
	}
}

const watchAgentSchema = Type.Object({
	agentId: Type.String({ description: "Id of the agent to start or stop watching." }),
	watching: Type.Boolean({
		description: "true subscribes to that agent's next stop; false drops a subscription you already hold.",
	}),
});

export type WatchAgentInput = Static<typeof watchAgentSchema>;

export interface WatchAgentDetails {
	readonly agentId: string;
	readonly outcome: AgentWatchOutcome;
}

/**
 * Changing your mind about an agent already running.
 *
 * `spawn_agent` and `send_message` subscribe as they hand over the work, which
 * is the ordering that cannot miss a stop; this tool exists for the case that
 * has no message attached - stop listening to something you no longer care
 * about, or start listening to an agent someone else told you about.
 */
export function createWatchAgentToolDefinition(
	watches: AgentWatches,
): ToolDefinition<typeof watchAgentSchema, WatchAgentDetails> {
	return {
		name: "watch_agent",
		label: "watch_agent",
		description:
			"Start or stop watching an agent. While you watch one, you are told the moment it stops - the notification carries its last message - and the subscription is spent on that one stop. An agent has one watcher at a time. Prefer the watch parameter on spawn_agent and send_message, which subscribes before the work is handed over; use this tool when there is no message to send.",
		promptSnippet: "Start or stop being told when an agent stops",
		promptGuidelines: [
			"Being told is the only reliable signal that an agent finished. Do not poll it with send_message and do not infer from silence that it is still working.",
		],
		parameters: watchAgentSchema,
		execute: async (_toolCallId, { agentId, watching }, context) => {
			const host = requireAgentHost(context);
			const targetAgentId = agentId.trim();
			if (!targetAgentId) {
				throw new Error("watch_agent requires a non-empty agentId.");
			}
			const outcome = watching ? watches.start(host, targetAgentId) : watches.stop(host, targetAgentId);
			// A refused subscription that read as success is the failure this whole
			// mechanism exists to remove: the caller would end its turn waiting for a
			// notification nobody is going to send. Dropping one never fails that way
			// - whatever the reason, the caller is not watching the agent afterwards.
			if (watching && outcome !== "watching") {
				throw new Error(`${describeOutcome(targetAgentId, outcome)} You are not watching it.`);
			}
			return {
				content: [{ type: "text", text: describeOutcome(targetAgentId, outcome) }],
				details: { agentId: targetAgentId, outcome },
			};
		},
	};
}

export function describeOutcome(agentId: string, outcome: AgentWatchOutcome): string {
	switch (outcome) {
		case "watching":
			return `You are watching agent ${agentId}. It will report to you once, when it stops.`;
		case "not_watching":
			return `You are not watching agent ${agentId}; nothing will be reported to you when it stops.`;
		case "taken":
			return `Agent ${agentId} is already watched by another agent, and a stop has exactly one reader.`;
		case "outside_tree":
			return `Agent ${agentId} belongs to another tree, so you cannot watch it. You can still send it messages.`;
		case "self":
			return "An agent cannot watch itself.";
		default:
			return `Unknown agent: ${agentId}.`;
	}
}

/**
 * The body of a lifecycle notice: what the agent last said, then what the
 * watcher can do about it.
 *
 * The closing lines are here rather than in a system prompt because this is
 * where the decision is made. A prompt was read before the context filled up;
 * this text arrives in the turn that has to act on it.
 */
function formatNoticeBody(agentId: AgentId, notice: AgentNotice, report: string | undefined): string {
	if (notice.status === "gone") {
		const closing = `${agentId} was disposed and will not report. You are no longer watching it.`;
		return report ? `${report}\n\n${closing}` : closing;
	}
	const state =
		notice.reason === "aborted"
			? `${agentId} was interrupted and stopped`
			: `${agentId} is idle and will not continue on its own`;
	return [
		// A run that ended without a word is a fact the watcher has to be told, not
		// a reason to stay silent: it is exactly the case the old voluntary report
		// lost, and an empty notification body would read as a delivery bug.
		report ?? `${agentId} stopped without a closing message.`,
		`${state}. You are no longer watching it. Continue it with send_message, or dispose_agent to release it.`,
	].join("\n\n");
}
