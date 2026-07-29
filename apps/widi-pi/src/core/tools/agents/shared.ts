import { formatError } from "../../../utils/errors.ts";
import type { AgentBrief, ToolAgentHost } from "../../agent-host.ts";
import type { BackgroundJobTable } from "../../background/index.ts";
import { formatAgentTaskMessageBody } from "../../message.ts";
import type { ToolExecutionContext } from "../types.ts";

/** Longest job description kept for a delegated task. */
const MAX_TASK_DESCRIPTION_LENGTH = 80;

export function requireAgentHost<TDetails>(
	context: ToolExecutionContext<TDetails>,
): ToolAgentHost {
	const host = context.agents;
	if (!host) {
		throw new Error(
			"Agent collaboration is not available in this runtime, so there are no other agents to work with.",
		);
	}
	return host;
}

/**
 * Resolve a target the caller named, refusing the two ways it can be unusable.
 * `addressable` is not the same question as `status`: an agent partway through
 * dispose still reports `idle` for the whole teardown, and work handed to it
 * there would be accepted after the sweep that was supposed to cancel it.
 */
export function requireAddressableAgent(
	host: ToolAgentHost,
	agentId: string,
): AgentBrief {
	const brief = host.describe(agentId);
	if (!brief) {
		throw new Error(
			`Unknown agent: ${agentId}. Use list_agents to see which agents exist.`,
		);
	}
	if (!brief.addressable) {
		throw new Error(
			`Agent ${agentId} can no longer be given work (status: ${brief.status}).`,
		);
	}
	return brief;
}

export interface AssignedAgentTask {
	/** The owner's job id, which is the whole task identity. */
	readonly taskId: string;
}

/**
 * Delegate one task: a job in the caller's own table whose settler is the
 * worker, plus the message that tells the worker it now owns that task.
 *
 * The validation, the job, and the move to the background all happen in one
 * synchronous block, before the first await. `disposeAgent` marks the worker
 * unaddressable and sweeps the jobs it owes in a single synchronous window of
 * its own, so a job registered after an await here could land behind the sweep
 * that was supposed to cancel it and would then never settle.
 */
export async function assignAgentTask(input: {
	readonly host: ToolAgentHost;
	readonly table: BackgroundJobTable | undefined;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly targetAgentId: string;
	readonly message: string;
}): Promise<AssignedAgentTask> {
	const { host, table, targetAgentId, message } = input;
	if (!table) {
		throw new Error(
			"No background job registry is available, so a task cannot be tracked.",
		);
	}
	requireAddressableAgent(host, targetAgentId);
	const job = table.create({
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		description: summarizeTask(message),
		origin: { kind: "external", settlerId: targetAgentId },
	});
	table.background(job.id);

	// From here the job exists and every backgrounded job owes exactly one
	// result message, so a failed assignment has to retire it rather than leave
	// the caller waiting. Aborting is what the owner is allowed to do: the job's
	// settlement authority belongs to the worker, and the table completes an
	// aborted external job itself.
	let outcome: Awaited<ReturnType<ToolAgentHost["send"]>>;
	try {
		outcome = await host.send(
			targetAgentId,
			formatAgentTaskMessageBody({
				ownerAgentId: host.agentId,
				taskId: job.id,
				task: message,
			}),
		);
	} catch (error) {
		table.abort(
			job.id,
			`Task ${job.id} was never assigned: ${formatError(error)}`,
		);
		throw error;
	}
	if (outcome.kind === "blocked") {
		const reason = outcome.reason
			? `${outcome.blockedBy}: ${outcome.reason}`
			: `blocked by ${outcome.blockedBy}`;
		table.abort(job.id, `Task ${job.id} was never assigned: ${reason}`);
		throw new Error(
			`The task message to agent ${targetAgentId} was blocked (${reason}), so no task was assigned.`,
		);
	}
	return { taskId: job.id };
}

/** Model-facing note describing what the caller now holds for a new task. */
export function describeAssignedTask(
	taskId: string,
	targetAgentId: string,
): string {
	return (
		`Task ${taskId} was assigned to agent ${targetAgentId}. It is tracked as a ` +
		`background job: its outcome arrives later as a background job result ` +
		`message referencing ${taskId}. Use wait_for_jobs to block on it, or ` +
		`kill_job to cancel the task without disposing the agent. read_job ` +
		`reports only its status - a delegated task streams no output.`
	);
}

/** First meaningful line of the task, collapsed and elided for the job label. */
function summarizeTask(message: string): string | undefined {
	const line = message
		.split("\n")
		.map((candidate) => candidate.replace(/\s+/g, " ").trim())
		.find((candidate) => candidate.length > 0);
	if (line === undefined) return undefined;
	return line.length > MAX_TASK_DESCRIPTION_LENGTH
		? `${line.slice(0, MAX_TASK_DESCRIPTION_LENGTH - 1)}…`
		: line;
}
