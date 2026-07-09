import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ToolLifecycleEvent } from "./tools/types.ts";
import type { AgentId } from "./types.ts";

export interface StreamingToolCallRef {
	readonly toolCallId?: string;
	readonly toolName?: string;
}

export class HarnessEventFacts {
	private readonly _streamingToolCalls: Map<
		AgentId,
		Map<number, StreamingToolCallRef>
	> = new Map();

	toToolLifecycleEvent(
		agentId: AgentId,
		event: AgentHarnessEvent,
	): ToolLifecycleEvent | undefined {
		if (event.type === "message_update") {
			const assistantEvent = event.assistantMessageEvent;
			if (assistantEvent.type === "toolcall_start") {
				const ref = this._rememberStreamingToolCall(agentId, {
					contentIndex: assistantEvent.contentIndex,
					...streamingToolCallRefFromPartial(
						assistantEvent.partial,
						assistantEvent.contentIndex,
					),
				});
				return {
					type: "tool_call_created",
					contentIndex: assistantEvent.contentIndex,
					toolCallId: ref.toolCallId,
					toolName: ref.toolName,
				};
			}
			if (assistantEvent.type === "toolcall_delta") {
				const ref = this._getStreamingToolCall(
					agentId,
					assistantEvent.contentIndex,
				);
				return {
					type: "arguments_delta",
					contentIndex: assistantEvent.contentIndex,
					delta: assistantEvent.delta,
					toolCallId: ref?.toolCallId,
					toolName: ref?.toolName,
				};
			}
			if (assistantEvent.type === "toolcall_end") {
				this._forgetStreamingToolCall(agentId, assistantEvent.contentIndex);
				return {
					type: "arguments_ready",
					contentIndex: assistantEvent.contentIndex,
					toolCallId: assistantEvent.toolCall.id,
					toolName: assistantEvent.toolCall.name,
					args: assistantEvent.toolCall.arguments,
				};
			}
			return undefined;
		}

		if (
			event.type === "message_end" ||
			event.type === "turn_end" ||
			event.type === "agent_end"
		) {
			this.forgetAllStreamingToolCalls(agentId);
			return undefined;
		}

		if (event.type === "tool_execution_start") {
			return {
				type: "execution_started",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
		}

		if (event.type === "tool_execution_update") {
			return {
				type: "execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				partialResult: event.partialResult,
			};
		}

		if (event.type === "tool_execution_end") {
			return {
				type: "execution_result",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
		}

		return undefined;
	}

	forgetAllStreamingToolCalls(agentId: AgentId): void {
		this._streamingToolCalls.delete(agentId);
	}

	clearStreamingToolCalls(): void {
		this._streamingToolCalls.clear();
	}

	private _rememberStreamingToolCall(
		agentId: AgentId,
		ref: StreamingToolCallRef & { readonly contentIndex: number },
	): StreamingToolCallRef {
		let refs = this._streamingToolCalls.get(agentId);
		if (!refs) {
			refs = new Map<number, StreamingToolCallRef>();
			this._streamingToolCalls.set(agentId, refs);
		}
		const next = {
			toolCallId: ref.toolCallId,
			toolName: ref.toolName,
		};
		refs.set(ref.contentIndex, next);
		return next;
	}

	private _getStreamingToolCall(
		agentId: AgentId,
		contentIndex: number,
	): StreamingToolCallRef | undefined {
		return this._streamingToolCalls.get(agentId)?.get(contentIndex);
	}

	private _forgetStreamingToolCall(
		agentId: AgentId,
		contentIndex: number,
	): void {
		const refs = this._streamingToolCalls.get(agentId);
		if (!refs) return;
		refs.delete(contentIndex);
		if (refs.size === 0) {
			this._streamingToolCalls.delete(agentId);
		}
	}
}

export function toToolLifecycleEvent(
	facts: HarnessEventFacts,
	agentId: AgentId,
	event: AgentHarnessEvent,
): ToolLifecycleEvent | undefined {
	return facts.toToolLifecycleEvent(agentId, event);
}

export function streamingToolCallRefFromPartial(
	partial: AssistantMessage,
	contentIndex: number,
): StreamingToolCallRef {
	const content = partial.content[contentIndex];
	if (!content || content.type !== "toolCall") {
		return {};
	}
	return {
		toolCallId: content.id,
		toolName: content.name,
	};
}
