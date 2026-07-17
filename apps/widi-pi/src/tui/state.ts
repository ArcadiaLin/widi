import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { CommandError } from "../commands/types.ts";
import type { AgentRecordSnapshot } from "../core/agent-record.ts";
import type { OrchestratorDiagnostic } from "../core/diagnostics.ts";
import type {
	ExtensionMessage,
	ExtensionStatusSnapshot,
} from "../core/extension/presentation.ts";
import type {
	HumanRequestEnvelope,
	HumanRequestKind,
} from "../core/human-request.ts";
import type {
	AgentId,
	AgentLifecycleStatus,
	OrchestratorEvent,
	RuntimeModel,
} from "../core/types.ts";

export type TimelineDurability = "durable" | "ephemeral";

export interface UserMessageItem {
	readonly type: "user-message";
	readonly id: string;
	readonly durability: TimelineDurability;
	readonly createdAt: string;
	text: string;
	modelText?: string;
}

export interface AssistantMessageItem {
	readonly type: "assistant-message";
	readonly id: string;
	readonly durability: TimelineDurability;
	readonly createdAt: string;
	text: string;
	streaming: boolean;
	message?: AssistantMessage;
}

export interface ToolExecutionItem {
	readonly type: "tool-execution";
	readonly id: string;
	readonly toolCallId: string;
	readonly durability: TimelineDurability;
	readonly createdAt: string;
	toolName: string;
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
	status: "running" | "completed";
}

export interface ThinkingStatusItem {
	readonly type: "thinking-status";
	readonly id: string;
	readonly durability: "ephemeral";
	readonly createdAt: string;
	status: "thinking" | "completed";
}

export interface DiagnosticItem {
	readonly type: "diagnostic";
	readonly id: string;
	readonly durability: "ephemeral";
	readonly createdAt: string;
	readonly diagnostic: OrchestratorDiagnostic;
}

export interface CommandResultItem {
	readonly type: "command-result";
	readonly id: string;
	readonly commandId: string;
	readonly durability: "ephemeral";
	readonly createdAt: string;
	readonly name: string;
	readonly argument: string;
	status: "running" | "completed" | "failed";
	result?: unknown;
	error?: CommandError;
}

export interface ExtensionOutputItem {
	readonly type: "extension-output";
	readonly id: string;
	readonly presentationId: string;
	readonly durability: "ephemeral";
	readonly createdAt: string;
	readonly extensionId: string;
	readonly text: string;
}

export interface PersistentMessageItem {
	readonly type: "extension-message";
	readonly id: string;
	readonly entryId: string;
	readonly extensionId: string;
	readonly message: ExtensionMessage;
	readonly durability: "durable";
	readonly createdAt: string;
}

export interface HumanRequestTraceItem {
	readonly type: "human-request-trace";
	readonly id: string;
	readonly requestId: string;
	readonly requestKind: HumanRequestKind;
	readonly title: string;
	readonly answer:
		| { readonly kind: "confirm"; readonly confirmed: boolean }
		| { readonly kind: "selected-option"; readonly value: string }
		| { readonly kind: "answered" };
	readonly durability: "ephemeral";
	readonly createdAt: string;
}

export interface ApplicationNoticeItem {
	readonly type: "application-notice";
	readonly id: string;
	readonly durability: "ephemeral";
	readonly createdAt: string;
	readonly text: string;
}

export interface SessionMarkerItem {
	readonly type: "session-marker";
	readonly id: string;
	readonly durability: "durable";
	readonly createdAt: string;
	readonly marker: "compaction" | "branch-summary";
	readonly summary: string;
}

export type TimelineItem =
	| UserMessageItem
	| AssistantMessageItem
	| ToolExecutionItem
	| ThinkingStatusItem
	| DiagnosticItem
	| CommandResultItem
	| ExtensionOutputItem
	| PersistentMessageItem
	| HumanRequestTraceItem
	| ApplicationNoticeItem
	| SessionMarkerItem;

export type AgentAttention =
	| "none"
	| "completed"
	| "human-request"
	| "warning"
	| "error";

export interface PendingInput {
	readonly originalText: string;
	readonly submittedAt: string;
}

export interface QueueState {
	steer: number;
	followUp: number;
	nextTurn: number;
}

export interface AgentDisplayFacts {
	model?: RuntimeModel;
	thinkingLevel?: string;
	activeToolNames: readonly string[];
	sessionName?: string;
	rehydrateRequested: boolean;
}

