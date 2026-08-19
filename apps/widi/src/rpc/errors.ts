/**
 * The failure classification an RPC client codes against.
 *
 * Core's own codes are deliberately not it. `OrchestratorError` carries
 * diagnostic codes (`orchestrator.agent_busy`), `MessageError` a second
 * vocabulary (`target_unavailable`), `AgentHarnessError` a third (`busy`), and
 * none of the three is a protocol contract - they belong to core and change
 * with it. Putting them on the wire would make every core rename a breaking
 * protocol change, and would still leave the client with no code at all for the
 * failures that are none of those three.
 *
 * So this list is small and answers one question, the only one a batch runner
 * has: what does this failure mean for the next attempt. Two codes exist purely
 * to answer it - `agent_busy` says the same command may work later,
 * `agent_unavailable` says it never will.
 */

import { AgentHarnessError } from "@arcadialin/agent-core";
import { OrchestratorError } from "../core/diagnostics.ts";
import { AgentGoneError } from "../core/host.ts";
import { MessageError } from "../core/message.ts";

export type RpcErrorCode =
	/** The frame was wrong. Retrying it unchanged cannot help. */
	| "invalid_command"
	/** No agent by that id, in this runtime, ever. */
	| "unknown_agent"
	/** The target is occupied. The same command may succeed later. */
	| "agent_busy"
	/** The target exists but can never accept this again. Waiting does not help. */
	| "agent_unavailable"
	| "model_unavailable"
	/** A deadline expired. See `docs/rpc.md` section 6 for the state each leaves. */
	| "timeout"
	/** Withdrawn by a `cancel`, an `abort`, or a disposal. */
	| "aborted"
	/** The runtime is closing; nothing new is accepted. */
	| "shutting_down"
	/** Unclassified. A client can only report it. */
	| "internal";

/** A failure raised by the RPC layer itself, already classified. */
export class RpcError extends Error {
	readonly code: RpcErrorCode;

	constructor(code: RpcErrorCode, message: string) {
		super(message);
		this.name = "RpcError";
		this.code = code;
	}
}

/**
 * Every failure gets a code. `internal` is the honest answer for an error whose
 * origin says nothing about retrying, and it is a code the client can branch on
 * - which "no code at all" was not.
 */
export function classifyError(error: unknown): RpcErrorCode {
	if (error instanceof RpcError) return error.code;
	if (error instanceof OrchestratorError) return fromOrchestratorCode(error.code);
	// Raised by the waits, not by a command against the agent: whoever the wait
	// depended on was torn down under it, and repeating the wait cannot help.
	if (error instanceof AgentGoneError) return "agent_unavailable";
	if (error instanceof MessageError) {
		switch (error.code) {
			case "message_invalid":
				return "invalid_command";
			case "target_busy":
				return "agent_busy";
			case "target_unavailable":
				return "agent_unavailable";
		}
	}
	if (error instanceof AgentHarnessError) {
		switch (error.code) {
			case "busy":
			case "invalid_state":
			case "compaction":
			case "branch_summary":
				return "agent_busy";
			case "shutdown":
				return "agent_unavailable";
			case "invalid_argument":
				return "invalid_command";
			default:
				return "internal";
		}
	}
	// A signal the RPC layer did not raise itself - core's own aborts arrive as
	// OrchestratorError, so this is a plain DOMException from somewhere below.
	if (error instanceof Error && error.name === "AbortError") return "aborted";
	return "internal";
}

function fromOrchestratorCode(code: string): RpcErrorCode {
	switch (code) {
		case "orchestrator.agent_unknown":
			return "unknown_agent";
		case "orchestrator.agent_gone":
			return "agent_unavailable";
		// Still being created: the id is real and the command works once it is live.
		case "orchestrator.agent_creating":
			return "agent_busy";
		case "orchestrator.agent_busy":
			return "agent_busy";
		case "orchestrator.agent_not_forkable":
		case "orchestrator.invalid_argument":
			return "invalid_command";
		case "orchestrator.shutdown":
			return "shutting_down";
		case "orchestrator.agent_creation_cancelled":
			return "aborted";
		case "orchestrator.human_request_timeout":
			return "timeout";
		case "orchestrator.human_request_aborted":
		case "orchestrator.human_request_cancelled":
			return "aborted";
		default:
			return "internal";
	}
}
