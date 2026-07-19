import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { applicationCommands } from "../../src/tui/commands/app-commands.ts";
import { builtInCommands } from "../../src/tui/commands/built-ins.ts";
import { CommandEngine } from "../../src/tui/commands/engine.ts";
import {
	formatOperationHintKey,
	OperationHintView,
	resolveOperationHint,
} from "../../src/tui/components/operation-hint.ts";
import { createWidiKeybindings } from "../../src/tui/keybindings.ts";
import {
	createTuiApplicationState,
	ensureAgentProjection,
	setActiveAgent,
} from "../../src/tui/state.ts";

const engine = new CommandEngine(builtInCommands);
const keys = {
	agents: "←",
	interrupt: "Esc",
	steer: "Ctrl+S",
	requests: "Ctrl+R",
	selectUp: "↑",
	selectDown: "↓",
	selectConfirm: "Enter",
	selectCancel: "Esc",
	inputTab: "Tab",
	inputSubmit: "Enter",
};
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

beforeEach(() => {
	setKeybindings(createWidiKeybindings());
});

describe("resolveOperationHint", () => {
	it("formats KeyIds as compact readable labels", () => {
		expect(formatOperationHintKey("up")).toBe("↑");
		expect(formatOperationHintKey("down")).toBe("↓");
		expect(formatOperationHintKey("left")).toBe("←");
		expect(formatOperationHintKey("right")).toBe("→");
		expect(formatOperationHintKey("escape")).toBe("Esc");
		expect(formatOperationHintKey("enter")).toBe("Enter");
		expect(formatOperationHintKey("tab")).toBe("Tab");
		expect(formatOperationHintKey("ctrl+s")).toBe("Ctrl+S");
		expect(formatOperationHintKey("shift+enter")).toBe("Shift+Enter");
		expect(formatOperationHintKey("shift+ctrl+s")).toBe("Shift+Ctrl+S");
	});

	it("prioritizes a command completion menu and includes command-specific help", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "running";

		expect(
			resolveOperationHint({
				state,
				engine,
				editorText: "/model",
				editorAutocompleteVisible: false,
				completion: {
					title: "/model",
					description: "Set the current agent model.",
					confirmVerb: "apply",
					itemCount: 2,
				},
				keys,
			}),
		).toBe(
			"/model · Set the current agent model. · ↑/↓ choose · Enter apply · Esc cancel",
		);
	});

	it("uses exact command description and usage for editor autocomplete", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";

		expect(
			resolveOperationHint({
				state,
				engine,
				editorText: "/thinking",
				editorAutocompleteVisible: true,
				keys,
			}),
		).toContain("/thinking:[level] · Set the current agent thinking level.");
	});

	it("uses application-owned command metadata for autocomplete help", () => {
		const applicationEngine = new CommandEngine([
			...builtInCommands,
			...applicationCommands({
				quit: () => {},
				newSession: () => {},
				disposeAgent: async () => {},
			}),
		]);
		const state = createTuiApplicationState();

		expect(
			resolveOperationHint({
				state,
				engine: applicationEngine,
				editorText: "/new",
				editorAutocompleteVisible: true,
				keys,
			}),
		).toContain("/new · Prepare a new session from the current agent.");
	});

	it("prioritizes completion over autocomplete", () => {
		const state = createTuiApplicationState();

		expect(
			resolveOperationHint({
				state,
				engine,
				editorText: "/thinking",
				editorAutocompleteVisible: true,
				completion: {
					title: "/model",
					description: "Set the current agent model.",
					confirmVerb: "apply",
					itemCount: 1,
				},
				keys,
			}),
		).toBe(
			"/model · Set the current agent model. · ↑/↓ choose · Enter apply · Esc cancel",
		);
	});

	it("prioritizes autocomplete over pending human requests", () => {
		const state = createTuiApplicationState();
		state.humanRequests = [
			{
				agentId: "main",
				request: {
					id: "request-1",
					agentId: "main",
					source: { kind: "human" },
					kind: "input",
					title: "Provide value",
					createdAt: new Date(0).toISOString(),
				},
			},
		];

		expect(
			resolveOperationHint({
				state,
				engine,
				editorText: "/thinking",
				editorAutocompleteVisible: true,
				keys,
			}),
		).toContain("/thinking:[level] · Set the current agent thinking level.");
	});

	it("omits apply when a completion menu has no candidates", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "idle";

		const hint = resolveOperationHint({
			state,
			engine,
			editorText: "/rename",
			editorAutocompleteVisible: false,
			completion: {
				title: "/rename",
				description: "Rename the current agent session.",
				confirmVerb: "apply",
				itemCount: 0,
			},
			keys,
		});

		expect(hint).toContain("Esc cancel");
		expect(hint).not.toContain("Enter apply");
	});

	it("uses supplied completion control labels and omits unbound controls", () => {
		const state = createTuiApplicationState();

		expect(
			resolveOperationHint({
				state,
				engine,
				editorText: "",
				editorAutocompleteVisible: false,
				completion: {
					title: "/model",
					confirmVerb: "apply",
					itemCount: 1,
				},
				keys: {
					...keys,
					selectUp: "Ctrl+K",
					selectDown: "Ctrl+J",
					selectConfirm: "Space",
					selectCancel: undefined,
				},
			}),
		).toBe("/model · Ctrl+K/Ctrl+J choose · Space apply");
	});

	it("uses supplied autocomplete control labels", () => {
		const state = createTuiApplicationState();

		expect(
			resolveOperationHint({
				state,
				engine,
				editorText: "/thinking",
				editorAutocompleteVisible: true,
				keys: {
					...keys,
					selectUp: "Ctrl+K",
					selectDown: "Ctrl+J",
					selectConfirm: "Space",
					selectCancel: "Ctrl+G",
					inputTab: "Alt+Tab",
				},
			}),
		).toBe(
			"/thinking:[level] · Set the current agent thinking level. · Ctrl+K/Ctrl+J navigate · Alt+Tab complete · Space complete · Enter submit · Ctrl+G close",
		);
	});

	it("sanitizes completion metadata into a single terminal-safe line", () => {
		const state = createTuiApplicationState();
		const title = "/model\u001b[2J\nnext\u0000";
		const description = "Set\u001b]0;owned\u0007 model\r\nnow\u0001";

		const hint = resolveOperationHint({
			state,
			engine,
			editorText: "",
			editorAutocompleteVisible: false,
			completion: {
				title,
				description,
				confirmVerb: "apply",
				itemCount: 1,
			},
			keys,
		});

		expect(hint).toBe(
			"/model next · Set model now · ↑/↓ choose · Enter apply · Esc cancel",
		);
	});

	it("drops sanitized-empty completion parts before pairing and joining", () => {
		const state = createTuiApplicationState();

		const hint = resolveOperationHint({
			state,
			engine,
			editorText: "",
			editorAutocompleteVisible: false,
			completion: {
				title: "\u001b[2J",
				description: "\u0000",
				confirmVerb: "apply",
				itemCount: 0,
			},
			keys: {
				...keys,
				selectUp: "",
				selectDown: "→",
				selectCancel: "\u0001",
			},
		});

		expect(hint).toBe("→ choose");
	});

	it("drops a sanitized-empty second key without leaving a pair separator", () => {
		const state = createTuiApplicationState();

		const hint = resolveOperationHint({
			state,
			engine,
			editorText: "/unknown",
			editorAutocompleteVisible: true,
			keys: {
				...keys,
				selectUp: "↑",
				selectDown: "\u0001",
				selectConfirm: undefined,
				selectCancel: undefined,
				inputTab: undefined,
			},
		});

		expect(hint).toBe("Commands · ↑ navigate · Enter submit");
	});

	it("renders malicious completion metadata as one safe display line", () => {
		const state = createTuiApplicationState();
		const view = new OperationHintView({
			state,
			engine,
			editor: {
				getText: () => "",
				isShowingAutocomplete: () => false,
			},
			menu: {
				hintContext: {
					title: "/model\u001b[2J\nnext\u0000",
					description: "Set\u001b]0;owned\u0007 model\r\nnow\u0001",
					confirmVerb: "apply",
					itemCount: 1,
				},
			},
		});

		const rendered = view
			.render(120)
			.map((line) => line.replace(ANSI_SEQUENCE, ""));

		expect(rendered).toEqual([
			"/model next · Set model now · ↑/↓ choose · Enter apply · Esc cancel",
		]);
	});

	it("renders configured autocomplete keys and omits an unbound action", () => {
		const keybindings = createWidiKeybindings();
		keybindings.setUserBindings({
			"tui.select.up": "ctrl+k",
			"tui.select.down": "ctrl+j",
			"tui.select.confirm": "space",
			"tui.select.cancel": [],
			"tui.input.tab": "alt+tab",
		});
		setKeybindings(keybindings);
		const state = createTuiApplicationState();
		const view = new OperationHintView({
			state,
			engine,
			editor: {
				getText: () => "/thinking",
				isShowingAutocomplete: () => true,
			},
			menu: { hintContext: undefined },
		});

		const rendered = view.render(180).join("\n").replace(ANSI_SEQUENCE, "");

		expect(rendered).toBe(
			"/thinking:[level] · Set the current agent thinking level. · Ctrl+K/Ctrl+J navigate · Alt+Tab complete · Space complete · Enter submit",
		);
	});

	it("omits unbound running controls in the view", () => {
		const keybindings = createWidiKeybindings();
		keybindings.setUserBindings({
			"app.interrupt": [],
			"app.steer": "alt+s",
			"tui.input.submit": [],
		});
		setKeybindings(keybindings);
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "running";
		const view = new OperationHintView({
			state,
			engine,
			editor: {
				getText: () => "",
				isShowingAutocomplete: () => false,
			},
			menu: { hintContext: undefined },
		});

		const rendered = view.render(80).join("\n").replace(ANSI_SEQUENCE, "");

		expect(rendered).toBe("Alt+S steer");
	});

	it("prioritizes pending human requests over running controls", () => {
		const state = createTuiApplicationState();
		setActiveAgent(state, "main").status = "running";
		state.humanRequests = [
			{
				agentId: "main",
				request: {
					id: "request-1",
					agentId: "main",
					source: { kind: "human" },
					kind: "input",
					title: "Provide value",
					createdAt: new Date(0).toISOString(),
				},
			},
		];

		expect(
			resolveOperationHint({
				state,
				engine,
				editorText: "",
				editorAutocompleteVisible: false,
				keys,
			}),
		).toBe("Ctrl+R open requests");
	});

	it("renders no separate hint while the human request menu owns focus", () => {
		const state = createTuiApplicationState();
		state.mode = "human-request";
		state.humanRequests = [
			{
				agentId: "main",
				request: {
					id: "request-1",
					agentId: "main",
					source: { kind: "human" },
					kind: "input",
					title: "Provide value",
					createdAt: new Date(0).toISOString(),
				},
			},
		];

		expect(
			resolveOperationHint({
				state,
				engine,
				editorText: "/thinking",
				editorAutocompleteVisible: true,
				completion: {
					title: "/model",
					confirmVerb: "apply",
					itemCount: 1,
				},
				keys,
			}),
		).toBeUndefined();
	});

	it("omits unbound running and pending controls", () => {
		const state = createTuiApplicationState();
		const main = setActiveAgent(state, "main");
		main.status = "running";

		expect(
			resolveOperationHint({
				state,
				engine,
				editorText: "",
				editorAutocompleteVisible: false,
				keys: {
					...keys,
					interrupt: undefined,
					steer: "Alt+S",
					inputSubmit: undefined,
				},
			}),
		).toBe("Alt+S steer");

		state.activeAgentId = undefined;
		state.agents.clear();
		state.pendingAgent = {
			start: { kind: "default" },
			timeline: [],
			draft: "",
			display: {
				profileLabel: "Main",
				model: {
					id: "test-model",
					name: "Test Model",
					api: "anthropic-messages",
					provider: "test",
					baseUrl: "https://example.test",
					reasoning: false,
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
			},
			nextLiveItemId: 1,
		};

		expect(
			resolveOperationHint({
				state,
				engine,
				editorText: "",
				editorAutocompleteVisible: false,
				keys: { ...keys, inputSubmit: undefined },
			}),
		).toBe("/model or /thinking configures before first prompt");
	});

	it("prioritizes running, multiple-agent, and pending hints in that order", () => {
		const state = createTuiApplicationState();
		const main = setActiveAgent(state, "main");
		main.status = "running";
		ensureAgentProjection(state, "worker", "idle");

		const running = resolveOperationHint({
			state,
			engine,
			editorText: "",
			editorAutocompleteVisible: false,
			keys,
		});
		expect(running).toBe("Esc abort · Ctrl+S steer · Enter queue follow-up");

		main.status = "idle";
		const multiple = resolveOperationHint({
			state,
			engine,
			editorText: "",
			editorAutocompleteVisible: false,
			keys,
		});
		expect(multiple).toBe("← switch agent · /dispose close current");

		const draft = resolveOperationHint({
			state,
			engine,
			editorText: "draft",
			editorAutocompleteVisible: false,
			keys,
		});
		expect(draft).toBe("/dispose close current");

		state.activeAgentId = undefined;
		state.agents.clear();
		state.pendingAgent = {
			start: { kind: "default" },
			timeline: [],
			draft: "",
			display: {
				profileLabel: "Main",
				model: {
					id: "test-model",
					name: "Test Model",
					api: "anthropic-messages",
					provider: "test",
					baseUrl: "https://example.test",
					reasoning: false,
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
			},
			nextLiveItemId: 1,
		};
		const pending = resolveOperationHint({
			state,
			engine,
			editorText: "",
			editorAutocompleteVisible: false,
			keys,
		});
		expect(pending).toBe(
			"Enter starts session · /model or /thinking configures before first prompt",
		);
	});
});
