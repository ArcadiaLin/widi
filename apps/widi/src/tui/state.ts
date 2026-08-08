import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentHarnessEvent } from "@widi/agent-core";
import type { AgentSnapshot } from "../core/agent-types.ts";
import type { BackgroundJobReportSnapshot } from "../core/background/index.ts";
import type { OrchestratorDiagnostic } from "../core/diagnostics.ts";
import type { ExtensionMessage, ExtensionStatusSnapshot } from "../core/extension/api.ts";
import type { HumanRequestEnvelope, HumanRequestKind } from "../core/human-request.ts";
import type { MessageSource } from "../core/message.ts";
import type { AgentId, AgentMaintenanceKind, OrchestratorEvent, RuntimeModel } from "../core/types.ts";
import type { CommandError } from "./commands/types.ts";

export type TimelineDurability = "durable" | "ephemeral";
export type NoticeTextMode = "compact" | "full";

export interface UserMessageItem {
	readonly type: "user-message";
	readonly id: string;
	readonly durability: TimelineDurability;
	readonly createdAt: string;
	text: string;
	modelText?: string;
}

/**
 * Input the runtime put into this agent's context on someone else's behalf: a
 * peer agent, a settled background job, an extension, or the runtime itself.
 *
 * Distinct from `user-message`, which is only what the person at this keyboard
 * typed. The two are indistinguishable to the model - both reach it as user
 * text - and that is exactly why they must not be here: a reader who cannot
 * tell them apart cannot tell what they were answering.
 *
 * `text` is the semantic body and `modelText` the rendered form the model
 * actually read, present only when the source's renderer changed it. The
 * attribution prefix lives in `modelText`; on screen it is the source line's
 * job, so the same fact is never shown twice.
 */
export interface OrchestratorMessageItem {
	readonly type: "orchestrator-message";
	readonly id: string;
	readonly durability: TimelineDurability;
	readonly createdAt: string;
	readonly source: MessageSource;
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
	/** Assistant stream that emitted this provisional tool call, when known. */
	readonly sourceAssistantId?: string;
	toolName: string;
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
	/**
	 * "preparing" covers the window between the streamed toolcall_start and
	 * tool_execution_start; a run that ends in that window leaves the item
	 * "cancelled".
	 */
	status: "preparing" | "running" | "completed" | "cancelled";
	/**
	 * Per-item expand override (parity §4.3-3): set, it wins over the global
	 * toolOutputExpanded toggle; unset, the item follows the global state.
	 * The projector preserves it across item updates.
	 */
	expanded?: boolean;
}

export interface ThinkingStatusItem {
	readonly type: "thinking-status";
	readonly id: string;
	readonly durability: "ephemeral";
	readonly createdAt: string;
	status: "thinking" | "completed";
	/** Spinner line text; defaults to "Thinking…" when unset. */
	label?: string;
	/** Display-only tail of the streamed thinking text (last lines). */
	preview?: string;
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
	/** Human-readable summary from the command's formatResult, when defined. */
	display?: string;
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
	/** Original request options, kept only for the expanded trace rendering. */
	readonly options?: readonly string[];
	readonly answer:
		| { readonly kind: "confirm"; readonly confirmed: boolean }
		| { readonly kind: "selected-option"; readonly value: string }
		| { readonly kind: "selected-options"; readonly values: readonly string[] }
		| {
				readonly kind: "answered-questions";
				readonly items: readonly { readonly title: string; readonly values: readonly string[] }[];
		  }
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
	/** Full mode wraps sanitized text without abbreviating copy-sensitive values. */
	readonly textMode?: NoticeTextMode;
}

export interface SessionMarkerItem {
	readonly type: "session-marker";
	readonly id: string;
	readonly durability: "durable";
	readonly createdAt: string;
	readonly marker: "compaction" | "branch-summary";
	readonly summary: string;
}

/** Placeholder left behind when the sliding window trims older turns. */
export interface WindowMarkerItem {
	readonly type: "window-marker";
	readonly id: string;
	readonly durability: "ephemeral";
	readonly createdAt: string;
	hiddenTurns: number;
}

export type TimelineItem =
	| UserMessageItem
	| OrchestratorMessageItem
	| AssistantMessageItem
	| ToolExecutionItem
	| ThinkingStatusItem
	| DiagnosticItem
	| CommandResultItem
	| ExtensionOutputItem
	| PersistentMessageItem
	| HumanRequestTraceItem
	| ApplicationNoticeItem
	| SessionMarkerItem
	| WindowMarkerItem;

export type AgentAttention = "none" | "completed" | "human-request" | "warning" | "error";

export interface PendingInput {
	readonly originalText: string;
	readonly submittedAt: string;
}

