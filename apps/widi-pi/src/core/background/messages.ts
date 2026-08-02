/**
 * Every text a background job puts in front of the model: the t0 handle that
 * replaces its real tool result, and the t1 message that delivers the outcome
 * after that call is long closed. Both must be self-describing, because by the
 * time either is read the conversation has moved on.
 */

import type { TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@widi/agent-core";
import { formatError } from "../../utils/errors.ts";
import type {
	BackgroundJobOutcome,
	BackgroundJobSettlement,
	BackgroundJobStatus,
} from "./types.ts";

/** How a job is named next to other jobs: `bash "git pull"`, or just `bash`. */
export function backgroundJobToolLabel(job: {
	readonly toolName: string;
	readonly name?: string;
}): string {
	return job.name ? `${job.toolName} "${job.name}"` : job.toolName;
}

/** t0 details. `backgrounded: true` marks a job handle, not the real output. */
export interface BackgroundJobStartedDetails {
	readonly jobId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	/** The name the call gave this job, when it named one. */
	readonly name?: string;
	readonly backgrounded: true;
}

/**
 * The t0 tool result. Its text has to say that this is not the real output and
 * that the outcome arrives later, so the model does not block on it.
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
 * The durable identity of "this job's outcome was told to the model": a resume
 * matches it against the session history. The tool call id is what makes it
 * unambiguous, since job ids restart from 1 in every runtime.
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
 * Closing message for a job a previous runtime left unsettled. A local job is a
 * promise in a process that is gone, so cancellation is the only honest outcome
 * - and the model needs it, because it still holds that job's t0 handle.
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

/** The t1 message: the same header, plus a body derived from the outcome. */
export function formatBackgroundJobResultMessageText(
	settlement: BackgroundJobSettlement,
): string {
	return formatBackgroundJobResultText({
		jobId: settlement.job.jobId,
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
	// A stop reason explains why cancellation was requested; the error can still
	// carry partial output. Keep both unless one was derived from the other.
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
