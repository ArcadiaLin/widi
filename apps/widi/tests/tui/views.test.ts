import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "../../src/core/agent-types.ts";
import { widiCommands } from "../../src/tui/commands/built-in/index.ts";
import { CommandEngine } from "../../src/tui/commands/engine.ts";
import { FatalErrorView } from "../../src/tui/fatal-error.ts";
import { boundedText, sanitizeTerminalText, singleLine } from "../../src/tui/format.ts";
import { createWidiKeybindings } from "../../src/tui/keybindings.ts";
import { setSteadyQuip } from "../../src/tui/quips.ts";
import {
	type AssistantMessageItem,
	type CommandResultItem,
	createTuiApplicationState,
	type ExtensionOutputItem,
	ensureAgentProjection,
	type HumanRequestTraceItem,
	setActiveAgent,
} from "../../src/tui/state.ts";
import { theme } from "../../src/tui/theme/theme.ts";
import { AgentStripView } from "../../src/tui/views/agent-strip.ts";
import { ChatView } from "../../src/tui/views/chat.ts";
import { FooterView } from "../../src/tui/views/footer.ts";
import { HeaderView } from "../../src/tui/views/header.ts";
import { OperationHintView } from "../../src/tui/views/operation-hint.ts";
import { StatusView } from "../../src/tui/views/status.ts";
import { renderTimelineItem } from "../../src/tui/views/utils/timeline-item.ts";
import { WorkingLineView } from "../../src/tui/views/working-line.ts";
import { stubCommandHost } from "../helpers/command-host.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

describe("FatalErrorView", () => {
	it("renders horizontal rules without side borders", () => {
		const view = new FatalErrorView({
			code: "orchestrator.startup_failed",
			message: "No usable agent.",
			onQuit: () => {},
			onViewDiagnostics: () => {},
		});

		const lines = view.render(60).map((line) => line.replace(ANSI_SEQUENCE, ""));
		const joined = lines.join("\n");

		expect(lines[0]).toMatch(/^─+$/u);
		expect(lines.at(-1)).toMatch(/^─+$/u);
		expect(lines.some((line) => line.includes("│") || line.includes("┌") || line.includes("└"))).toBe(false);
		expect(joined).toContain("✕ WIDI cannot continue");
		expect(joined).toContain("orchestrator.startup_failed");
		expect(joined).toContain("Quit");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});
});

