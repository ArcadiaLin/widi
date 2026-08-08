import { setKeybindings } from "@earendil-works/pi-tui";
import type { MessageEntry, SessionTreeEntry } from "@widi/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { AgentSnapshot } from "../../src/core/agent-types.ts";
import type { WidiRuntime } from "../../src/core/runtime-service.ts";
import type { AgentSessionTreeSnapshot } from "../../src/core/session-manager.ts";
import { WidiTuiApplication } from "../../src/tui/application.ts";
import { switchedAgentId } from "../../src/tui/commands/engine.ts";
import { OperationHintView } from "../../src/tui/components/operation-hint.ts";
import { WidiEditor } from "../../src/tui/editor.ts";
import { createWidiKeybindings } from "../../src/tui/keybindings.ts";
import type { OverlayStack } from "../../src/tui/layout/overlay-stack.ts";
import { TreeSelector } from "../../src/tui/selectors/tree-selector.ts";
import { buildSessionEntryRows, type SessionEntryTreeRow } from "../../src/tui/session-tree.ts";
import { ensureAgentProjection } from "../../src/tui/state.ts";

const ESCAPE = String.fromCharCode(27);
const ANSI_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");
const ENTER = "\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TIMESTAMP = "2026-08-01T00:00:00.000Z";
const NOW = new Date("2026-08-08T00:00:00.000Z");

beforeEach(() => {
	setKeybindings(createWidiKeybindings());
});

afterEach(() => {
	vi.useRealTimers();
});

function userEntry(id: string, parentId: string | null, text: string): MessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: { role: "user", content: text, timestamp: 0 },
	};
}

function assistantEntry(id: string, parentId: string): MessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: { role: "assistant", content: [] } as unknown as MessageEntry["message"],
	};
}

function snapshot(entries: readonly SessionTreeEntry[], leafId: string | null): AgentSessionTreeSnapshot {
	return { entries, leafId } as unknown as AgentSessionTreeSnapshot;
}

/** u1 → {u2, u3}, leaf under u3: one root, two branch rows, u3 current. */
function branchSnapshot(): AgentSessionTreeSnapshot {
	return snapshot(
		[
			userEntry("u1", null, "first question"),
			assistantEntry("a1", "u1"),
			userEntry("u2", "a1", "follow up"),
			assistantEntry("a2", "u2"),
			userEntry("u3", "a1", "new branch"),
			assistantEntry("a3", "u3"),
		],
		"a3",
	);
}

function branchRows(): SessionEntryTreeRow[] {
	return buildSessionEntryRows(branchSnapshot());
}

function plainRender(selector: TreeSelector, width = 80): string {
	return selector.render(width).join("\n").replace(ANSI_SEQUENCE, "");
}

