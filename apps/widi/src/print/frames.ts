/**
 * What a print run writes: RPC's stream, plus the two frames a run has that a
 * server does not.
 *
 * `ready`, `event` and `extension_event` are RPC's own frames, produced by the
 * same `toWireEvent` projection and carrying the same protocol version. That is
 * the point of reusing them: a benchmark driver parses a print stream and an RPC
 * stream with one set of types, and moving a sample between the two modes costs
 * it nothing.
 *
 * What print adds is an end. A run finishes, and the two facts a driver scores
 * are what the root agent said and what the run cost, so `report` and
 * `run_summary` are the last two frames in that order, always - including the
 * run that hit its deadline, where the partial numbers are exactly what is worth
 * having.
 */

import type { CoreDiagnostic } from "../core/diagnostics.ts";
import type { ExtensionEventEnvelope } from "../core/extension/events.ts";
import type { AgentId } from "../core/types.ts";
import type { RpcRunSummary } from "../rpc/run-summary.ts";
import { RPC_PROTOCOL_VERSION } from "../rpc/types.ts";
import type { WireOrchestratorEvent } from "../rpc/wire-event.ts";
import type { PrintExitCode } from "./types.ts";

/** RPC's number. The two extra frames are additions to that stream, not a dialect. */
export const PRINT_PROTOCOL_VERSION = RPC_PROTOCOL_VERSION;

/** How the run ended, and the only thing worth branching on. */
export type PrintRunStatus = "ok" | "failed" | "deadline_exceeded";

/**
 * First frame on the stream, in RPC's shape. `rootAgentId` is absent only when
 * the run failed before an agent existed.
 */
export interface PrintReadyFrame {
	readonly type: "ready";
	readonly protocolVersion: number;
	readonly rootAgentId?: AgentId;
	readonly cwd: string;
	readonly agentDir: string;
	readonly diagnostics: readonly CoreDiagnostic[];
}

export interface PrintEventFrame {
	readonly type: "event";
	readonly event: WireOrchestratorEvent;
}

export interface PrintExtensionEventFrame {
	readonly type: "extension_event";
	readonly event: ExtensionEventEnvelope;
}

/** Second to last. `report` is absent when the root's last run said nothing. */
export interface PrintReportFrame {
	readonly type: "report";
	readonly agentId?: AgentId;
	readonly report?: string;
}

/** Last. Everything a driver needs to score the run and to know it may stop reading. */
export interface PrintRunSummaryFrame {
	readonly type: "run_summary";
	readonly status: PrintRunStatus;
	readonly exitCode: PrintExitCode;
	/** Human-readable and unstable. Log it; branch on `status`. */
	readonly error?: string;
	readonly summary: RpcRunSummary;
}

export type PrintFrame =
	| PrintReadyFrame
	| PrintEventFrame
	| PrintExtensionEventFrame
	| PrintReportFrame
	| PrintRunSummaryFrame;

export function printExitCode(status: PrintRunStatus): PrintExitCode {
	if (status === "ok") return 0;
	return status === "deadline_exceeded" ? 2 : 1;
}
