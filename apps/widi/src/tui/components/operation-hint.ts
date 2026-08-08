import { type Component, getKeybindings, type KeyId, truncateToWidth } from "@earendil-works/pi-tui";
import type { CommandEngine } from "../commands/engine.ts";
import { parseLineCommand } from "../commands/parse.ts";
import type { WidiEditor } from "../editor.ts";
import { singleLine } from "../format.ts";
import type { SelectorHintContext } from "../selectors/hints.ts";
import type { TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";
import { activeAgent, maintenanceLabel } from "./common.ts";

export interface OperationHintKeys {
	readonly agents?: string;
	readonly agentsPrevious?: string;
	readonly agentsNext?: string;
	readonly interrupt?: string;
	readonly steer?: string;
	readonly requests?: string;
	readonly selectUp?: string;
	readonly selectDown?: string;
	readonly selectConfirm?: string;
	readonly selectCancel?: string;
	readonly inputTab?: string;
	readonly inputSubmit?: string;
}

export interface ResolveOperationHintOptions {
	readonly state: TuiApplicationState;
	readonly engine: CommandEngine;
	readonly editorText: string;
	readonly editorAutocompleteVisible: boolean;
	readonly selector?: SelectorHintContext;
	readonly keys: OperationHintKeys;
}

export function resolveOperationHint(options: ResolveOperationHintOptions): string | undefined {
	if (options.state.mode === "human-request") return undefined;

	if (options.state.mode === "agent-panel") {
		return hintParts(
			keyAction(options.keys.selectUp, "back"),
			keyPair(options.keys.agentsPrevious, options.keys.agentsNext, "agent"),
			keyAction(options.keys.selectDown, "tree"),
			keyAction(options.keys.selectConfirm, "switch"),
			keyAction(options.keys.selectCancel, "back"),
		);
	}

	const selector = options.selector;
	if (selector) {
		return hintParts(
			selector.title,
			selector.description,
			keyPair(options.keys.selectUp, options.keys.selectDown, "choose"),
			selector.itemCount > 0 ? keyAction(options.keys.selectConfirm, selector.confirmVerb) : undefined,
			keyAction(options.keys.selectCancel, "cancel"),
		);
	}

	if (options.editorAutocompleteVisible) {
		const parsed = parseLineCommand(options.editorText);
		const command = parsed ? options.engine.get(parsed.name) : undefined;
		const tab = safePart(options.keys.inputTab);
		const confirm = safePart(options.keys.selectConfirm);
		const submit = safePart(options.keys.inputSubmit);
		const controls = [
			keyPair(options.keys.selectUp, options.keys.selectDown, "navigate"),
			keyAction(tab, "complete"),
			confirm && confirm !== tab ? keyAction(confirm, confirm === submit ? "submit" : "complete") : undefined,
			submit && submit !== tab && submit !== confirm ? keyAction(submit, "submit") : undefined,
			keyAction(options.keys.selectCancel, "close"),
		];
		if (command) {
			const usage = command.argumentHint ? `/${command.name} ${command.argumentHint}` : `/${command.name}`;
			return hintParts(usage, command.description, ...controls);
		}
		return hintParts("Commands", ...controls);
	}

	if (options.state.humanRequests.length > 0) {
		return hintParts(keyAction(options.keys.requests, "open requests"));
	}

	const agent = activeAgent(options.state);
	if (agent?.status === "running") {
		// Maintenance work (compaction, tree navigation) has no agent loop to
		// steer or abort; the only input that applies is the follow-up queue.
		if (agent.maintenance) {
			return hintParts(
				`${maintenanceLabel(agent.maintenance)}…`,
				keyAction(options.keys.inputSubmit, "queue follow-up"),
			);
		}
		// With an empty editor the steer key promotes what enter already queued,
		// so the hint has to say which of the two it would do.
		const steersQueue = options.editorText.trim().length === 0 && agent.queue.followUp.length > 0;
		return hintParts(
			keyAction(options.keys.interrupt, "abort"),
			keyAction(options.keys.steer, steersQueue ? "steer queued" : "steer"),
			keyAction(options.keys.inputSubmit, "queue follow-up"),
		);
	}
	const visibleAgentCount = [...options.state.agents.values()].filter(
		(candidate) => candidate.status !== "disposed",
	).length;
	if (agent && visibleAgentCount > 1) {
		return hintParts(
			options.editorText.length === 0 ? keyAction(options.keys.agents, "switch agent") : undefined,
			"/dispose close current",
		);
	}
	if (!agent && options.state.pendingAgent) {
		return hintParts(
			keyAction(options.keys.inputSubmit, "starts session"),
			"/model or /thinking configures before first prompt",
		);
	}
	return undefined;
}

function keyAction(key: string | undefined, action: string): string | undefined {
	const safeKey = safePart(key);
	return safeKey ? `${safeKey} ${action}` : undefined;
}

function keyPair(first: string | undefined, second: string | undefined, action: string): string | undefined {
	const keys = [safePart(first), safePart(second)].filter((candidate): candidate is string => candidate !== undefined);
	return keys.length > 0 ? `${keys.join("/")} ${action}` : undefined;
}

function hintParts(...parts: Array<string | undefined>): string | undefined {
	const safeParts = parts.map((part) => safePart(part)).filter((part): part is string => part !== undefined);
	return safeParts.length > 0 ? safeParts.join(" · ") : undefined;
}

function safePart(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const safe = singleLine(value, value.length);
	return safe || undefined;
}

export function formatOperationHintKey(key: KeyId): string {
	const modifiers: string[] = [];
	let base: string = key;
	while (true) {
		const separatorIndex = base.indexOf("+");
		if (separatorIndex < 0) break;
		const modifier = base.slice(0, separatorIndex);
		if (!["ctrl", "shift", "alt", "super"].includes(modifier)) break;
		modifiers.push(modifier === "ctrl" ? "Ctrl" : modifier[0]?.toUpperCase() + modifier.slice(1));
		base = base.slice(separatorIndex + 1);
	}
	const baseLabel =
		{
			up: "↑",
			down: "↓",
			left: "←",
			right: "→",
			escape: "Esc",
			esc: "Esc",
			enter: "Enter",
			return: "Enter",
			tab: "Tab",
			space: "Space",
			backspace: "Backspace",
			delete: "Delete",
			insert: "Insert",
			clear: "Clear",
			home: "Home",
			end: "End",
			pageUp: "PageUp",
			pageDown: "PageDown",
		}[base] ?? base.toUpperCase();
	return [...modifiers, baseLabel].join("+");
}

export class OperationHintView implements Component {
	private readonly state: TuiApplicationState;
	private readonly engine: CommandEngine;
	private readonly editor: Pick<WidiEditor, "getText" | "isShowingAutocomplete">;
	private readonly selectorHint: () => SelectorHintContext | undefined;

	constructor(options: {
		readonly state: TuiApplicationState;
		readonly engine: CommandEngine;
		readonly editor: Pick<WidiEditor, "getText" | "isShowingAutocomplete">;
		readonly selectorHint: () => SelectorHintContext | undefined;
	}) {
		this.state = options.state;
		this.engine = options.engine;
		this.editor = options.editor;
		this.selectorHint = options.selectorHint;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const keybindings = getKeybindings();
		const key = (action: Parameters<typeof keybindings.getKeys>[0]): string | undefined => {
			const keyId = keybindings.getKeys(action)[0];
			return keyId ? formatOperationHintKey(keyId) : undefined;
		};
		const hint = resolveOperationHint({
			state: this.state,
			engine: this.engine,
			editorText: this.editor.getText(),
			editorAutocompleteVisible: this.editor.isShowingAutocomplete(),
			selector: this.selectorHint(),
			keys: {
				agents: key("app.agents.open"),
				agentsPrevious: key("app.agents.previous"),
				agentsNext: key("app.agents.next"),
				interrupt: key("app.interrupt"),
				steer: key("app.steer"),
				requests: key("app.request.open"),
				selectUp: key("tui.select.up"),
				selectDown: key("tui.select.down"),
				selectConfirm: key("tui.select.confirm"),
				selectCancel: key("tui.select.cancel"),
				inputTab: key("tui.input.tab"),
				inputSubmit: key("tui.input.submit"),
			},
		});
		return hint ? [theme.dim(truncateToWidth(hint, width, "…"))] : [];
	}
}
