import type {
	AgentHarnessEvent,
	AgentMessage,
} from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	TextContent,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentRecordSnapshot } from "../core/agent-record.ts";
import type { OrchestratorDiagnostic } from "../core/diagnostics.ts";
import type { ExtensionStatusSnapshot } from "../core/extension/presentation.ts";
import type { HumanResponse } from "../core/human-request.ts";
import type { AgentId, OrchestratorEvent } from "../core/types.ts";
import type { HydrationResult } from "./session-hydrator.ts";
import {
	type AgentAttention,
	type AgentViewState,
	ensureAgentProjection,
	extensionStatusKey,
	isTimelineEvent,
	retainedAttention,
	type TimelineItem,
	type TuiApplicationState,
} from "./state.ts";

const ATTENTION_PRIORITY: Record<AgentAttention, number> = {
	none: 0,
	completed: 1,
	warning: 2,
	"human-request": 3,
	error: 4,
};

export class EventProjector {
	readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	ensureAgent(agentId: AgentId): AgentViewState {
		return ensureAgentProjection(this.state, agentId);
	}

	apply(event: OrchestratorEvent): void {
		const agentId = eventAgentId(event);
		if (
			agentId &&
			this.shouldBuffer(ensureAgentProjection(this.state, agentId), event)
		) {
			ensureAgentProjection(this.state, agentId).bufferedEvents.push(event);
			return;
		}
		this.applyImmediately(event);
	}

	beginHydration(agentId: AgentId): AgentViewState {
		const agent = ensureAgentProjection(this.state, agentId);
		if (agent.hydration === "pending") return agent;
		agent.hydration = "pending";
		agent.bufferedEvents = [];
		agent.display.rehydrateRequested = false;
		return agent;
	}

	completeHydration(
		agentId: AgentId,
		result: HydrationResult,
		extensionStatuses: readonly ExtensionStatusSnapshot[] = [],
	): AgentViewState {
		const agent = ensureAgentProjection(this.state, agentId);
		const liveBeforeHydration = agent.timeline.filter(
			(item) => item.durability === "ephemeral",
		);
		agent.timeline = mergeTimeline(result.timeline, liveBeforeHydration);
		if (result.display.model && agent.display.model) {
			agent.display.model = {
				...agent.display.model,
				provider: result.display.model.provider,
				id: result.display.model.modelId,
			};
		}
		if (result.display.thinkingLevel !== undefined) {
			agent.display.thinkingLevel = result.display.thinkingLevel;
		}
		if (result.display.activeToolNames !== undefined) {
			agent.display.activeToolNames = [...result.display.activeToolNames];
		}
		if (result.display.sessionName !== undefined) {
			agent.display.sessionName = result.display.sessionName;
		}
		agent.extensionStatuses = new Map(
			extensionStatuses.map((status) => [
				extensionStatusKey(status.extensionId, status.key),
				status,
			]),
		);
		const buffered = agent.bufferedEvents;
		agent.bufferedEvents = [];
		agent.hydration = "ready";
		for (const event of buffered) this.applyImmediately(event);
		return agent;
	}

	failHydration(agentId: AgentId, message: string, createdAt = now()): void {
		const agent = ensureAgentProjection(this.state, agentId);
		const buffered = agent.bufferedEvents;
		agent.bufferedEvents = [];
		agent.hydration = "failed";
		agent.timeline.push({
			type: "application-notice",
			id: `hydration:${agentId}:${createdAt}`,
			durability: "ephemeral",
			createdAt,
			text: message,
		});
		for (const event of buffered) this.applyImmediately(event);
	}

	private shouldBuffer(
		agent: AgentViewState,
		event: OrchestratorEvent,
	): boolean {
		if (agent.hydration !== "pending") return false;
		// Resolution must close the capturing overlay immediately. Its trace is
		// ephemeral and completeHydration preserves pre-existing ephemeral items.
		if (event.type === "human_request_resolved") return false;
		if (event.type === "extension_status_changed") return true;
		return isTimelineEvent(event);
	}

