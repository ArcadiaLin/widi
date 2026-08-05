import type { AgentToolResult } from "@widi/agent-core";
import { type Static, Type } from "typebox";
import type { ToolAgentHost } from "../../host.ts";
import type { ToolDefinition } from "../types.ts";
import { assignAgentTask, describeAssignedTask, requireAddressableAgent, requireAgentHost } from "./shared.ts";

const sendMessageSchema = Type.Object({
	agentId: Type.String({
		description: "Id of the agent to send to. For completeTask this is the agent that gave you the task.",
	}),
	message: Type.String({
		description:
			"The text the other agent will read. For a task, state the whole job: it cannot see your conversation.",
	}),
	assignTask: Type.Optional(
		Type.Boolean({
			description:
				"Send this message as a task assignment. You get back a task id that only settles when that agent explicitly reports the task finished.",
		}),
	),
	completeTask: Type.Optional(
		Type.String({
			description:
				"Id of a task the target agent assigned to you; this message is your final report for it. Only the agent that was given the task can settle it.",
		}),
	),
	taskFailed: Type.Optional(
		Type.Boolean({
			description:
				"With completeTask: report the task as failed rather than completed. The message is still delivered as the report.",
		}),
	),
});

export type SendMessageInput = Static<typeof sendMessageSchema>;

export type SendMessageMode = "message" | "assign_task" | "complete_task";

export interface SendMessageDetails {
	readonly targetAgentId: string;
	readonly mode: SendMessageMode;
	/** The new task id for an assignment, or the settled one for a completion. */
	readonly taskId?: string;
}

/**
 * One verb for everything an agent says to another agent.
 *
 * Assigning work, reporting work finished, and plain talk are the same action
 * from the model's side - hand a piece of text to a named agent - and differ
 * only in the bookkeeping the runtime attaches. Splitting them into three
 * lookalike tools invites the failure that matters: a worker that finishes,
 * calls plain `send_message`, and leaves its owner waiting forever. Here the
 * completion is a parameter on the tool it is already holding.
 */
