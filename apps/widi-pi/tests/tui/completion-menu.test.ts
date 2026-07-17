import { type SelectItem, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import type { AgentRecordSnapshot } from "../../src/core/agent-record.ts";
import type { Command, InputResult } from "../../src/core/command.ts";
import type { WidiRuntime } from "../../src/core/runtime-service.ts";
import { WidiTuiApplication } from "../../src/tui/application.ts";
import {
	CompletionMenu,
	matchBareSelectorCommand,
} from "../../src/tui/completion-menu.ts";
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

describe("matchBareSelectorCommand", () => {
	const commands: Command[] = [
		{
			name: "model",
			placement: "line",
			trigger: "/",
			source: { kind: "built-in" },
			arguments: { complete: async () => [] },
		},
		{
			name: "name",
			placement: "line",
			trigger: "/",
			source: { kind: "built-in" },
			arguments: { required: true },
		},
		{
			name: "resume",
			placement: "line",
			trigger: "/",
			source: { kind: "built-in" },
			available: false,
			arguments: { complete: async () => [] },
		},
	];

	it("matches a bare command that offers candidates", () => {
		expect(matchBareSelectorCommand("/model", commands)?.name).toBe("model");
		expect(matchBareSelectorCommand(" /model ", commands)?.name).toBe("model");
	});

	it("ignores arguments, unknown names, and commands without completion", () => {
		expect(matchBareSelectorCommand("/model:x", commands)).toBeUndefined();
		expect(matchBareSelectorCommand("/name", commands)).toBeUndefined();
		expect(matchBareSelectorCommand("/missing", commands)).toBeUndefined();
		expect(matchBareSelectorCommand("hello", commands)).toBeUndefined();
	});

	it("skips unavailable commands", () => {
		expect(matchBareSelectorCommand("/resume", commands)).toBeUndefined();
	});
});

describe("WidiTuiApplication completion menu integration", () => {
	it("opens the inline menu for a bare selector and resubmits its selection", async () => {
		const command = selectorCommand("model", [
			{
				value: "vllm/qwen3.6",
				label: "Qwen 3.6",
				description: "local",
			},
		]);
		const { application, inputAgent } = await createApplication(command);

		await submit(application, "/model");

		const menu = requireMenu(application);
		expect(application.state.mode).toBe("completion-menu");
		expect(plainRender(menu)).toContain("Qwen 3.6");
		expect(inputAgent).not.toHaveBeenCalled();

		menu.handleInput(ENTER);

		expect(inputAgent).toHaveBeenCalledWith("agent-1", "/model:vllm/qwen3.6");
	});

	it("restores the submitted command when the inline menu is cancelled", async () => {
		const { application } = await createApplication(
			selectorCommand("model", [{ value: "vllm/qwen3.6", label: "Qwen 3.6" }]),
		);
		const editor = requireEditor(application);
		editor.setText("");

		await submit(application, "/model");
		requireMenu(application).handleInput(ESCAPE);

		expect(editor.getText()).toBe("/model");
		expect(application.state.mode).toBe("editor");
	});

	it("offers the current position before explicit fork points", async () => {
		const { application, inputAgent } = await createApplication(
			selectorCommand("fork", [
				{ value: "message-1", label: "Earlier user message" },
			]),
		);

		await submit(application, "/fork");
		const menu = requireMenu(application);

		expect(plainRender(menu)).toContain("Fork here (current position)");
		menu.handleInput(ENTER);
		expect(inputAgent).toHaveBeenCalledWith("agent-1", "/fork:");
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

function selectorCommand(
	name: string,
	candidates: Awaited<
		ReturnType<NonNullable<NonNullable<Command["arguments"]>["complete"]>>
	>,
): Command {
	return {
		name,
		placement: "line",
		trigger: "/",
		source: { kind: "built-in" },
		arguments: { complete: async () => candidates },
	};
}

async function createApplication(command?: Command) {
	const result: InputResult = {
		kind: "command",
		commandId: "command-1",
		name: command?.name ?? "status",
		value: undefined,
	};
	const inputAgent = vi.fn(async () => result);
	const orchestrator = {
		inputAgent,
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
	agent.commands = command ? [command] : [];
	application.state.activeAgentId = agent.agentId;
	return { application, inputAgent };
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
			commands: [],
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