	private applyImmediately(event: OrchestratorEvent): void {
		switch (event.type) {
			case "agent_harness_event":
				this.applyHarnessEvent(
					ensureAgentProjection(this.state, event.agentId),
					event.event,
				);
				return;
			case "agent_status_changed": {
				const agent = ensureAgentProjection(
					this.state,
					event.agentId,
					event.status,
				);
				const wasRunning = agent.status === "running";
				agent.status = event.status;
				agent.runStartedAt =
					event.status === "running" ? event.changedAt : undefined;
				if (
					wasRunning &&
					event.status === "idle" &&
					this.state.activeAgentId !== event.agentId
				) {
					raiseAttention(agent, "completed");
				}
				if (event.status === "unavailable") raiseAttention(agent, "error");
				return;
			}
			case "agent_spawned":
			case "agent_resumed": {
				const agent = ensureAgentProjection(this.state, event.agentId);
				agent.display.model = event.model;
				agent.hydration = "pending";
				return;
			}
			case "agent_session_info_changed":
				ensureAgentProjection(this.state, event.agentId).display.sessionName =
					event.name;
				return;
			case "agent_session_forked": {
				ensureAgentProjection(
					this.state,
					event.agentId,
				).display.rehydrateRequested = true;
				ensureAgentProjection(
					this.state,
					event.forkedSessionId,
				).display.forkedFromAgentId = event.agentId;
				return;
			}
			case "input_blocked":
				ensureAgentProjection(this.state, event.agentId).pendingInput =
					undefined;
				return;
			case "extension_output": {
				const agent = ensureAgentProjection(this.state, event.agentId);
				upsertTimeline(agent, {
					type: "extension-output",
					id: event.presentationId,
					presentationId: event.presentationId,
					durability: "ephemeral",
					createdAt: event.createdAt,
					extensionId: event.extensionId,
					text: event.text,
				});
				this.markBackgroundActivity(event.agentId);
				return;
			}
			case "extension_notification":
				this.state.globalNotices.push({
					id: event.presentationId,
					kind: "extension-notification",
					createdAt: event.createdAt,
					text: event.text,
					agentId: event.agentId,
					extensionId: event.extensionId,
				});
				return;
			case "extension_status_changed": {
				const agent = ensureAgentProjection(this.state, event.agentId);
				const key = extensionStatusKey(event.extensionId, event.key);
				if (!event.status) {
					agent.extensionStatuses.delete(key);
				} else {
					agent.extensionStatuses.set(key, {
						agentId: event.agentId,
						extensionId: event.extensionId,
						key: event.key,
						status: event.status,
						updatedAt: event.changedAt,
					});
				}
				return;
			}
			case "extension_message_published": {
				const agent = ensureAgentProjection(this.state, event.agentId);
				upsertTimeline(agent, {
					type: "extension-message",
					id: event.entryId,
					entryId: event.entryId,
					extensionId: event.extensionId,
					message: event.message,
					durability: "durable",
					createdAt: event.createdAt,
				});
				this.markBackgroundActivity(event.agentId);
				return;
			}
			case "diagnostic":
				this.applyDiagnostic(event.diagnostic, event.createdAt);
				return;
			case "human_request_pending": {
				this.state.humanRequests = [
					...this.state.humanRequests.filter(
						(item) => item.request.id !== event.request.id,
					),
					{ request: event.request, agentId: event.agentId },
				];
				if (event.agentId) {
					raiseAttention(
						ensureAgentProjection(this.state, event.agentId),
						"human-request",
					);
				}
				this.state.mode = "human-request";
				return;
			}
			case "human_request_resolved":
				this.resolveHumanRequest(
					event.agentId,
					event.requestId,
					event.response,
					event.completedAt,
				);
				return;
			case "human_request_timeout":
			case "human_request_cancelled":
				this.removeHumanRequest(event.requestId, event.agentId);
				return;
			case "input_transformed":
				return;
			case "agent_background_job_changed":
				ensureAgentProjection(this.state, event.agentId).backgroundJobCount =
					event.liveCount;
				return;
		}
	}

