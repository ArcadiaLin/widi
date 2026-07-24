import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { AgentRecordSnapshot } from "../../src/core/agent-record.ts";
import { AgentSelectorController } from "../../src/tui/agent-selector.ts";
import { builtInCommands } from "../../src/tui/commands/built-ins.ts";
import { CommandEngine } from "../../src/tui/commands/engine.ts";
import { CompletionMenu } from "../../src/tui/completion-menu.ts";
import { AgentStripView } from "../../src/tui/components/agent-strip.ts";
import { ChatView } from "../../src/tui/components/chat.ts";
import { FooterView } from "../../src/tui/components/footer.ts";
import { HeaderView } from "../../src/tui/components/header.ts";
import { OperationHintView } from "../../src/tui/components/operation-hint.ts";
import { StatusView } from "../../src/tui/components/status.ts";
import { renderTimelineItem } from "../../src/tui/components/timeline-item.ts";
import {
	boundedText,
	sanitizeTerminalText,
	singleLine,
} from "../../src/tui/format.ts";
import { createWidiKeybindings } from "../../src/tui/keybindings.ts";
import {
	type CommandResultItem,
	createTuiApplicationState,
	ensureAgentProjection,
	type HumanRequestTraceItem,
	setActiveAgent,
} from "../../src/tui/state.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