describe("TreeSelector", () => {
	it("renders rules, title, branch rows and key hints", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const selector = new TreeSelector({ title: "/tree", rows: branchRows(), onSelect: () => {}, onClose: () => {} });

		const rendered = plainRender(selector);
		expect(rendered).toContain("─");
		expect(rendered).toContain("/tree");
		expect(rendered).toContain("○ first question 7d");
		expect(rendered).toContain("├── ○ follow up 7d");
		expect(rendered).toContain("└── ● new branch 7d");
		expect(rendered).toContain("navigate");
		expect(rendered).toContain("Enter switch");
		expect(rendered).toContain("Esc cancel");
		expect(selector.hintContext).toEqual({ title: "/tree", confirmVerb: "switch", itemCount: 3 });
	});

	it("renders a single chain without branch markers at the root", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const rows = buildSessionEntryRows(
			snapshot(
				[userEntry("u1", null, "first question"), assistantEntry("a1", "u1"), userEntry("u2", "a1", "follow up")],
				"u2",
			),
		);
		const selector = new TreeSelector({ title: "/tree", rows, onSelect: () => {}, onClose: () => {} });

		const rendered = plainRender(selector);
		expect(rendered).toContain("○ first question 7d");
		expect(rendered).toContain("└── ● follow up 7d");
		expect(rendered).not.toContain("├──");
	});

	it("renders an empty tree as a notice, not a dead list", () => {
		const selector = new TreeSelector({ title: "/tree", rows: [], onSelect: () => {}, onClose: () => {} });

		expect(plainRender(selector)).toContain("No user messages in this session tree.");
		expect(selector.cursorEntryId).toBeUndefined();
	});

	it("opens with the cursor on the current row and clamps at both ends", () => {
		const selector = new TreeSelector({ title: "/tree", rows: branchRows(), onSelect: () => {}, onClose: () => {} });

		expect(selector.cursorEntryId).toBe("u3");
		selector.handleInput(DOWN);
		expect(selector.cursorEntryId).toBe("u3");
		selector.handleInput(UP);
		expect(selector.cursorEntryId).toBe("u2");
		selector.handleInput(UP);
		expect(selector.cursorEntryId).toBe("u1");
		selector.handleInput(UP);
		expect(selector.cursorEntryId).toBe("u1");
	});

	it("opens on an explicit initial row when one is given", () => {
		const selector = new TreeSelector({
			title: "/tree",
			rows: branchRows(),
			initialEntryId: "u1",
			onSelect: () => {},
			onClose: () => {},
		});

		expect(selector.cursorEntryId).toBe("u1");
	});

	it("confirms the row under the cursor and closes", () => {
		const calls: string[] = [];
		const selector = new TreeSelector({
			title: "/tree",
			rows: branchRows(),
			onSelect: (entryId) => calls.push(`select:${entryId}`),
			onClose: () => calls.push("close"),
		});

		selector.handleInput(UP);
		selector.handleInput(ENTER);

		// onClose runs first so a re-opened selector is not torn down by it.
		expect(calls).toEqual(["close", "select:u2"]);
		expect(selector.render(80)).toEqual([]);
		expect(selector.hintContext).toBeUndefined();
	});

	it("cancels with escape", () => {
		const calls: string[] = [];
		const selector = new TreeSelector({
			title: "/tree",
			rows: branchRows(),
			onSelect: () => {},
			onCancel: () => calls.push("cancel"),
			onClose: () => calls.push("close"),
		});

		selector.handleInput(ESCAPE);

		expect(calls).toEqual(["close", "cancel"]);
		expect(selector.render(80)).toEqual([]);
	});

	it("follows remapped selection keybindings", () => {
		const keybindings = createWidiKeybindings();
		keybindings.setUserBindings({ "tui.select.up": "k" });
		setKeybindings(keybindings);
		const selector = new TreeSelector({ title: "/tree", rows: branchRows(), onSelect: () => {}, onClose: () => {} });

		selector.handleInput("k");

		expect(selector.cursorEntryId).toBe("u2");
	});

	it("ignores input after closing", () => {
		const selected: string[] = [];
		const selector = new TreeSelector({
			title: "/tree",
			rows: branchRows(),
			onSelect: (entryId) => selected.push(entryId),
			onClose: () => {},
		});
		selector.handleInput(ENTER);

		selector.handleInput(ENTER);

		expect(selected).toEqual(["u3"]);
	});

	it("scrolls the window once the cursor leaves it", () => {
		const entries: SessionTreeEntry[] = [];
		let parentId: string | null = null;
		for (let index = 0; index < 15; index++) {
			entries.push(userEntry(`u${index}`, parentId, `question ${index}`));
			parentId = `u${index}`;
		}
		const rows = buildSessionEntryRows(snapshot(entries, "u0"));
		const selector = new TreeSelector({ title: "/tree", rows, onSelect: () => {}, onClose: () => {} });

		for (let index = 0; index < 12; index++) selector.handleInput(DOWN);

		expect(selector.cursorEntryId).toBe("u12");
		const rendered = plainRender(selector);
		expect(rendered).toContain("… 3 more above");
		expect(rendered).toContain("… 2 more below");
	});
});

