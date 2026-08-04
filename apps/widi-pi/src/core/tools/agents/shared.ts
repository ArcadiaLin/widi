import { formatError } from "../../../utils/errors.ts";
import type { BackgroundJobHost } from "../../background/index.ts";
import type { AgentBrief, ToolAgentHost } from "../../host.ts";
import { formatAgentTaskMessageBody } from "../../message.ts";
import type { ToolExecutionContext } from "../types.ts";

/** Longest job description kept for a delegated task. */
const MAX_TASK_DESCRIPTION_LENGTH = 80;

export function requireAgentHost<TDetails>(context: ToolExecutionContext<TDetails>): ToolAgentHost {
	const host = context.agents;
	if (!host) {
		throw new Error("Agent collaboration is not available in this runtime, so there are no other agents to work with.");
	}
	return host;
}

/**
 * Resolve a target the caller named. `describe` answers from the live registry
 * only, so a hit is the whole addressability question: an agent that is being
 * torn down has already left it, and work handed to one there would be accepted
 * after the sweep that was supposed to cancel it.
 */
export function requireAddressableAgent(host: ToolAgentHost, agentId: string): AgentBrief {
	const brief = host.describe(agentId);
	if (!brief) {
		throw new Error(
			`Unknown agent: ${agentId}. list_agents discovers your own tree; a cross-tree target requires an exact id shared with you.`,
		);
	}
	return brief;
}

export interface AssignedAgentTask {
	/** The owner's job id, which is the whole task identity. */
	readonly taskId: string;
}

/**
 * Delegate one task: a job the caller owns whose settler is the worker, plus
 * the message that tells the worker it now owns that task.
 *
 * The target is validated before the job is created, and `createExternal`
 * returns only once the job has a durable head - an assignment whose job left
 * no record is how a task ends up owed by nobody.
 */
export async function assignAgentTask(input: {
	readonly host: ToolAgentHost;
	readonly jobs: BackgroundJobHost | undefined;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly targetAgentId: string;
	readonly message: string;
}): Promise<AssignedAgentTask> {
	const { host, jobs, targetAgentId, message } = input;
	if (!jobs) {
		throw new Error("No background job registry is available, so a task cannot be tracked.");
	}
	requireAddressableAgent(host, targetAgentId);
	const created = await jobs.createExternal({
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		description: summarizeTask(message),
		settlerAgentId: targetAgentId,
	});
	if (!created.ok) {
		throw new Error(`Task for agent ${targetAgentId} could not be created (${created.reason}).`);
	}
	const taskId = created.job.jobId;

	// From here the job exists and every observable job owes exactly one result
	// message, so a failed assignment has to retire it rather than leave the
	// caller waiting. Aborting is what the owner is allowed to do: settlement
	// authority belongs to the worker, and the runtime completes an aborted
	// external job itself.
	let outcome: Awaited<ReturnType<ToolAgentHost["sendMessage"]>>;
	try {
		outcome = await host.sendMessage(
			targetAgentId,
			formatAgentTaskMessageBody({ ownerAgentId: host.agentId, taskId, task: message }),
		);
	} catch (error) {
		jobs.abort(taskId, `Task ${taskId} was never assigned: ${formatError(error)}`);
		throw error;
	}
	if (outcome.kind === "blocked") {
		const reason = outcome.reason ? `${outcome.blockedBy}: ${outcome.reason}` : `blocked by ${outcome.blockedBy}`;
		jobs.abort(taskId, `Task ${taskId} was never assigned: ${reason}`);
		throw new Error(`The task message to agent ${targetAgentId} was blocked (${reason}), so no task was assigned.`);
	}
	return { taskId };
}

/** Model-facing note describing what the caller now holds for a new task. */
export function describeAssignedTask(taskId: string, targetAgentId: string): string {
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
	return line.length > MAX_TASK_DESCRIPTION_LENGTH ? `${line.slice(0, MAX_TASK_DESCRIPTION_LENGTH - 1)}…` : line;
}