/**
 * What a pending agent will become once the user submits. A new session carries
 * the identity to reopen with rather than the agent it came from: the source is
 * disposed before the pending session is staged, so it is no longer there to
 * answer questions about itself.
 */
export type PendingAgentStart =
	| { readonly kind: "default" }
	| { readonly kind: "new-session"; readonly profileId: string; readonly model: RuntimeModel };

export interface PendingAgentViewState {
	readonly start: PendingAgentStart;
	timeline: TimelineItem[];
	draft: string;
	display: { readonly profileLabel: string; model: RuntimeModel; thinkingLevel?: string; sessionName?: string };
	nextLiveItemId: number;
}

export interface QueueState {
	steer: readonly string[];
	followUp: readonly string[];
	nextTurn: number;
}

export interface AgentDisplayFacts {
	model?: RuntimeModel;
	thinkingLevel?: string;
	/** Total tokens of the latest assistant turn (input+output+cache), for the footer context readout. */
	contextTokens?: number;
	activeToolNames: readonly string[];
	sessionName?: string;
	rehydrateRequested: boolean;
	forkedFromAgentId?: AgentId;
}

/** Human follow-up accepted by the TUI but not yet acknowledged by core. */
export interface PendingFollowUp {
	readonly id: number;
	readonly text: string;
}

/**
 * Lifecycle of one agent row.
 *
 * Core reports only `idle` and `running`, and only for an agent that is live;
 * the two extra states are the view's own - one before core has said anything
 * about a row the TUI already had to create, one after the agent is gone and
 * the row is kept so its transcript stays readable.
 */
export type AgentViewStatus = "creating" | "idle" | "running" | "disposed";

export interface AgentViewState {
	readonly agentId: AgentId;
	snapshot?: AgentSnapshot;
	/** The agent whose tool spawned this one; unset for user-side spawns. */
	spawnedBy?: AgentId;
	status: AgentViewStatus;
	/** Set while status "running" is maintenance work (compaction, tree
	 * navigation) rather than an agent turn: no steering or aborting applies. */
	maintenance?: AgentMaintenanceKind;
	timeline: TimelineItem[];
	extensionStatuses: Map<string, ExtensionStatusSnapshot>;
	unreadCount: number;
	attention: AgentAttention;
	/** Live background jobs (backgrounded, not yet settled) owned by this agent. */
	backgroundJobCount: number;
	/** Per-job view state backing the jobs panel; includes retained settled jobs. */
	backgroundJobs: Map<string, BackgroundJobViewState>;
	hydration: "pending" | "ready" | "failed";
	bufferedEvents: OrchestratorEvent[];
	pendingInput?: PendingInput;
	/** When the current run started; set while status is "running". */
	runStartedAt?: string;
	queue: QueueState;
	/** Optimistic projection while sendMessage is waiting for a deliverable phase. */
	pendingFollowUps: PendingFollowUp[];
	display: AgentDisplayFacts;
	/** The live assistant item currently receiving message_update events. */
	currentAssistantId?: string;
	/** Latest assistant text waiting for the throttled streaming flush. */
	pendingAssistantText?: PendingAssistantText;
	/** Latest tool args/partial results waiting for the throttled flush. */
	pendingToolUpdates?: Map<string, PendingToolUpdate>;
	/** Monotonic projection-local identity source for harness messages. */
	nextLiveItemId: number;
}

export interface PendingAssistantText {
	readonly itemId: string;
	readonly text: string;
	readonly message: AssistantMessage;
}

export interface PendingToolUpdate {
	readonly args: unknown;
	readonly partialResult: unknown;
}

/** Panel-facing view of one background job; settled jobs are retained until
 * the next user turn starts. */
export interface BackgroundJobViewState {
	readonly jobId: string;
	readonly toolName: string;
	/** Short label the caller named this job with; absent when unnamed. */
	readonly name?: string;
	readonly description?: string;
	status: "live" | "aborting" | "completed" | "failed" | "cancelled";
	readonly startedAt: number;
	endedAt?: number;
	totalBytesSeen: number;
	/** Latest structured report accepted for this job. */
	report?: BackgroundJobReportSnapshot;
	/** Last non-empty output line, decoded from progress increments. */
	lastLine?: string;
}

export interface NoticeItem {
	readonly id: string;
	readonly kind: "extension-notification" | "diagnostic" | "application" | "startup";
	readonly createdAt: string;
	readonly text: string;
	/** Full mode wraps sanitized text without abbreviating copy-sensitive values. */
	readonly textMode?: NoticeTextMode;
	readonly agentId?: AgentId;
	readonly extensionId?: string;
	readonly diagnostic?: OrchestratorDiagnostic;
}