describe("WidiTuiApplication /tree selector", () => {
	it("opens the graph selector as an overlay on a bare /tree", async () => {
		const { application } = await createApplication();

		await submit(application, "/tree");

		expect(application.state.mode).toBe("selector");
		expect(application.tui.hasOverlay()).toBe(true);
		const selector = requireTreeSelector(application);
		const rendered = plainRender(selector);
		expect(rendered).toContain("├── ○ follow up");
		expect(rendered).toContain("└── ● new branch");
		expect(selector.hintContext).toEqual({ title: "/tree", confirmVerb: "switch", itemCount: 3 });
	});

	it("feeds the open graph selector into the operation hint", async () => {
		const { application } = await createApplication();

		await submit(application, "/tree");

		const hint = application.tui.children.find((child) => child instanceof OperationHintView);
		if (!hint) throw new Error("Expected the operation hint to be mounted.");
		const rendered = hint.render(120).join("\n").replace(ANSI_SEQUENCE, "");
		expect(rendered).toContain("/tree");
		expect(rendered).toContain("switch");
	});

	it("navigates in place on confirm: same agent, new leaf", async () => {
		const navigateAgentTree = vi.fn(async () => ({ cancelled: false }));
		const { application } = await createApplication({ navigateAgentTree });

		await submit(application, "/tree");
		const selector = requireTreeSelector(application);
		selector.handleInput(UP);
		selector.handleInput(ENTER);
		await flush();

		expect(navigateAgentTree).toHaveBeenCalledWith("agent-1", "u2");
		// Tree navigation moves the session, not the agent: no fork/resume-style
		// agent switch fires for it.
		expect(switchedAgentId({ kind: "executed", commandId: "c1", name: "tree", value: { cancelled: false } })).toBe(
			undefined,
		);
		expect(application.state.activeAgentId).toBe("agent-1");
		expect(application.state.mode).toBe("editor");
		expect(application.tui.hasOverlay()).toBe(false);
	});

	it("restores the submitted command when the graph selector is cancelled", async () => {
		const navigateAgentTree = vi.fn(async () => ({ cancelled: false }));
		const { application } = await createApplication({ navigateAgentTree });
		const editor = requireEditor(application);
		editor.setText("");

		await submit(application, "/tree");
		requireTreeSelector(application).handleInput(ESCAPE);

		expect(navigateAgentTree).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("/tree");
		expect(application.state.mode).toBe("editor");
		expect(application.tui.hasOverlay()).toBe(false);
	});
});

async function createApplication(overrides: Record<string, unknown> = {}) {
	const defaultModel = agentSnapshot("default").model;
	const promptAgent = overrides.promptAgent ?? (async () => ({ kind: "accepted" }) as const);
	const sendMessage = overrides.sendMessage ?? (async () => ({ kind: "accepted" }) as const);
	const orchestrator = {
		getAgentStatus: () => "idle",
		getAgentActivity: () => ({ activity: "idle" }),
		getDefaultModel: () => defaultModel,
		getDefaultThinkingLevel: () => "medium",
		getAgentSessionTree: async () => branchSnapshot(),
		navigateAgentTree: async () => ({ cancelled: false }),
		sendMessage,
		promptAgent,
		...overrides,
		messageSinkFor: () => ({ send: sendMessage, prompt: promptAgent }),
	} as unknown as AgentOrchestrator;
	const runtime = {
		orchestrator,
		services: { cwd: "/repo", agentDir: "/repo/.widi-test-missing", defaultProfile: { id: "default-agent" } },
		diagnostics: [],
	} as unknown as WidiRuntime;
	const application = await WidiTuiApplication.create({ cwd: "/repo", runtime });
	application.tui.requestRender = vi.fn();
	const agent = ensureAgentProjection(application.state, "agent-1", "idle");
	agent.snapshot = agentSnapshot("agent-1");
	application.state.activeAgentId = agent.agentId;
	application.state.pendingAgent = undefined;
	return { application, orchestrator };
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function agentSnapshot(agentId: string): AgentSnapshot {
	return {
		agentId,
		generation: 1,
		profile: {
			reference: { id: "default-agent", label: agentId },
			source: { kind: "memory", priority: 0 },
			entryId: "entry-1",
		},
		model: { provider: "vllm", id: "qwen3.6" } as AgentSnapshot["model"],
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

function requireTreeSelector(application: WidiTuiApplication): TreeSelector {
	const overlays = (application as unknown as { overlays: OverlayStack }).overlays;
	const handles = overlays.list();
	for (let i = handles.length - 1; i >= 0; i--) {
		const view = handles[i]?.component;
		if (view instanceof TreeSelector) return view;
	}
	throw new Error("Expected a tree selector overlay to be open.");
}

function requireEditor(application: WidiTuiApplication): WidiEditor {
	const editor = application.tui.children.find((child) => child instanceof WidiEditor);
	if (!editor) throw new Error("Expected the editor to be mounted.");
	return editor;
}

async function submit(application: WidiTuiApplication, text: string): Promise<void> {
	await (application as unknown as { submit(rawText: string): Promise<void> }).submit(text);
}