describe("TUI views", () => {
	it.each([40, 80, 120])("keeps chat, status, footer, operation hint and agent strip inside %s columns", (width) => {
		const state = createTuiApplicationState();
		const main = setActiveAgent(state, "main");
		main.status = "idle";
		main.display.sessionName = "主代理";
		main.timeline.push(
			{
				type: "user-message",
				id: "user",
				durability: "durable",
				createdAt: timestamp(1),
				text: "请检查这个很长的中文输入，并保证终端宽度不会溢出。",
			},
			{
				type: "assistant-message",
				id: "assistant",
				durability: "durable",
				createdAt: timestamp(2),
				text: "这里是 **Markdown** 响应。\n\n- 第一项\n- 第二项",
				streaming: false,
			},
			{
				type: "extension-output",
				id: "output",
				presentationId: "output",
				durability: "ephemeral",
				createdAt: timestamp(3),
				extensionId: "indexer",
				text: "Scanning a path with a deliberately long output value.",
			},
		);
		main.extensionStatuses.set("indexer\u0000build", {
			agentId: "main",
			extensionId: "indexer",
			key: "build",
			status: { text: "Building symbol index", progress: { completed: 418, total: 672 } },
			updatedAt: timestamp(4),
		});
		const worker = ensureAgentProjection(state, "reviewer");
		worker.status = "running";
		worker.unreadCount = 3;
		const failed = ensureAgentProjection(state, "researcher");
		failed.status = "disposed";
		failed.attention = "error";

		const views = [
			new ChatView(state),
			new StatusView(state),
			new FooterView(state, "/home/arcadia/projs/widi"),
			new OperationHintView({
				state,
				engine: new CommandEngine(widiCommands(stubCommandHost())),
				editor: { getText: () => "", isShowingAutocomplete: () => false },
				selectorHint: () => undefined,
			}),
			new AgentStripView(state),
		];
		for (const view of views) {
			for (const line of view.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("renders no operation hint for a single idle agent", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		const view = new OperationHintView({
			state,
			engine: new CommandEngine(widiCommands(stubCommandHost())),
			editor: { getText: () => "", isShowingAutocomplete: () => false },
			selectorHint: () => undefined,
		});

		expect(view.render(80)).toEqual([]);
	});

	it("distinguishes source and fork labels in the agent strip", () => {
		const state = createTuiApplicationState();
		const source = setActiveAgent(state, "widi-dev");
		source.status = "idle";
		source.snapshot = snapshot("widi-dev", "/sessions/source.jsonl");
		const fork = ensureAgentProjection(state, "019f784f-4342-781c-8472-93e6547da47e", "idle");
		fork.snapshot = snapshot(fork.agentId, "/sessions/fork.jsonl", "/sessions/source.jsonl");
		fork.display.forkedFromAgentId = source.agentId;

		const output = new AgentStripView(state).render(160).join("\n").replace(ANSI_SEQUENCE, "");

		expect(output).toContain("WIDI Dev [widi-dev]");
		expect(output).toContain("WIDI Dev [fork from widi-dev · 547da47e]");
	});

	it("shows how far into its run a running agent is", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "widi-dev");
		agent.snapshot = snapshot("widi-dev", "/sessions/source.jsonl");
		agent.status = "running";
		agent.runToolCount = 15;

		expect(new AgentStripView(state).render(160).join("\n").replace(ANSI_SEQUENCE, "")).toContain(
			"running · 15 tool_use",
		);

		// A count left over from a finished run would read as one still going.
		agent.status = "idle";
		expect(new AgentStripView(state).render(160).join("\n").replace(ANSI_SEQUENCE, "")).not.toContain("tool_use");
	});

	it("keeps terminal control sequences out of the panel and selects by raw value", () => {
		const state = createTuiApplicationState();
		const sanitizedAgentId = `${"a".repeat(260)}tail-123`;
		const agentId = `\u001b]0;owned\u0007${sanitizedAgentId}\u001b[2J`;
		const agent = ensureAgentProjection(state, agentId, "idle");
		agent.snapshot = snapshot(agentId, "/sessions/agent.jsonl");
		state.activeAgentId = agentId;
		let selectedAgentId: string | undefined;
		const panel = new AgentStripView(
			state,
			{
				setFocus: (component) => {
					panel.focused = component === panel;
				},
				requestRender: () => {},
			},
			(selected) => {
				selectedAgentId = selected;
			},
		);

		panel.open();
		const output = panel.render(500).join("\n").replace(ANSI_SEQUENCE, "");
		expect(output).not.toContain("\u001b");
		expect(output).not.toContain("\u0007");

		panel.handleInput("\r");

		expect(selectedAgentId).toBe(agentId);
	});

	it("keeps status facts but operation actions out of the footer", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.status = "idle";
		agent.display.sessionName = "Default Agent";
		agent.display.thinkingLevel = "medium";
		agent.display.model = {
			id: "qwen3.6-35b-a3b",
			name: "Qwen",
			api: "anthropic-messages",
			provider: "vllm",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};

		const [line] = new FooterView(state, "/home/arcadia/projs/widi/apps/widi").render(120);

		const plain = (line ?? "").replace(ANSI_SEQUENCE, "");
		// The model the next prompt runs on sits directly under the editor.
		expect(plain).toContain("vllm · qwen3.6-35b-a3b · thinking medium");
		expect(plain).not.toContain("Default Agent");
		expect(plain).not.toContain("idle");
		expect(plain).not.toContain("← agents");
	});

	it("drops footer qualifiers before the model id and cwd when width runs out", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.display.thinkingLevel = "medium";
		agent.display.model = {
			id: "qwen3.6-35b-a3b",
			name: "Qwen",
			api: "anthropic-messages",
			provider: "vllm",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const footer = new FooterView(state, "/home/arcadia/projs/widi");

		const narrow = (footer.render(40)[0] ?? "").replace(ANSI_SEQUENCE, "");
		expect(narrow).toContain("qwen3.6-35b-a3b");
		expect(narrow).not.toContain("vllm");
		expect(narrow).not.toContain("thinking");
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(40);
	});

	it("shows only panel-region statuses in the status view, with icon and tone", () => {
		const state = createTuiApplicationState();
		const main = setActiveAgent(state, "main");
		main.status = "idle";
		main.extensionStatuses.set("indexer build", {
			agentId: "main",
			extensionId: "indexer",
			key: "build",
			status: { text: "Building index", region: "panel", icon: "◆", tone: "success" },
			updatedAt: timestamp(4),
		});
		// No region: the default is "panel".
		main.extensionStatuses.set("linter scan", {
			agentId: "main",
			extensionId: "linter",
			key: "scan",
			status: { text: "Scanning sources" },
			updatedAt: timestamp(5),
		});
		main.extensionStatuses.set("watcher files", {
			agentId: "main",
			extensionId: "watcher",
			key: "files",
			status: { text: "Watching files", region: "footer" },
			updatedAt: timestamp(6),
		});

		const raw = new StatusView(state).render(80).join("\n");
		const output = raw.replace(ANSI_SEQUENCE, "");

		expect(output).toContain("◆");
		expect(output).toContain("Building index");
		expect(output).toContain("Scanning sources");
		expect(output).not.toContain("Watching files");
		expect(raw).toContain(theme.ok("x").split("x")[0]);
	});

	it("renders the latest footer-region status as a compact footer segment", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.status = "idle";
		agent.extensionStatuses.set("watcher old", {
			agentId: "main",
			extensionId: "watcher",
			key: "old",
			status: { text: "Stale status", region: "footer" },
			updatedAt: timestamp(4),
		});
		agent.extensionStatuses.set("watcher new", {
			agentId: "main",
			extensionId: "watcher",
			key: "new",
			status: { text: "Watching files", region: "footer", icon: "◐" },
			updatedAt: timestamp(5),
		});
		agent.extensionStatuses.set("indexer build", {
			agentId: "main",
			extensionId: "indexer",
			key: "build",
			status: { text: "Panel only" },
			updatedAt: timestamp(6),
		});

		const line = (new FooterView(state, "/workspace").render(120)[0] ?? "").replace(ANSI_SEQUENCE, "");

		expect(line).toContain("◐ Watching files");
		expect(line).not.toContain("Stale status");
		expect(line).not.toContain("Panel only");
	});

	it("renders the running steer action only once across footer, working line and operation hint", () => {
		setKeybindings(createWidiKeybindings());
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.status = "running";
		agent.runStartedAt = new Date().toISOString();
		setSteadyQuip(agent, "working");
		const engine = new CommandEngine(widiCommands(stubCommandHost()));
		const editor = { getText: () => "", isShowingAutocomplete: () => false };
		const output = [
			...new FooterView(state, "/workspace").render(120),
			...new WorkingLineView({ state, engine, editor }).render(120),
			...new OperationHintView({ state, engine, editor, selectorHint: () => undefined }).render(120),
		]
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(output.match(/ctrl\+s steer/giu)).toHaveLength(1);
	});

	it("renders the agent-switch action only once across footer and operation hint", () => {
		setKeybindings(createWidiKeybindings());
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		ensureAgentProjection(state, "worker", "idle");
		const output = [
			...new FooterView(state, "/workspace").render(120),
			...new OperationHintView({
				state,
				engine: new CommandEngine(widiCommands(stubCommandHost())),
				editor: { getText: () => "", isShowingAutocomplete: () => false },
				selectorHint: () => undefined,
			}).render(120),
		]
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(output).toContain("↓ switch agent");
		expect(output.match(/↓/gu)).toHaveLength(1);
	});

	it("renders an empty pending agent without a core projection", () => {
		const state = createTuiApplicationState();
		state.pendingAgent = {
			start: { kind: "default" },
			timeline: [],
			draft: "",
			display: {
				profileLabel: "Main Agent",
				model: {
					id: "pending-model",
					name: "Pending Model",
					api: "anthropic-messages",
					provider: "test",
					baseUrl: "https://example.test",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
				thinkingLevel: "medium",
			},
			nextLiveItemId: 1,
		};

		const chat = new ChatView(state).render(80).join("\n").replace(ANSI_SEQUENCE, "");
		const header = new HeaderView(state).render(80).join("\n").replace(ANSI_SEQUENCE, "");
		const footer = new FooterView(state, "/workspace").render(80).join("\n").replace(ANSI_SEQUENCE, "");

		expect(chat).toContain("Ask WIDI");
		expect(header).toContain("Main Agent");
		expect(header).toContain("pending-model");
		expect(footer).toContain("thinking medium");
	});

	it("shows only one thinking indicator while an assistant message streams", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.timeline.push(
			{
				type: "assistant-message",
				id: "live-1",
				durability: "durable",
				createdAt: timestamp(1),
				text: "",
				streaming: true,
			},
			{
				type: "thinking-status",
				id: "live-1:thinking",
				durability: "ephemeral",
				createdAt: timestamp(2),
				status: "thinking",
			},
		);

		const output = new ChatView(state).render(80).join("\n");

		expect(output.match(/Thinking…/g)).toHaveLength(1);
	});

	it("replaces the generic thinking indicator with a preparing tool", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.timeline.push(
			{
				type: "assistant-message",
				id: "live-1",
				durability: "durable",
				createdAt: timestamp(1),
				text: "",
				streaming: true,
			},
			{
				type: "tool-execution",
				id: "preparing-tool:live-1:0",
				toolCallId: "tool-1",
				durability: "durable",
				createdAt: timestamp(2),
				sourceAssistantId: "live-1",
				toolName: "read",
				status: "preparing",
			},
		);

		const output = new ChatView(state).render(80).join("\n");

		expect(output).not.toContain("Thinking…");
		expect(output.match(/preparing…/g)).toHaveLength(1);
	});

	it("renders tool executions through the presentation registry", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.timeline.push({
			type: "tool-execution",
			id: "tool-1",
			toolCallId: "tool-1",
			durability: "durable",
			createdAt: timestamp(1),
			toolName: "ls",
			args: { path: "src" },
			result: { content: [{ type: "text", text: "a.ts\nb.ts" }] },
			isError: false,
			status: "completed",
		});

		const output = new ChatView(state).render(80).join("\n").replace(ANSI_SEQUENCE, "");

		expect(output).toContain("✓ List src · 2 entries");
		expect(output).not.toContain('{ "path": "src" }');
	});

	it("re-renders cached tool output when the expand toggle flips", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		agent.timeline.push({
			type: "tool-execution",
			id: "tool-1",
			toolCallId: "tool-1",
			durability: "durable",
			createdAt: timestamp(1),
			toolName: "bash",
			args: { command: "ls" },
			result: { content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix" }] },
			isError: false,
			status: "completed",
		});
		const view = new ChatView(state);

		const collapsed = view.render(80).join("\n").replace(ANSI_SEQUENCE, "");
		expect(collapsed).toContain("… +2 lines");
		expect(collapsed).not.toContain("six");

		state.toolOutputExpanded = true;
		const expanded = view.render(80).join("\n").replace(ANSI_SEQUENCE, "");
		expect(expanded).toContain("six");
		expect(expanded).not.toContain("… +2 lines");
	});

	// An extension row is written and rewritten under one id, so its cache has to
	// expire on the text; nothing else about the row ever changes.
	it("re-renders an extension row when its text or expansion changes", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "main");
		const row: ExtensionOutputItem = {
			type: "extension-output",
			id: "ext:drill:step",
			presentationId: "ext:drill:step",
			durability: "ephemeral",
			createdAt: timestamp(1),
			extensionId: "drill",
			text: "chapter one",
		};
		agent.timeline.push(row);
		const view = new ChatView(state);
		const plain = () => view.render(80).join("\n").replace(ANSI_SEQUENCE, "");

		expect(plain()).toContain("chapter one");

		agent.timeline[0] = { ...row, text: "chapter one, revised" };
		expect(plain()).toContain("chapter one, revised");

		const long = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		agent.timeline[0] = { ...row, text: long };
		expect(plain()).toContain("… [truncated]");
		expect(plain()).not.toContain("line 20");

		agent.timeline[0] = { ...row, text: long, expanded: true };
		expect(plain()).toContain("line 20");
	});

	it("renders a completed command with its result", () => {
		const item: CommandResultItem = {
			type: "command-result",
			id: "command-1",
			commandId: "command-1",
			durability: "ephemeral",
			createdAt: timestamp(1),
			name: "status",
			argument: "",
			status: "completed",
			result: { status: "idle" },
		};
		const text = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			livePreparingAssistantIds: new Set(),
			toolOutputExpanded: false,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(text).toContain("/status");
		expect(text).toContain('"status": "idle"');
	});

	it("renders a failed assistant turn with its error message", () => {
		const item: AssistantMessageItem = {
			type: "assistant-message",
			id: "assistant-1",
			durability: "durable",
			createdAt: timestamp(1),
			text: "",
			streaming: false,
			message: {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "huggingface",
				model: "moonshotai/Kimi-K2.7-Code",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: "Request timed out.",
				timestamp: Date.parse(timestamp(1)),
			},
		};
		const text = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			livePreparingAssistantIds: new Set(),
			toolOutputExpanded: false,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(text).toContain("✕");
		expect(text).toContain("Request timed out.");
	});

	it("renders a failed command with its error message", () => {
		const item: CommandResultItem = {
			type: "command-result",
			id: "command-1",
			commandId: "command-1",
			durability: "ephemeral",
			createdAt: timestamp(1),
			name: "resume",
			argument: "some-session",
			status: "failed",
			error: { message: "not available while the agent is running" },
		};
		const text = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			livePreparingAssistantIds: new Set(),
			toolOutputExpanded: false,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(text).toContain("/resume");
		expect(text).toContain("not available while the agent is running");
	});

	it("renders a multi-select trace as a joined summary and an expanded list", () => {
		const item: HumanRequestTraceItem = {
			type: "human-request-trace",
			id: "request-1",
			requestId: "request-1",
			requestKind: "multi-select",
			title: "Pick targets",
			options: ["Safe", "Fast", "Cheap"],
			answer: { kind: "selected-options", values: ["Safe", "Cheap"] },
			durability: "ephemeral",
			createdAt: timestamp(1),
		};
		const collapsed = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			livePreparingAssistantIds: new Set(),
			toolOutputExpanded: false,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");
		expect(collapsed).toContain("Pick targets → Safe, Cheap");

		const expanded = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			livePreparingAssistantIds: new Set(),
			toolOutputExpanded: true,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");
		expect(expanded).toContain("▸ Safe");
		expect(expanded).toContain("▸ Cheap");
		expect(expanded).toContain("Fast");
		expect(expanded).not.toContain("▸ Fast");
	});

	it("renders a questions-batch trace as a summary and a grouped expansion", () => {
		const item: HumanRequestTraceItem = {
			type: "human-request-trace",
			id: "request-1",
			requestId: "request-1",
			requestKind: "questions",
			title: "Deploy setup",
			answer: {
				kind: "answered-questions",
				items: [
					{ title: "Target", values: ["Staging"] },
					{ title: "Regions", values: ["us", "eu"] },
				],
			},
			durability: "ephemeral",
			createdAt: timestamp(1),
		};
		const collapsed = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			livePreparingAssistantIds: new Set(),
			toolOutputExpanded: false,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");
		expect(collapsed).toContain("Target: Staging");
		expect(collapsed).toContain("Regions: us, eu");

		const expanded = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			livePreparingAssistantIds: new Set(),
			toolOutputExpanded: true,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");
		expect(expanded).toContain("Target");
		expect(expanded).toContain("▸ Staging");
		expect(expanded).toContain("▸ us");
		expect(expanded).toContain("▸ eu");
	});

	it("removes terminal control sequences from externally supplied text", () => {
		const malicious = "safe\u001b[2J text\u001b]0;owned\u0007\nnext\u0000line";

		expect(sanitizeTerminalText(malicious)).toBe("safe text\nnextline");
		expect(singleLine(malicious)).toBe("safe text nextline");
		expect(boundedText(malicious)).toBe("safe text\nnextline");
	});
});

function timestamp(offset: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}

function snapshot(agentId: string, path: string, parentSessionPath?: string): AgentSnapshot {
	return {
		agentId,
		generation: 1,
		profile: {
			reference: { id: "widi-dev", label: "WIDI Dev" },
			source: { kind: "memory", priority: 0 },
			entryId: "entry-1",
		},
		sessionMetadata: { id: agentId, createdAt: new Date(0).toISOString(), cwd: "/workspace", path, parentSessionPath },
		model: {
			id: "test-model",
			name: "Test Model",
			api: "anthropic-messages",
			provider: "test",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		},
		thinkingLevel: "off",
		tools: { toolNames: [], activeToolNames: [] },
		activity: { activity: "idle" },
		extensions: {
			extensionIds: [],
			extensions: [],
			hooks: [],
			toolContributions: [],
			providerContributions: [],
			systemPromptContributions: [],
			divisions: [],
			stale: { stale: false },
		},
		diagnostics: [],
	};
}
