import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { renderDeps, renderTimelineItem, type TimelineRenderContext } from "../../src/tui/components/timeline-item.ts";
import { SPINNER_FRAMES } from "../../src/tui/format.ts";
import { createWidiKeybindings } from "../../src/tui/keybindings.ts";
import type {
	ApplicationNoticeItem,
	AssistantMessageItem,
	CommandResultItem,
	SessionMarkerItem,
	ThinkingStatusItem,
	UserMessageItem,
} from "../../src/tui/state.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const context: TimelineRenderContext = {
	liveThinkingIds: new Set(),
	livePreparingAssistantIds: new Set(),
	toolOutputExpanded: false,
};

function plain(lines: string[]): string[] {
	return lines.map((line) => line.replace(ANSI_SEQUENCE, "").trim());
}

describe("renderTimelineItem", () => {
	it("paints user message rows with the surface background at full width", () => {
		const item: UserMessageItem = {
			type: "user-message",
			id: "user-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			text: "hello",
		};

		const lines = renderTimelineItem(item, 24, context);

		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			// #1e2833 as a background color.
			expect(line).toContain("48;2;30;40;51");
			expect(visibleWidth(line)).toBe(24);
		}
	});

	it("bounds long assistant replies by default and expands them on demand", () => {
		const text = Array.from({ length: 400 }, (_, i) => `row ${i}`).join("\n");
		const item: AssistantMessageItem = {
			type: "assistant-message",
			id: "assistant-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			text,
			streaming: false,
		};

		const collapsed = plain(renderTimelineItem(item, 80, context));

		expect(collapsed.some((line) => line.includes("[truncated]"))).toBe(true);
		expect(collapsed).toContain("row 0");
		expect(collapsed).not.toContain("row 399");

		const expanded = plain(renderTimelineItem(item, 80, { ...context, toolOutputExpanded: true }));
		expect(expanded.some((line) => line.includes("[truncated]"))).toBe(false);
		expect(expanded).toContain("row 399");
	});

	it("does not invalidate streamed Markdown for an unused spinner frame", () => {
		const item: AssistantMessageItem = {
			type: "assistant-message",
			id: "assistant-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			text: "streamed text",
			streaming: true,
		};
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(0);
		const first = renderDeps(item, context);
		now.mockReturnValue(1_000);
		const second = renderDeps(item, context);
		expect(second).toEqual(first);

		item.text = "";
		now.mockReturnValue(0);
		const placeholderFirst = renderDeps(item, context);
		now.mockReturnValue(1_000);
		const placeholderSecond = renderDeps(item, context);
		expect(placeholderSecond).not.toEqual(placeholderFirst);
		now.mockRestore();
	});

	it("prefers the command display text over the raw result", () => {
		const item: CommandResultItem = {
			type: "command-result",
			id: "command-1",
			commandId: "command-1",
			durability: "ephemeral",
			createdAt: "2026-01-01T00:00:00.000Z",
			name: "resume",
			argument: "",
			status: "completed",
			result: { agentId: "agent-2", snapshot: { big: "object" } },
			display: "resumed agent-2 · Default · test-model",
		};

		const lines = plain(renderTimelineItem(item, 80, context));

		expect(lines).toEqual(["/resume", "resumed agent-2 · Default · test-model"]);
	});

	it("sanitizes and bounds formatted command display text", () => {
		const escapeCharacter = String.fromCharCode(27);
		const bell = String.fromCharCode(7);
		const item: CommandResultItem = {
			type: "command-result",
			id: "command-unsafe",
			commandId: "command-unsafe",
			durability: "ephemeral",
			createdAt: "2026-01-01T00:00:00.000Z",
			name: "compact",
			argument: "",
			status: "completed",
			display: [
				`safe${escapeCharacter}]52;c;SGVsbG8=${bell}tail`,
				...Array.from({ length: 30 }, (_, index) => `line ${index}`),
			].join("\n"),
		};

		const output = renderTimelineItem(item, 80, context).join("\n");

		expect(output).not.toContain(`${escapeCharacter}]52`);
		expect(output).not.toContain(bell);
		expect(output).toContain("safetail");
		expect(output).toContain("[truncated]");
		expect(output).not.toContain("line 29");

		const expanded = renderTimelineItem(item, 80, { ...context, toolOutputExpanded: true }).join("\n");
		expect(expanded).not.toContain(`${escapeCharacter}]52`);
		expect(expanded).not.toContain(bell);
		expect(expanded).toContain("line 29");
	});

	it("falls back to the raw result when no display text exists", () => {
		const item: CommandResultItem = {
			type: "command-result",
			id: "command-2",
			commandId: "command-2",
			durability: "ephemeral",
			createdAt: "2026-01-01T00:00:00.000Z",
			name: "status",
			argument: "",
			status: "completed",
			result: "idle",
		};

		const lines = plain(renderTimelineItem(item, 80, context));

		expect(lines).toEqual(["/status", "idle"]);
	});

	it("wraps full application notices without abbreviating login URLs", () => {
		const url = `https://auth.example.test/oauth/authorize?${"state=a".repeat(120)}&complete=yes`;
		const item: ApplicationNoticeItem = {
			type: "application-notice",
			id: "login-url",
			durability: "ephemeral",
			createdAt: "2026-01-01T00:00:00.000Z",
			text: `Login: open ${url}`,
			textMode: "full",
		};

		const output = plain(renderTimelineItem(item, 40, context)).join("");

		expect(output).toContain(url);
		expect(output).not.toContain("…");
	});

	it("renders a live thinking status with a spinner and a two-line preview", () => {
		const item: ThinkingStatusItem = {
			type: "thinking-status",
			id: "live-1:thinking",
			durability: "ephemeral",
			createdAt: "2026-01-01T00:00:00.000Z",
			status: "thinking",
			preview: "second line\nthird line",
		};

		const lines = plain(renderTimelineItem(item, 80, context));

		expect(lines).toHaveLength(3);
		expect(SPINNER_FRAMES).toContain(lines[0]?.[0]);
		expect(lines[0]?.slice(1)).toBe(" Thinking…");
		expect(lines.slice(1)).toEqual(["second line", "third line"]);
	});

	it("sanitizes terminal controls from the thinking preview", () => {
		const escapeCharacter = String.fromCharCode(27);
		const bell = String.fromCharCode(7);
		const item: ThinkingStatusItem = {
			type: "thinking-status",
			id: "live-unsafe:thinking",
			durability: "ephemeral",
			createdAt: "2026-01-01T00:00:00.000Z",
			status: "thinking",
			preview: `safe${escapeCharacter}]52;c;SGVsbG8=${bell}tail`,
		};

		const output = renderTimelineItem(item, 80, context).join("\n");

		expect(output).not.toContain(`${escapeCharacter}]52`);
		expect(output).not.toContain(bell);
		expect(output).toContain("safetail");
	});

	it("renders a completed thinking status as nothing", () => {
		const item: ThinkingStatusItem = {
			type: "thinking-status",
			id: "awaiting:main",
			durability: "ephemeral",
			createdAt: "2026-01-01T00:00:00.000Z",
			status: "completed",
		};

		expect(renderTimelineItem(item, 80, context)).toEqual([]);
	});

	it("collapses a compaction marker into a full-width separator by default", () => {
		setKeybindings(createWidiKeybindings());
		const item: SessionMarkerItem = {
			type: "session-marker",
			id: "compaction-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			marker: "compaction",
			summary: "## Goal\nhidden summary body",
		};

		const lines = plain(renderTimelineItem(item, 60, context));

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("── Compacted session · Ctrl+O expand ─");
		expect(lines[0]?.endsWith("──")).toBe(true);
		expect(lines[0]).not.toContain("hidden summary body");
	});

	it("expands a compaction marker with the transcript toggle", () => {
		setKeybindings(createWidiKeybindings());
		const item: SessionMarkerItem = {
			type: "session-marker",
			id: "compaction-1",
			durability: "durable",
			createdAt: "2026-01-01T00:00:00.000Z",
			marker: "compaction",
			summary: "## Goal\nhidden summary body",
		};

		const lines = plain(renderTimelineItem(item, 60, { ...context, toolOutputExpanded: true }));

		expect(lines[0]).toContain("── Compacted session · Ctrl+O collapse ─");
		expect(lines).toContain("hidden summary body");
	});
});
