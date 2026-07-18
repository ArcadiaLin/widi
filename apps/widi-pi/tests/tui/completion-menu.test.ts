import { type SelectItem, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { AgentRecordSnapshot } from "../../src/core/agent-record.ts";
import type { WidiRuntime } from "../../src/core/runtime-service.ts";
import { WidiTuiApplication } from "../../src/tui/application.ts";
import { CompletionMenu } from "../../src/tui/completion-menu.ts";
import { WidiEditor } from "../../src/tui/editor.ts";
import { createWidiKeybindings } from "../../src/tui/keybindings.ts";
import {
	createTuiApplicationState,
	ensureAgentProjection,
} from "../../src/tui/state.ts";

const ESCAPE = String.fromCharCode(27);
const ANSI_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");
const ENTER = "\r";
const BACKSPACE = "\u007f";

beforeAll(() => {
	setKeybindings(createWidiKeybindings());
});

function createMenu() {
	const focus: string[] = [];
	const state = createTuiApplicationState();
	const menu = new CompletionMenu(
		{
			setFocus: (component) => {
				focus.push(component === menu ? "menu" : "editor");
			},
			requestRender: () => {},
		},
		state,
		() => focus.push("restored"),
	);
	return { menu, state, focus };
}

const items: SelectItem[] = [
	{ value: "vllm/qwen3.6", label: "vllm/qwen3.6", description: "local" },
	{ value: "vllm/glm-5", label: "vllm/glm-5", description: "local" },
	{ value: "anthropic/claude", label: "anthropic/claude", description: "api" },
];

function plainRender(menu: CompletionMenu, width = 80): string {
	return menu.render(width).join("\n").replace(ANSI_SEQUENCE, "");
}

describe("CompletionMenu", () => {
	it("renders nothing while closed", () => {
		const { menu } = createMenu();
		expect(menu.render(80)).toEqual([]);
	});

	it("renders title, items, and hint while open", () => {
		const { menu, state, focus } = createMenu();
		menu.open({ title: "/model", items, onSelect: () => {} });

		const rendered = plainRender(menu);
		expect(rendered).toContain("/model");
		expect(rendered).toContain("vllm/qwen3.6");
		expect(rendered).toContain("anthropic/claude");
		expect(rendered).toContain("esc cancel");
		expect(state.mode).toBe("completion-menu");
		expect(focus).toEqual(["menu"]);
	});

	it("filters items with typed characters and restores on backspace", () => {
		const { menu } = createMenu();
		menu.open({ title: "/model", items, onSelect: () => {} });

		menu.handleInput("g");
		menu.handleInput("l");
		menu.handleInput("m");
		let rendered = plainRender(menu);
		expect(rendered).toContain("vllm/glm-5");
		expect(rendered).not.toContain("anthropic/claude");

		menu.handleInput(BACKSPACE);
		menu.handleInput(BACKSPACE);
		menu.handleInput(BACKSPACE);
		rendered = plainRender(menu);
		expect(rendered).toContain("anthropic/claude");
	});

	it("selects with enter and closes", () => {
		const { menu, state, focus } = createMenu();
		const selected: string[] = [];
		menu.open({
			title: "/model",
			items,
			onSelect: (item) => selected.push(item.value),
		});

		menu.handleInput(ENTER);

		expect(selected).toEqual(["vllm/qwen3.6"]);
		expect(menu.isOpen).toBe(false);
		expect(state.mode).toBe("editor");
		expect(focus).toEqual(["menu", "restored"]);
	});

	it("cancels with escape", () => {
		const { menu } = createMenu();
		let cancelled = false;
		menu.open({
			title: "/model",
			items,
			onSelect: () => {},
			onCancel: () => {
				cancelled = true;
			},
		});

		menu.handleInput(ESCAPE);

		expect(cancelled).toBe(true);
		expect(menu.isOpen).toBe(false);
		expect(menu.render(80)).toEqual([]);
	});
});

describe("WidiTuiApplication completion menu integration", () => {
	it("opens the inline menu for a bare selector and resubmits its selection", async () => {
		const setAgentModelByReference = vi.fn(async () => undefined);
		const { application } = await createApplication({
			listAvailableModelCandidates: async () => ({
				models: [
					{ value: "vllm/qwen3.6", label: "Qwen 3.6", description: "local" },
				],
			}),
			setAgentModelByReference,
		});

		await submit(application, "/model");

		const menu = requireMenu(application);
		expect(application.state.mode).toBe("completion-menu");
		expect(plainRender(menu)).toContain("Qwen 3.6");
		expect(setAgentModelByReference).not.toHaveBeenCalled();

		menu.handleInput(ENTER);
		await flush();

		expect(setAgentModelByReference).toHaveBeenCalledWith(
			"agent-1",
			"vllm/qwen3.6",
		);
	});

	it("restores the submitted command when the inline menu is cancelled", async () => {
		const { application } = await createApplication({
			listAvailableModelCandidates: async () => ({
				models: [{ value: "vllm/qwen3.6", label: "Qwen 3.6" }],
			}),
		});
		const editor = requireEditor(application);
		editor.setText("");

		await submit(application, "/model");
		requireMenu(application).handleInput(ESCAPE);

		expect(editor.getText()).toBe("/model");
		expect(application.state.mode).toBe("editor");
	});

	it("offers the current position before explicit fork points", async () => {
		const forkAgentSessionFromAgent = vi.fn(async () => undefined);
		const { application } = await createApplication({
			getAgentSessionTree: async () => ({
				entries: [
					{
						type: "message",
						id: "message-1",
						timestamp: "2026-07-17T00:00:00.000Z",
						message: { role: "user", content: "Earlier user message" },
					},
				],
			}),
			forkAgentSessionFromAgent,
		});

		await submit(application, "/fork");
		const menu = requireMenu(application);

		expect(plainRender(menu)).toContain("Fork here (current position)");
		menu.handleInput(ENTER);
		await flush();
		expect(forkAgentSessionFromAgent).toHaveBeenCalledWith(
			"agent-1",
			undefined,
		);
	});

	it("renders the agent selector through the shared inline menu", async () => {
		const { application } = await createApplication();
		const second = ensureAgentProjection(application.state, "agent-2", "idle");
		second.snapshot = agentSnapshot("agent-2");
		const editor = requireEditor(application);

		editor.handleInput("\x1b[D");

		expect(application.state.mode).toBe("completion-menu");
		const rendered = plainRender(requireMenu(application));
		expect(rendered).toContain("Select agent");
		expect(rendered).toContain("agent-1");
		expect(rendered).toContain("agent-2");
	});
});

describe("WidiTuiApplication command submission", () => {
	it("removes inline command items after a successful prompt expansion", async () => {
		const promptAgent = vi.fn(async () => ({ kind: "accepted" }) as const);
		const { application } = await createApplication({
			getAgentSkill: async (_agentId: string, name: string) => ({
				name,
				description: "Review the current changes.",
				filePath: `/skills/${name}/SKILL.md`,
			}),
			promptAgent,
		});

		await submit(application, "Use <skill:review>");

		expect(promptAgent).toHaveBeenCalledOnce();
		expect(
			application.state.agents
				.get("agent-1")
				?.timeline.filter((item) => item.type === "command-result"),
		).toEqual([]);
	});

	it("removes earlier inline command items when a later expansion fails", async () => {
		const promptAgent = vi.fn(async () => ({ kind: "accepted" }) as const);
		const { application } = await createApplication({
			getAgentSkill: async (_agentId: string, name: string) => {
				if (name === "broken") throw new Error("skill expansion failed");
				return {
					name,
					description: "Review the current changes.",
					filePath: `/skills/${name}/SKILL.md`,
				};
			},
			promptAgent,
		});

		await submit(application, "Use <skill:review> then <skill:broken>");

		expect(promptAgent).not.toHaveBeenCalled();
		expect(
			application.state.agents
				.get("agent-1")
				?.timeline.filter((item) => item.type === "command-result"),
		).toMatchObject([
			{
				name: "skill",
				argument: "broken",
				status: "failed",
				error: { message: "skill expansion failed" },
			},
		]);
	});

	it("preserves a status-gated line command argument in its failed item", async () => {
		const { application } = await createApplication();

		await submit(application, "/steer:go");

		expect(
			application.state.agents
				.get("agent-1")
				?.timeline.filter((item) => item.type === "command-result"),
		).toMatchObject([
			{
				name: "steer",
				argument: "go",
				status: "failed",
				error: {
					message: "Command /steer requires a running agent (status: idle).",
				},
			},
		]);
	});
});

async function createApplication(overrides: Record<string, unknown> = {}) {
	const orchestrator = {
		getAgentStatus: () => "idle",
		...overrides,
	} as unknown as AgentOrchestrator;
	const runtime = {
		orchestrator,
		services: { cwd: "/repo" },
		diagnostics: [],
	} as unknown as WidiRuntime;
	const application = await WidiTuiApplication.create({
		cwd: "/repo",
		runtime,
	});
	application.tui.requestRender = vi.fn();
	const agent = ensureAgentProjection(application.state, "agent-1", "idle");
	agent.snapshot = agentSnapshot("agent-1");
	application.state.activeAgentId = agent.agentId;
	return { application, orchestrator };
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function agentSnapshot(agentId: string): AgentRecordSnapshot {
	return {
		agentId,
		status: "idle",
		profile: { reference: { id: "default-agent", label: agentId } },
		model: {
			provider: "vllm",
			id: "qwen3.6",
		} as AgentRecordSnapshot["model"],
		hasHarness: true,
		extensionIds: [],
		extensions: [],
		extensionSnapshot: {
			extensionIds: [],
			extensions: [],
			hooks: [],
			toolContributions: [],
			resourceContributions: [],
			providerContributions: [],
			stale: { stale: false },
		},
		resourceDiagnostics: [],
		extensionDiagnostics: [],
		diagnostics: [],
	};
}

function requireMenu(application: WidiTuiApplication): CompletionMenu {
	const menu = application.tui.children.find(
		(child) => child instanceof CompletionMenu,
	);
	if (!menu) throw new Error("Expected the completion menu to be mounted.");
	return menu;
}

function requireEditor(application: WidiTuiApplication): WidiEditor {
	const editor = application.tui.children.find(
		(child) => child instanceof WidiEditor,
	);
	if (!editor) throw new Error("Expected the editor to be mounted.");
	return editor;
}

async function submit(
	application: WidiTuiApplication,
	text: string,
): Promise<void> {
	await (
		application as unknown as {
			submit(rawText: string): Promise<void>;
		}
	).submit(text);
}
