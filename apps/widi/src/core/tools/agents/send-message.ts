import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../types.ts";
import { requireAddressableAgent, requireAgentHost } from "./shared.ts";
import { type AgentWatches, describeOutcome } from "./watch-agent.ts";

const sendMessageSchema = Type.Object({
	agentId: Type.String({ description: "Id of the agent to send to." }),
	message: Type.String({
		description: "The text the other agent will read. It cannot see your conversation, so state the whole thing.",
	}),
	watch: Type.Optional(
		Type.Boolean({
			description:
				"Be told when that agent next stops. Use it when this message is work you are waiting on; leave it off when you are replying to someone.",
		}),
	),
});

export type SendMessageInput = Static<typeof sendMessageSchema>;

export interface SendMessageDetails {
	readonly targetAgentId: string;
	readonly watching: boolean;
}

/**
 * One verb for everything an agent says to another agent: hand a piece of text
 * to a named agent.
 *
 * It carries no completion or task bookkeeping. An agent's report is whatever
 * it last said before it stopped, and the runtime observes the stop itself, so
 * there is nothing here for a worker to remember to call.
 */
export function createSendMessageToolDefinition(
	watches: AgentWatches,
): ToolDefinition<typeof sendMessageSchema, SendMessageDetails> {
	return {
		name: "send_message",
		label: "send_message",
		description:
			"Send a message to another runtime-local agent by exact id. It delivers the text and returns immediately; the other agent reads it on its next turn and may reply with its own send_message. The target may be in another agent tree if its id was shared with you; this tool does not discover ids. Pass watch: true when the message is work you are waiting on, and you will be told when that agent stops.",
		promptSnippet: "Send a message to another agent",
		promptGuidelines: [
			"send_message never blocks: it returns once the other agent has the text, not when it replies. Continue working, or end your turn and wait to be woken.",
			"list_agents only discovers the agents you spawned, one level down. An exact agent id shared by a human, another agent, or an incoming message is enough to reach any other agent, at any level or in any tree.",
			"Only running agents can be sent to. A resumable session is a record, not an address; reviving that work means spawning an agent from it.",
			"Include everything the other agent needs in the message: agents do not share conversations, sessions, or context.",
		],
		parameters: sendMessageSchema,
		execute: async (_toolCallId, { agentId, message, watch }, context) => {
			const host = requireAgentHost(context);
			const targetAgentId = agentId.trim();
			const body = message.trim();
			if (!targetAgentId) {
				throw new Error("send_message requires a non-empty agentId.");
			}
			if (!body) {
				throw new Error("send_message requires a non-empty message.");
			}
			if (targetAgentId === host.agentId) {
				throw new Error("send_message cannot target yourself; it delivers text to another agent.");
			}
			requireAddressableAgent(host, targetAgentId);

			// Subscribing first is what makes the subscription reliable: a pending
			// delivery already counts the target busy, so a stop cannot slip between
			// the two calls. Nothing is rolled back if the send then fails - the
			// caller is told, and an unspent watch costs one stale notification at
			// worst.
			const watchOutcome = watch === true ? watches.start(host, targetAgentId) : undefined;
			const outcome = await host.sendMessage(targetAgentId, body);
			if (outcome.kind === "blocked") {
				const reason = outcome.reason ? `${outcome.blockedBy}: ${outcome.reason}` : `blocked by ${outcome.blockedBy}`;
				throw new Error(`The message to agent ${targetAgentId} was blocked (${reason}) and was not delivered.`);
			}
			const watching = watchOutcome === "watching";
			return {
				content: [
					{
						type: "text",
						text: [
							`Message delivered to agent ${targetAgentId}. It reads the message on its next turn.`,
							watchOutcome === undefined
								? "Nothing is waiting on a reply, so continue or end your turn."
								: watching
									? "You will be told when it stops; end your turn to wait."
									: `It was not subscribed: ${describeOutcome(targetAgentId, watchOutcome)}`,
						].join(" "),
					},
				],
				details: { targetAgentId, watching },
			};
		},
	};
}