export interface AgentViewState {
	readonly agentId: AgentId;
	snapshot?: AgentRecordSnapshot;
	status: AgentLifecycleStatus;
	timeline: TimelineItem[];
	extensionStatuses: Map<string, ExtensionStatusSnapshot>;
	unreadCount: number;
	attention: AgentAttention;
	hydration: "pending" | "ready" | "failed";
	bufferedEvents: OrchestratorEvent[];
	pendingInput?: PendingInput;
	queue: QueueState;
	display: AgentDisplayFacts;
	/** The live assistant item currently receiving message_update events. */
	currentAssistantId?: string;
	/** Monotonic projection-local identity source for harness messages. */
	nextLiveItemId: number;
}

export interface NoticeItem {
	readonly id: string;
	readonly kind:
		| "extension-notification"
		| "diagnostic"
		| "application"
		| "startup";
	readonly createdAt: string;
	readonly text: string;
	readonly agentId?: AgentId;
	readonly extensionId?: string;
	readonly diagnostic?: OrchestratorDiagnostic;
}

export interface PendingHumanRequestView {
	readonly request: HumanRequestEnvelope;
	readonly agentId?: AgentId;
}

export interface TuiApplicationState {
	activeAgentId?: AgentId;
	agents: Map<AgentId, AgentViewState>;
	globalNotices: NoticeItem[];
	humanRequests: PendingHumanRequestView[];
	mode: "editor" | "completion-menu" | "human-request";
	shuttingDown: boolean;
	/** Global toggle: show full tool output instead of collapsed previews. */
	toolOutputExpanded: boolean;
}

export function createTuiApplicationState(): TuiApplicationState {
	return {
		agents: new Map(),
		globalNotices: [],
		humanRequests: [],
		mode: "editor",
		shuttingDown: false,
		toolOutputExpanded: false,
	};
}

export function createAgentViewState(
	agentId: AgentId,
	status: AgentLifecycleStatus = "creating",
): AgentViewState {
	return {
		agentId,
		status,
		timeline: [],
		extensionStatuses: new Map(),
		unreadCount: 0,
		attention: "none",
		hydration: "ready",
		bufferedEvents: [],
		queue: { steer: 0, followUp: 0, nextTurn: 0 },
		display: { activeToolNames: [], rehydrateRequested: false },
		nextLiveItemId: 1,
	};
}

export function ensureAgentProjection(
	state: TuiApplicationState,
	agentId: AgentId,
	status: AgentLifecycleStatus = "creating",
): AgentViewState {
	const existing = state.agents.get(agentId);
	if (existing) return existing;
	const created = createAgentViewState(agentId, status);
	state.agents.set(agentId, created);
	return created;
}

export function setActiveAgent(
	state: TuiApplicationState,
	agentId: AgentId,
): AgentViewState {
	const agent = ensureAgentProjection(state, agentId);
	state.activeAgentId = agentId;
	agent.unreadCount = 0;
	agent.attention = retainedAttention(state, agent);
	return agent;
}

/**
 * Attention that survives being viewed: pending human requests, an
 * unavailable agent and diagnostic-backed severity. Transient signals such as
 * completed runs or background tool failures are dropped once the user looks
 * at the agent.
 */
export function retainedAttention(
	state: TuiApplicationState,
	agent: AgentViewState,
): AgentAttention {
	if (state.humanRequests.some((item) => item.agentId === agent.agentId)) {
		return "human-request";
	}
	if (agent.status === "unavailable") return "error";
	let attention: AgentAttention = "none";
	const diagnostics = [
		...agent.timeline.flatMap((item) =>
			item.type === "diagnostic" ? [item.diagnostic] : [],
		),
		...(agent.snapshot?.diagnostics ?? []),
	];
	for (const diagnostic of diagnostics) {
		if (diagnostic.severity === "error") return "error";
		if (diagnostic.severity === "warning") attention = "warning";
	}
	return attention;
}

export function extensionStatusKey(extensionId: string, key: string): string {
	return `${extensionId}\u0000${key}`;
}

export function isTimelineEvent(event: OrchestratorEvent): boolean {
	if (event.type === "agent_harness_event") {
		return isTimelineHarnessEvent(event.event);
	}
	return (
		event.type === "extension_output" ||
		event.type === "extension_message_published" ||
		event.type === "diagnostic" ||
		event.type === "human_request_resolved"
	);
}

function isTimelineHarnessEvent(event: AgentHarnessEvent): boolean {
	return (
		event.type === "message_start" ||
		event.type === "message_update" ||
		event.type === "message_end" ||
		event.type === "tool_execution_start" ||
		event.type === "tool_execution_update" ||
		event.type === "tool_execution_end"
	);
}

export function isToolResultMessage(
	message: unknown,
): message is ToolResultMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		message.role === "toolResult"
	);
}
