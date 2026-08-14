/**
 * The RPC protocol: three blocks and no fourth.
 *
 * `docs/rpc.md` is the specification and wins over this file when the two
 * disagree; an external client is written against it, not against these types.
 *
 * 1. Commands, a mechanical projection of the orchestrator's public methods
 *    (`apps/widi/docs/orchestrator.md` section 6). Every command that concerns
 *    one agent names it: there is no "current agent" here, because there is
 *    none in core either - `activeAgentId` is TUI state, and agents run
 *    concurrently. They live in `schema.ts` and are re-exported here, so the
 *    validator and the type cannot disagree about them.
 * 2. The event stream, already carrying `agentId` on every frame.
 * 3. Human requests, a two-way channel with correlation ids.
 *
 * The command set stays a projection on purpose. Inventing a verb per method
 * is how pi ended up with two hand-written unions to keep aligned; here a new
 * orchestrator method is a new case and nothing else. `run_summary` is the one
 * exception, and it is one because there is nothing in core to project: it reads
 * what this layer counted while relaying events (`run-summary.ts`).
 *
 * What is written by hand here is the outbound half. It names core's own result
 * types rather than restating them, and a client has no need to validate what
 * this runtime sent it.
 *
 * Scope note: an RPC client is not an agent. It stands where the TUI stands,
 * beside the orchestrator, so it addresses the whole runtime rather than one
 * agent's tree. Commands map to `AgentOrchestrator`, never to the
 * identity-bound `AgentToOrchestratorHost`.
 */

import type { AbortResult, CompactResult } from "@arcadialin/agent-core";
import type { AgentSnapshot } from "../core/agent-types.ts";
import type { CoreDiagnostic } from "../core/diagnostics.ts";
import type { AgentStop } from "../core/host.ts";
import type { HumanRequestEnvelope } from "../core/human-request.ts";
import type { MessageSendOutcome } from "../core/message.ts";
import type { AgentId, PromptOutcome, RuntimeModel } from "../core/types.ts";
import type { RpcErrorCode } from "./errors.ts";
import type { RpcRunSummary } from "./run-summary.ts";
import type { RpcCommandName } from "./schema.ts";
import type { WireOrchestratorEvent } from "./wire-event.ts";

export const RPC_PROTOCOL_VERSION = 1;

export type {
	RpcAgentRunSummary,
	RpcMaintenanceTotals,
	RpcRunSummary,
	RpcRunTotals,
	RpcToolTotals,
	RpcUsageTotals,
} from "./run-summary.ts";
export type {
	RpcCommand,
	RpcCommandName,
	RpcHumanResponseFrame,
	RpcInbound,
} from "./schema.ts";

/** Result payload per command, so a client can discriminate on `cmd`. */
export interface RpcCommandResults {
	spawn: { readonly agentId: AgentId };
	send: MessageSendOutcome;
	prompt: PromptOutcome;
	abort: AbortResult;
	dispose: { readonly agentIds: readonly AgentId[] };
	compact: CompactResult;
	wait_idle: Record<string, never>;
	wait_stop: AgentStop;
	/** The live tree as it stood when it settled, root first. */
	wait_tree_idle: { readonly agentIds: readonly AgentId[] };
	/** Absent when the agent's last run produced no assistant text at all. */
	read_report: { readonly report?: string };
	/** A reading of the RPC layer's own accounting, not a core call. */
	run_summary: RpcRunSummary;
	list_agents: { readonly agents: readonly AgentSnapshot[] };
	inspect: AgentSnapshot;
	set_model: RuntimeModel;
	set_thinking_level: Record<string, never>;
	cancel_human_request: { readonly cancelled: boolean };
	/** False when nothing by that id was in flight, including a command that had already answered. */
	cancel: { readonly cancelled: boolean };
	shutdown: Record<string, never>;
}

/**
 * First frame on the stream. `rootAgentId` is simply the first agent created,
 * with no standing the others lack - there is deliberately no command that only
 * it accepts.
 */
export interface RpcReadyFrame {
	readonly type: "ready";
	readonly protocolVersion: number;
	readonly rootAgentId?: AgentId;
	readonly cwd: string;
	readonly agentDir: string;
	readonly diagnostics: readonly CoreDiagnostic[];
}

/**
 * One command's answer. Distributed over the command names so that narrowing on
 * `ok` and then `cmd` narrows `data` too - a client should not have to assert
 * what the payload of a response it just matched is.
 */
export type RpcSuccessFrame = {
	[TCmd in RpcCommandName]: {
		readonly type: "response";
		readonly id?: string;
		readonly cmd: TCmd;
		readonly ok: true;
		readonly data: RpcCommandResults[TCmd];
	};
}[RpcCommandName];

export interface RpcErrorFrame {
	readonly type: "response";
	readonly id?: string;
	/** Whatever the client asked for, which need not be a known command. */
	readonly cmd: string;
	readonly ok: false;
	/** Human-readable and unstable. Log it; never branch on it. */
	readonly error: string;
	/** Always present. Branch on this. */
	readonly code: RpcErrorCode;
}

export type RpcResponseFrame = RpcSuccessFrame | RpcErrorFrame;

export interface RpcEventFrame {
	readonly type: "event";
	readonly event: WireOrchestratorEvent;
}

export interface RpcHumanRequestFrame {
	readonly type: "human_request";
	readonly request: HumanRequestEnvelope;
}

/**
 * A request the runtime stopped waiting for. It is not an answer to anything the
 * client sent, so it carries no `id`: the client drops the prompt it had open
 * for `requestId` and sends nothing back.
 */
export interface RpcHumanRequestWithdrawnFrame {
	readonly type: "human_request_withdrawn";
	readonly requestId: string;
	readonly reason: string;
}

/** What the human channel alone can write, before any orchestrator exists. */
export type RpcHumanOutboundFrame = RpcHumanRequestFrame | RpcHumanRequestWithdrawnFrame;

export type RpcOutbound = RpcReadyFrame | RpcResponseFrame | RpcEventFrame | RpcHumanOutboundFrame;