export interface PendingHumanRequestView {
	readonly request: HumanRequestEnvelope;
	readonly agentId?: AgentId;
}

/** Which interaction layer owns input; derived from TuiFocusState. */
export type TuiInteractionMode = "editor" | "selector" | "human-request" | "agent-panel";

/** Docked layout components that can hold input focus instead of the editor. */
export type TuiDockedFocus = "human-request" | "agent-panel" | "selector";

export interface TuiOverlayFocusEntry {
	/** Interaction mode the overlay contributes while it sits on the stack. */
	readonly mode?: TuiInteractionMode;
}

/**
 * The single source of truth behind `state.mode`. The application overlay
 * stack pushes/pops overlay entries as overlays open and close; docked
 * components claim and release `docked` as they take and lose input focus.
 * Nobody writes `mode` directly.
 */
export interface TuiFocusState {
	readonly overlays: TuiOverlayFocusEntry[];
	docked?: TuiDockedFocus;
}

export interface TuiApplicationState {
	activeAgentId?: AgentId;
	pendingAgent?: PendingAgentViewState;
	agents: Map<AgentId, AgentViewState>;
	globalNotices: NoticeItem[];
	humanRequests: PendingHumanRequestView[];
	readonly focus: TuiFocusState;
	readonly mode: TuiInteractionMode;
	shuttingDown: boolean;
	/** Global toggle: show full transcript details instead of collapsed previews. */
	toolOutputExpanded: boolean;
}

export function createTuiApplicationState(): TuiApplicationState {
	return {
		agents: new Map(),
		globalNotices: [],
		humanRequests: [],
		focus: { overlays: [] },
		get mode() {
			return interactionMode(this);
		},
		shuttingDown: false,
		toolOutputExpanded: false,
	};
}

/**
 * The interaction mode is derived, never assigned: the top-most overlay wins,
 * then the docked component holding input focus, then the editor. A pending
 * human request on its own is not a mode — only the open menu claims it.
 */
export function interactionMode(state: TuiApplicationState): TuiInteractionMode {
	for (let i = state.focus.overlays.length - 1; i >= 0; i--) {
		const mode = state.focus.overlays[i]?.mode;
		if (mode) return mode;
	}
	return state.focus.docked ?? "editor";
}

/** Record an opened overlay at the top of the focus stack. */
export function pushOverlayFocus(state: TuiApplicationState, entry: TuiOverlayFocusEntry): TuiOverlayFocusEntry {
	state.focus.overlays.push(entry);
	return entry;
}

export function removeOverlayFocus(state: TuiApplicationState, entry: TuiOverlayFocusEntry): void {
	const index = state.focus.overlays.indexOf(entry);
	if (index >= 0) state.focus.overlays.splice(index, 1);
}

/** A docked component takes input focus. */
export function setDockedFocus(state: TuiApplicationState, docked: TuiDockedFocus): void {
	state.focus.docked = docked;
}

/** Release the docked focus claim; a mismatched claimant leaves it alone. */
export function clearDockedFocus(state: TuiApplicationState, docked?: TuiDockedFocus): void {
	if (docked === undefined || state.focus.docked === docked) state.focus.docked = undefined;
}

export function createAgentViewState(agentId: AgentId, status: AgentViewStatus = "creating"): AgentViewState {
	return {
		agentId,
		status,
		timeline: [],
		extensionStatuses: new Map(),
		unreadCount: 0,
		attention: "none",
		backgroundJobCount: 0,
		backgroundJobs: new Map(),
		hydration: "ready",
		bufferedEvents: [],
		queue: { steer: [], followUp: [], nextTurn: 0 },
		pendingFollowUps: [],
		display: { activeToolNames: [], rehydrateRequested: false },
		nextLiveItemId: 1,
	};
}

export function ensureAgentProjection(
	state: TuiApplicationState,
	agentId: AgentId,
	status: AgentViewStatus = "creating",
): AgentViewState {
	const existing = state.agents.get(agentId);
	if (existing) return existing;
	const created = createAgentViewState(agentId, status);
	state.agents.set(agentId, created);
	return created;
}

export function setActiveAgent(state: TuiApplicationState, agentId: AgentId): AgentViewState {
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
export function retainedAttention(state: TuiApplicationState, agent: AgentViewState): AgentAttention {
	if (state.humanRequests.some((item) => item.agentId === agent.agentId)) {
		return "human-request";
	}
	let attention: AgentAttention = "none";
	const diagnostics = [
		...agent.timeline.flatMap((item) => (item.type === "diagnostic" ? [item.diagnostic] : [])),
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

export function isToolResultMessage(message: unknown): message is ToolResultMessage {
	return typeof message === "object" && message !== null && "role" in message && message.role === "toolResult";
}
