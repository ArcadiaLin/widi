/**
 * Every text a background job puts in front of the model.
 *
 * A job speaks to the model exactly twice: the t0 handle that replaces its real
 * tool result, and the t1 message that delivers the outcome after that tool
 * call is long closed. Both have to be self-describing, because by the time
 * either is read the conversation has moved on. Keeping them together keeps the
 * two halves of that protocol - and the header a resume matches against - in
 * one place.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { formatError } from "../../utils/errors.ts";
import {
	type BackgroundJobOutcome,
	type BackgroundJobSettlement,
	type BackgroundJobStatus,
	backgroundJobToolLabel,
} from "./job.ts";

/**
 * Structured details attached to the immediate t0 tool result of a backgrounded
 * call. `backgrounded: true` marks the result as a job handle rather than the
 * tool's real output.
 */
export interface BackgroundJobStartedDetails {
	readonly jobId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	/** The name the call gave this job, when it named one. */
	readonly name?: string;
	readonly backgrounded: true;
}

/**
 * Build the immediate t0 tool result for a call that was moved to the
 * background. The text tells the model the handle-first result is not the real
 * output and that the outcome will arrive later as a separate message, so it
 * must not block on it.
 */
export function createBackgroundJobStartedResult(input: {
	jobId: string;
	toolCallId: string;
	toolName: string;
	name?: string;
}): AgentToolResult<BackgroundJobStartedDetails> {
	const details: BackgroundJobStartedDetails = {
		jobId: input.jobId,
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		...(input.name === undefined ? undefined : { name: input.name }),
		backgrounded: true,
	};
	const text =
		`Tool call ${input.toolCallId} (${backgroundJobToolLabel(input)}) is still running and has ` +
		`moved to the background as job ${input.jobId}. It keeps running; its result ` +
		`will arrive later as a separate background job result message that references ` +
		`job ${input.jobId}. Do not block waiting on it: continue with other work and ` +
		`react to that later message when it arrives. Use read_job to inspect its ` +
		`live output, wait_for_jobs to block until it settles, or kill_job to ` +
		`terminate it.`;
	return { content: [{ type: "text", text }], details };
}

/**
 * Leading, self-describing part of a settled job's message text. It is the
 * durable identity of "this job's outcome was told to the model": a resume
 * looks for it in the session history to decide whether a t0 handle recorded by
 * a previous run still owes the model a result. The tool call id is what makes
 * it unambiguous - job ids restart from 1 in every runtime, tool call ids do
 * not repeat within a session.
 */
export function backgroundJobResultHeaderPrefix(
	jobId: string,
	toolCallId: string,
): string {
	return `Background job ${jobId} (started by tool call ${toolCallId},`;
}

/** Model-facing text for a settled job, from facts rather than a live job. */
export function formatBackgroundJobResultText(input: {
	jobId: string;
	toolCallId: string;
	toolName: string;
	status: BackgroundJobStatus;
	resultText: string;
}): string {
	const header = `${backgroundJobResultHeaderPrefix(input.jobId, input.toolCallId)} tool ${input.toolName}) ${input.status}:`;
	const body = input.resultText.trim();
	return body ? `${header}\n\n${body}` : header;
}

/**
 * Closing message for a job that a previous runtime left unsettled. The work
 * itself could not survive the exit - a local job is a promise in a process
 * that is gone - so the only honest outcome is a cancellation, and the model
 * needs it because it is still holding that job's t0 handle.
 */
export function formatInterruptedBackgroundJobResultText(input: {
	jobId: string;
	toolCallId: string;
	toolName: string;
	stopReason?: string;
}): string {
	return formatBackgroundJobResultText({
		jobId: input.jobId,
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		status: "cancelled",
		resultText:
			input.stopReason ??
			"The job was still running when the runtime exited. It did not survive the restart and produced no result; start it again if its work is still needed.",
	});
}

/**
 * Model-facing text for a settled background job, ready to inject as a user
 * message (t1). Reuses the self-describing header and derives the body from the
 * outcome: the tool's text content when it resolved, otherwise the error, the
 * stop reason, or a short cancellation note.
 */
export function formatBackgroundJobResultMessageText(
	settlement: BackgroundJobSettlement,
): string {
	return formatBackgroundJobResultText({
		jobId: settlement.job.id,
		toolCallId: settlement.job.toolCallId,
		toolName: settlement.job.toolName,
		status: settlement.outcome.status,
		resultText: extractBackgroundJobOutcomeText(settlement),
	});
}

function extractBackgroundJobOutcomeText(
	settlement: BackgroundJobSettlement,
): string {
	const { outcome, job } = settlement;
	if (outcome.result) {
		return outcome.result.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("");
	}
	const errorText =
		outcome.error === undefined ? undefined : formatError(outcome.error);
	// An explicit stop reason explains why cancellation was requested, while the
	// tool error can still contain useful partial output. Preserve both unless
	// settlement derived the reason directly from that same error.
	if (job.stopReason !== undefined && job.stopReason.length > 0) {
		return errorText && errorText !== job.stopReason
			? `${job.stopReason}\n\n${errorText}`
			: job.stopReason;
	}
	if (outcome.status === "cancelled" && errorText === undefined) {
		return "The job was cancelled before it produced a result.";
	}
	if (errorText !== undefined) return errorText;
	return "";
}

/** Fill the terminal reason when no earlier abort supplied a more specific one. */
export function stopReasonFromOutcome(
	outcome: BackgroundJobOutcome,
): string | undefined {
	if (outcome.status === "completed") return undefined;
	if (outcome.error !== undefined) return formatError(outcome.error);
	return outcome.status === "cancelled"
		? "The job was cancelled."
		: "The job failed.";
}