	private applyHarnessEvent(
		agent: AgentViewState,
		event: AgentHarnessEvent,
	): void {
		switch (event.type) {
			case "message_start":
				this.applyMessageStart(agent, event.message);
				return;
			case "message_update": {
				if (event.message.role !== "assistant") return;
				const item = findAssistant(agent, agent.currentAssistantId);
				if (!item) return;
				item.text = assistantText(event.message);
				item.message = event.message;
				const streamEvent = event.assistantMessageEvent;
				if (streamEvent.type === "thinking_start") {
					upsertTimeline(agent, {
						type: "thinking-status",
						id: `${item.id}:thinking`,
						durability: "ephemeral",
						createdAt: now(),
						status: "thinking",
					});
				} else if (streamEvent.type === "thinking_end") {
					const thinking = agent.timeline.find(
						(entry) =>
							entry.type === "thinking-status" &&
							entry.id === `${item.id}:thinking`,
					);
					if (thinking?.type === "thinking-status") {
						thinking.status = "completed";
					}
				}
				return;
			}
			case "message_end":
				if (event.message.role === "assistant") {
					const item = findAssistant(agent, agent.currentAssistantId);
					if (item) {
						item.text = assistantText(event.message);
						item.message = event.message;
						item.streaming = false;
					}
					agent.currentAssistantId = undefined;
				}
				return;
			case "tool_execution_start":
				upsertTimeline(agent, {
					type: "tool-execution",
					id: event.toolCallId,
					toolCallId: event.toolCallId,
					durability: "durable",
					createdAt: now(),
					toolName: event.toolName,
					args: event.args,
					status: "running",
				});
				this.markBackgroundActivity(agent.agentId);
				return;
			case "tool_execution_update": {
				const tool = findTool(agent, event.toolCallId);
				if (tool) {
					tool.args = event.args;
					tool.partialResult = event.partialResult;
				}
				return;
			}
			case "tool_execution_end": {
				let tool = findTool(agent, event.toolCallId);
				if (!tool) {
					tool = {
						type: "tool-execution",
						id: event.toolCallId,
						toolCallId: event.toolCallId,
						durability: "durable",
						createdAt: now(),
						toolName: event.toolName,
						status: "running",
					};
				}
				tool.toolName = event.toolName;
				tool.result = event.result;
				tool.isError = event.isError;
				tool.status = "completed";
				upsertTimeline(agent, tool);
				// An active agent's tool failure stays an inline tool error; only
				// background agents get a transient warning in the strip.
				if (event.isError) {
					this.markBackgroundActivity(agent.agentId, false, "warning");
				}
				return;
			}
			case "queue_update":
				agent.queue = {
					steer: event.steer.map(queuedMessageText).filter(nonEmpty),
					followUp: event.followUp.map(queuedMessageText).filter(nonEmpty),
					nextTurn: event.nextTurn.length,
				};
				return;
			case "model_update":
				agent.display.model = event.model;
				return;
			case "thinking_level_update":
				agent.display.thinkingLevel = event.level;
				return;
			case "tools_update":
				agent.display.activeToolNames = [...event.activeToolNames];
				return;
			case "session_tree":
			case "session_compact":
				agent.display.rehydrateRequested = true;
				return;
			default:
				return;
		}
	}

	private applyMessageStart(
		agent: AgentViewState,
		message: AgentMessage,
	): void {
		if (message.role === "toolResult") return;
		const id = `live-message:${agent.agentId}:${agent.nextLiveItemId++}`;
		if (message.role === "user") {
			const modelText = userText(message);
			const text = agent.pendingInput?.originalText ?? modelText;
			agent.pendingInput = undefined;
			upsertTimeline(agent, {
				type: "user-message",
				id,
				durability: "durable",
				createdAt: messageTimestamp(message),
				text,
				modelText: text === modelText ? undefined : modelText,
			});
		} else if (message.role === "assistant") {
			agent.currentAssistantId = id;
			upsertTimeline(agent, {
				type: "assistant-message",
				id,
				durability: "durable",
				createdAt: messageTimestamp(message),
				text: assistantText(message),
				streaming: true,
				message,
			});
		}
		this.markBackgroundActivity(agent.agentId);
	}

	private applyDiagnostic(
		diagnostic: OrchestratorDiagnostic,
		createdAt: string,
	): void {
		if (!diagnostic.agentId) {
			const id = diagnosticKey(diagnostic);
			if (!this.state.globalNotices.some((notice) => notice.id === id)) {
				this.state.globalNotices.push({
					id,
					kind: "diagnostic",
					createdAt,
					text: diagnostic.message,
					diagnostic,
				});
			}
			return;
		}
		const agent = ensureAgentProjection(this.state, diagnostic.agentId);
		upsertTimeline(agent, {
			type: "diagnostic",
			id: diagnosticKey(diagnostic),
			durability: "ephemeral",
			createdAt,
			diagnostic,
		});
		raiseDiagnosticAttention(agent, diagnostic);
		this.markBackgroundActivity(diagnostic.agentId);
	}

	private resolveHumanRequest(
		agentId: AgentId | undefined,
		requestId: string,
		response: HumanResponse,
		completedAt: string,
	): void {
		const pending = this.state.humanRequests.find(
			(item) => item.request.id === requestId,
		);
		this.removeHumanRequest(requestId, agentId);
		const resolvedAgentId = agentId ?? pending?.agentId;
		if (!pending || !resolvedAgentId) return;
		const answer = summarizeHumanResponse(pending.request, response);
		const agent = ensureAgentProjection(this.state, resolvedAgentId);
		upsertTimeline(agent, {
			type: "human-request-trace",
			id: requestId,
			requestId,
			requestKind: pending.request.kind,
			title: pending.request.title,
			options:
				pending.request.kind === "select" ? pending.request.options : undefined,
			answer,
			durability: "ephemeral",
			createdAt: completedAt,
		});
		this.markBackgroundActivity(resolvedAgentId);
	}

