import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { AgentStripView } from "../../src/tui/components/agent-strip.ts";
import { ChatView } from "../../src/tui/components/chat.ts";
import { FooterView } from "../../src/tui/components/footer.ts";
import { StatusView } from "../../src/tui/components/status.ts";
import { renderTimelineItem } from "../../src/tui/components/timeline-item.ts";
import {
	boundedText,
	sanitizeTerminalText,
	singleLine,
} from "../../src/tui/format.ts";
import {
	type CommandResultItem,
	createTuiApplicationState,
	ensureAgentProjection,
	setActiveAgent,
} from "../../src/tui/state.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

describe("TUI views", () => {
	it.each([40, 80, 120])(
		"keeps chat, status, footer and agent strip inside %s columns",
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
				new AgentStripView(state),
			];
			for (const view of views) {
				for (const line of view.render(width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		},
	);

	it("keeps agent status and model out of the footer", () => {
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
		expect(plain).toContain("← agents");
		expect(plain).toContain("thinking medium");
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