export function createSendMessageToolDefinition(): ToolDefinition<typeof sendMessageSchema, SendMessageDetails> {
	return {
		name: "send_message",
		label: "send_message",
		description:
			"Send a message to another runtime-local agent by exact id. The target may be in another agent tree if its id was shared with you; this tool does not discover ids. Plain: just delivers the text and returns immediately - the other agent reads it on its next turn and may reply with its own send_message. With assignTask: true it is delegated work and you get a task id that settles only when that agent reports back. With completeTask: <taskId> it is your final report for a task someone gave you, which is the only thing that finishes that task.",
		promptSnippet: "Send a message, task, or task report to another agent",
		promptGuidelines: [
			"send_message never blocks: it returns once the other agent has the text, not when it replies. Continue working, or end your turn and wait to be woken by the reply.",
			"list_agents only discovers the agents you spawned, one level down. An exact agent id shared by a human, another agent, or an incoming message is enough to reach any other agent, at any level or in any tree.",
			"Only the running agents list_agents reports can be sent to. Its closed entries are sessions, not addresses: nothing can be delivered to one, and reviving that work means spawning a new agent.",
			"A task you were given stays open until you call send_message with completeTask; ending a turn, going idle, or sending an ordinary message does not finish it.",
			"Completing a task does not dispose the agent that did the work, and being disposed is not how work is finished.",
			"Include everything the other agent needs in the message: agents do not share conversations, sessions, or context.",
		],
		parameters: sendMessageSchema,
		execute: async (toolCallId, { agentId, message, assignTask, completeTask, taskFailed }, context) => {
			const host = requireAgentHost(context);
			const targetAgentId = agentId.trim();
			const body = message.trim();
			const taskId = completeTask?.trim();
			// Everything that can be decided from the arguments is decided before
			// any of the three modes runs, so an invalid call has no side effects.
			if (!targetAgentId) {
				throw new Error("send_message requires a non-empty agentId.");
			}
			if (!body) {
				throw new Error("send_message requires a non-empty message.");
			}
			if (targetAgentId === host.agentId) {
				throw new Error("send_message cannot target yourself; it delivers text to another agent.");
			}
			if (assignTask && completeTask !== undefined) {
				throw new Error(
					"send_message cannot both assign a task and complete one. Use assignTask to delegate work, completeTask to report work you were given.",
				);
			}
			if (completeTask !== undefined && !taskId) {
				throw new Error("send_message requires a non-empty completeTask id.");
			}
			if (taskFailed !== undefined && taskId === undefined) {
				throw new Error("send_message only accepts taskFailed together with completeTask.");
			}

			if (taskId !== undefined) {
				return completeAgentTask({
					host,
					ownerAgentId: targetAgentId,
					taskId,
					text: body,
					failed: taskFailed === true,
				});
			}

			if (assignTask) {
				const assigned = await assignAgentTask({
					host,
					jobs: host.jobs,
					toolCallId,
					toolName: "send_message",
					targetAgentId,
					message: body,
				});
				return {
					content: [{ type: "text", text: describeAssignedTask(assigned.taskId, targetAgentId) }],
					details: { targetAgentId, mode: "assign_task", taskId: assigned.taskId },
				};
			}

			requireAddressableAgent(host, targetAgentId);
			const outcome = await host.sendMessage(targetAgentId, body);
			if (outcome.kind === "blocked") {
				const reason = outcome.reason ? `${outcome.blockedBy}: ${outcome.reason}` : `blocked by ${outcome.blockedBy}`;
				throw new Error(`The message to agent ${targetAgentId} was blocked (${reason}) and was not delivered.`);
			}
			return {
				content: [
					{
						type: "text",
						text: `Message delivered to agent ${targetAgentId}. It reads the message on its next turn; nothing is waiting on a reply, so continue or end your turn.`,
					},
				],
				details: { targetAgentId, mode: "message" },
			};
		},
	};
}

/**
 * Report a task finished. The report text is the settled job's result, so it
 * reaches the owner through that job's result message and no second message is
 * sent - the owner must read exactly one completion, not a report plus a
 * near-duplicate note.
 *
 * A rejected settlement fails the whole call rather than degrading into an
 * ordinary message: silently downgrading would leave the worker believing the
 * task was handed back while the owner still waits for it.
 */
function completeAgentTask(input: {
	readonly host: ToolAgentHost;
	readonly ownerAgentId: string;
	readonly taskId: string;
	readonly text: string;
	readonly failed: boolean;
}): AgentToolResult<SendMessageDetails> {
	const { host, ownerAgentId, taskId } = input;
	if (!host.describe(ownerAgentId)) {
		throw new Error(
			`Unknown agent: ${ownerAgentId}. Task ${taskId} cannot be reported to an agent that does not exist.`,
		);
	}
	const status = input.failed ? "failed" : "completed";
	// The report text is the job's result, so it is what the owner reads as this
	// task's t1 and nothing further is sent.
	const settled = host.settler.settle({
		ownerAgentId,
		jobId: taskId,
		outcome: { status, result: { content: [{ type: "text", text: input.text }], details: undefined } },
	});
	if (!settled.ok) {
		if (settled.reason === "not_settler") {
			throw new Error(
				`Task ${taskId} of agent ${ownerAgentId} was assigned to a different agent, so you cannot settle it.`,
			);
		}
		throw new Error(
			`Task ${taskId} of agent ${ownerAgentId} is not open: it was already completed, cancelled, or never existed.`,
		);
	}
	return {
		content: [
			{
				type: "text",
				text: `Task ${taskId} was reported ${status} to agent ${ownerAgentId}; your message is the report it receives. You stay live and can keep working.`,
			},
		],
		details: { targetAgentId: ownerAgentId, mode: "complete_task" as const, taskId },
	};
}