	private removeHumanRequest(requestId: string, agentId?: AgentId): void {
		this.state.humanRequests = this.state.humanRequests.filter(
			(item) => item.request.id !== requestId,
		);
		if (agentId) {
			const agent = ensureAgentProjection(this.state, agentId);
			if (
				agent.attention === "human-request" &&
				!this.state.humanRequests.some((item) => item.agentId === agentId)
			) {
				agent.attention = retainedAttention(this.state, agent);
			}
		}
		this.state.mode =
			this.state.humanRequests.length > 0 ? "human-request" : "editor";
	}

	private markBackgroundActivity(
		agentId: AgentId,
		incrementUnread = true,
		attention?: AgentAttention,
	): void {
		if (this.state.activeAgentId === agentId) return;
		const agent = ensureAgentProjection(this.state, agentId);
		if (incrementUnread) agent.unreadCount++;
		if (attention) raiseAttention(agent, attention);
	}
}

export function applyAgentSnapshot(
	state: TuiApplicationState,
	snapshot: AgentRecordSnapshot,
): AgentViewState {
	const agent = ensureAgentProjection(state, snapshot.agentId, snapshot.status);
	agent.snapshot = snapshot;
	agent.status = snapshot.status;
	agent.display.model = snapshot.model;
	agent.display.activeToolNames = snapshot.toolSnapshot?.activeToolNames ?? [];
	for (const diagnostic of snapshot.diagnostics) {
		raiseDiagnosticAttention(agent, diagnostic);
	}
	return agent;
}

function eventAgentId(event: OrchestratorEvent): AgentId | undefined {
	if ("agentId" in event && typeof event.agentId === "string") {
		return event.agentId;
	}
	if (event.type === "diagnostic") return event.diagnostic.agentId;
	return undefined;
}

function upsertTimeline(agent: AgentViewState, item: TimelineItem): void {
	const index = agent.timeline.findIndex(
		(existing) => existing.type === item.type && existing.id === item.id,
	);
	if (index === -1) agent.timeline.push(item);
	else agent.timeline[index] = item;
}

function mergeTimeline(
	base: readonly TimelineItem[],
	existing: readonly TimelineItem[],
): TimelineItem[] {
	const merged = [...base];
	for (const item of existing) {
		const index = merged.findIndex(
			(candidate) => candidate.type === item.type && candidate.id === item.id,
		);
		if (index === -1) merged.push(item);
		else merged[index] = item;
	}
	return merged;
}

function findAssistant(agent: AgentViewState, id?: string) {
	if (!id) return undefined;
	const item = agent.timeline.find(
		(entry) => entry.type === "assistant-message" && entry.id === id,
	);
	return item?.type === "assistant-message" ? item : undefined;
}

function findTool(agent: AgentViewState, toolCallId: string) {
	const item = agent.timeline.find(
		(entry) =>
			entry.type === "tool-execution" && entry.toolCallId === toolCallId,
	);
	return item?.type === "tool-execution" ? item : undefined;
}

function raiseAttention(
	agent: AgentViewState,
	attention: AgentAttention,
): void {
	if (ATTENTION_PRIORITY[attention] > ATTENTION_PRIORITY[agent.attention]) {
		agent.attention = attention;
	}
}

function raiseDiagnosticAttention(
	agent: AgentViewState,
	diagnostic: OrchestratorDiagnostic,
): void {
	if (diagnostic.severity === "error") raiseAttention(agent, "error");
	else if (diagnostic.severity === "warning") raiseAttention(agent, "warning");
}

function diagnosticKey(diagnostic: OrchestratorDiagnostic): string {
	return (
		diagnostic.id ??
		`diagnostic:${JSON.stringify({
			code: diagnostic.code,
			source: diagnostic.source,
			agentId: diagnostic.agentId,
			requestId: diagnostic.requestId,
			extensionId: diagnostic.extensionId,
		})}`
	);
}

function summarizeHumanResponse(
	request: {
		kind: "confirm" | "select" | "input" | "custom";
		options?: readonly string[];
	},
	response: HumanResponse,
):
	| { kind: "confirm"; confirmed: boolean }
	| { kind: "selected-option"; value: string }
	| { kind: "answered" } {
	if (request.kind === "confirm" && response.kind === "confirm") {
		return { kind: "confirm", confirmed: response.confirmed };
	}
	if (
		request.kind === "select" &&
		response.kind === "select" &&
		response.value !== undefined &&
		request.options?.includes(response.value)
	) {
		return { kind: "selected-option", value: response.value };
	}
	return { kind: "answered" };
}

function queuedMessageText(message: AgentMessage): string {
	if (message.role === "user") return userText(message);
	if (message.role === "assistant") return assistantText(message);
	return "";
}

function nonEmpty(text: string): boolean {
	return text.length > 0;
}

function userText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("");
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n\n");
}

function messageTimestamp(message: { timestamp?: number }): string {
	return new Date(message.timestamp ?? Date.now()).toISOString();
}

function now(): string {
	return new Date().toISOString();
}