describe("TUI views", () => {
	it.each([40, 80, 120])(
		"keeps chat, status, footer, operation hint and agent strip inside %s columns",
		(width) => {
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
				status: {
					text: "Building symbol index",
					progress: { completed: 418, total: 672 },
				},
				updatedAt: timestamp(4),
			});
			const worker = ensureAgentProjection(state, "reviewer");
			worker.status = "running";
			worker.unreadCount = 3;
			const failed = ensureAgentProjection(state, "researcher");
			failed.status = "unavailable";
			failed.attention = "error";

			const views = [
				new ChatView(state),
				new StatusView(state),
				new FooterView(state, "/home/arcadia/projs/widi"),
				new OperationHintView({
					state,
					engine: new CommandEngine(builtInCommands),
					editor: {
						getText: () => "",
						isShowingAutocomplete: () => false,
					},
					menu: { hintContext: undefined },
				}),
				new AgentStripView(state),
			];
			for (const view of views) {
				for (const line of view.render(width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		},
	);

	it("renders no operation hint for a single idle agent", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";
		const view = new OperationHintView({
			state,
			engine: new CommandEngine(builtInCommands),
			editor: {
				getText: () => "",
				isShowingAutocomplete: () => false,
			},
			menu: { hintContext: undefined },
		});

		expect(view.render(80)).toEqual([]);
	});

	it("distinguishes source and fork labels in the agent strip", () => {
		const state = createTuiApplicationState();
		const source = setActiveAgent(state, "widi-dev");
		source.status = "idle";
		source.snapshot = snapshot("widi-dev", "/sessions/source.jsonl");
		const fork = ensureAgentProjection(
			state,
			"019f784f-4342-781c-8472-93e6547da47e",
			"idle",
		);
		fork.snapshot = snapshot(
			fork.agentId,
			"/sessions/fork.jsonl",
			"/sessions/source.jsonl",
		);
		fork.display.forkedFromAgentId = source.agentId;

		const output = new AgentStripView(state)
			.render(160)
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(output).toContain("WIDI Dev [widi-dev]");
		expect(output).toContain("WIDI Dev [fork from widi-dev · 547da47e]");
	});

	it("shows the live background job count in the agent strip", () => {
		const state = createTuiApplicationState();
		const agent = setActiveAgent(state, "widi-dev");
		agent.status = "idle";
		agent.snapshot = snapshot("widi-dev", "/sessions/source.jsonl");
		agent.backgroundJobCount = 2;

		const output = new AgentStripView(state)
			.render(160)
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(output).toContain("2 bg");
	});

	it("renders the full sanitized agent id while selecting by its raw value", () => {
		const state = createTuiApplicationState();
		const sanitizedAgentId = `${"a".repeat(260)}tail-123`;
		const agentId = `\u001b]0;owned\u0007${sanitizedAgentId}\u001b[2J`;
		const agent = ensureAgentProjection(state, agentId, "idle");
		agent.snapshot = snapshot(agentId, "/sessions/agent.jsonl");
		state.activeAgentId = agentId;
		const menu = new CompletionMenu(
			{ setFocus: () => {}, requestRender: () => {} },
			state,
			() => {},
		);
		let selectedAgentId: string | undefined;
		const selector = new AgentSelectorController(menu, state, (selected) => {
			selectedAgentId = selected;
		});

		selector.open();

		const output = menu.render(500).join("\n").replace(ANSI_SEQUENCE, "");
		expect(output).toContain(`id ${sanitizedAgentId}`);
		expect(output).not.toContain("\u001b");
		expect(output).not.toContain("\u0007");

		menu.handleInput("\r");

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

		const [line] = new FooterView(
			state,
			"/home/arcadia/projs/widi/apps/widi-pi",
		).render(120);

		const plain = (line ?? "").replace(ANSI_SEQUENCE, "");
		expect(plain).not.toContain("qwen3.6-35b-a3b");
		expect(plain).not.toContain("Default Agent");
		expect(plain).not.toContain("idle");
		expect(plain).not.toContain("← agents");
		expect(plain).toContain("thinking medium");
	});

	it("renders the running steer action only once across footer and operation hint", () => {
		setKeybindings(createWidiKeybindings());
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "running";
		const output = [
			...new FooterView(state, "/workspace").render(120),
			...new OperationHintView({
				state,
				engine: new CommandEngine(builtInCommands),
				editor: {
					getText: () => "",
					isShowingAutocomplete: () => false,
				},
				menu: { hintContext: undefined },
			}).render(120),
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
				engine: new CommandEngine(builtInCommands),
				editor: {
					getText: () => "",
					isShowingAutocomplete: () => false,
				},
				menu: { hintContext: undefined },
			}).render(120),
		]
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(output).toContain("← switch agent");
		expect(output.match(/←/gu)).toHaveLength(1);
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
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
					contextWindow: 1000,
					maxTokens: 100,
				},
				thinkingLevel: "medium",
			},
			nextLiveItemId: 1,
		};

		const chat = new ChatView(state)
			.render(80)
			.join("\n")
			.replace(ANSI_SEQUENCE, "");
		const header = new HeaderView(state)
			.render(80)
			.join("\n")
			.replace(ANSI_SEQUENCE, "");
		const footer = new FooterView(state, "/workspace")
			.render(80)
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

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

		const output = new ChatView(state)
			.render(80)
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

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
			result: {
				content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix" }],
			},
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
			toolOutputExpanded: false,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(text).toContain("/status");
		expect(text).toContain('"status": "idle"');
	});

	it("renders a failed command with its error message", () => {
		const item: CommandResultItem = {
			type: "command-result",
			id: "command-1",
			commandId: "command-1",
			durability: "ephemeral",
			createdAt: timestamp(1),
			name: "steer",
			argument: "go",
			status: "failed",
			error: { message: "requires a running agent" },
		};
		const text = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
			toolOutputExpanded: false,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");

		expect(text).toContain("/steer");
		expect(text).toContain("requires a running agent");
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
			toolOutputExpanded: false,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");
		expect(collapsed).toContain("Pick targets → Safe, Cheap");

		const expanded = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
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
			toolOutputExpanded: false,
		})
			.join("\n")
			.replace(ANSI_SEQUENCE, "");
		expect(collapsed).toContain("Target: Staging");
		expect(collapsed).toContain("Regions: us, eu");

		const expanded = renderTimelineItem(item, 80, {
			liveThinkingIds: new Set(),
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

function snapshot(
	agentId: string,
	path: string,
	parentSessionPath?: string,
): AgentRecordSnapshot {
	return {
		agentId,
		status: "idle",
		profile: { reference: { id: "widi-dev", label: "WIDI Dev" } },
		sessionMetadata: {
			id: agentId,
			createdAt: new Date(0).toISOString(),
			cwd: "/workspace",
			path,
			parentSessionPath,
		},
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
		hasHarness: true,
		extensionIds: [],
		extensions: [],
		extensionSnapshot: {
			extensionIds: [],
			extensions: [],
			hooks: [],
			toolContributions: [],
			providerContributions: [],
			stale: { stale: false },
		},
		resourceDiagnostics: [],
		extensionDiagnostics: [],
		diagnostics: [],
	};
}
