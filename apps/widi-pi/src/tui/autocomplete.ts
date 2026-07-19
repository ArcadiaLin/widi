import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import type { AgentOrchestrator } from "../core/agent-orchestrator.ts";
import type {
	AgentLifecycleStatus,
	CandidateItem,
	RuntimeModel,
} from "../core/types.ts";
import type { CommandEngine } from "./commands/engine.ts";
import {
	INLINE_COMMAND_TRIGGER,
	LINE_COMMAND_TRIGGER,
} from "./commands/parse.ts";
import type { CommandView } from "./commands/types.ts";

interface CommandCompletionItem {
	readonly view: CommandView;
	readonly search: string;
	readonly label: string;
	readonly description?: string;
}

export class WidiCommandAutocompleteProvider implements AutocompleteProvider {
	readonly triggerCharacters = [LINE_COMMAND_TRIGGER, INLINE_COMMAND_TRIGGER];
	private readonly engine: CommandEngine;
	private readonly agentId?: string;
	private readonly orchestrator: AgentOrchestrator;
	private readonly getStatus: () => AgentLifecycleStatus | undefined;
	private readonly getPendingModel?: () => RuntimeModel | undefined;
	private readonly fileProvider?: CombinedAutocompleteProvider;

	constructor(options: {
		readonly engine: CommandEngine;
		readonly agentId?: string;
		readonly orchestrator: AgentOrchestrator;
		readonly getStatus: () => AgentLifecycleStatus | undefined;
		readonly getPendingModel?: () => RuntimeModel | undefined;
		readonly cwd?: string;
	}) {
		this.engine = options.engine;
		this.agentId = options.agentId;
		this.orchestrator = options.orchestrator;
		this.getStatus = options.getStatus;
		this.getPendingModel = options.getPendingModel;
		if (options.cwd) {
			this.fileProvider = new CombinedAutocompleteProvider([], options.cwd);
		}
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		if (options.signal.aborted) return null;
		const line = lines[cursorLine] ?? "";
		const beforeCursor = line.slice(0, cursorCol);

		if (beforeCursor.startsWith(LINE_COMMAND_TRIGGER)) {
			const body = beforeCursor.slice(LINE_COMMAND_TRIGGER.length);
			const separator = body.indexOf(":");
			if (separator === -1) {
				// An exact command name advances to the argument phase: re-offering
				// the same name would make Tab toggle the menu without progress.
				const exact = this.engine.line(body);
				if (exact?.complete) {
					let candidates: readonly CandidateItem[];
					try {
						candidates = await exact.complete(this.commandContext(), "");
					} catch {
						return null;
					}
					if (options.signal.aborted || candidates.length === 0) return null;
					return {
						items: candidates.map((candidate) => ({
							value: `${beforeCursor}:${candidate.value}`,
							label: candidate.label ?? candidate.value,
							description: candidate.description,
						})),
						prefix: beforeCursor,
					};
				}
				if (exact) return null;
				const items = this.views("line").map(toCommandCompletionItem);
				const filtered = fuzzyFilter(items, body, (item) => item.search).map(
					(item) => ({
						// No ":" suffix: pi-tui submits right after applying a "/"
						// completion, and a trailing colon would become an explicit
						// empty argument that bypasses the needs-argument menu.
						value: `${LINE_COMMAND_TRIGGER}${item.view.name}`,
						label: item.label,
						description: item.description,
					}),
				);
				return filtered.length > 0
					? { items: filtered, prefix: beforeCursor }
					: null;
			}
			const command = this.engine.line(body.slice(0, separator));
			if (!command?.complete) return null;
			const argumentPrefix = body.slice(separator + 1);
			let candidates: readonly CandidateItem[];
			try {
				candidates = await command.complete(
					this.commandContext(),
					argumentPrefix,
				);
			} catch {
				return null;
			}
			if (options.signal.aborted || candidates.length === 0) return null;
			return {
				items: candidates.map((candidate) => ({
					value: candidate.value,
					label: candidate.label ?? candidate.value,
					description: candidate.description,
				})),
				prefix: argumentPrefix,
			};
		}

		const inline = matchInlinePrefix(beforeCursor);
		if (!inline) {
			return (
				(await this.fileProvider?.getSuggestions(
					lines,
					cursorLine,
					cursorCol,
					options,
				)) ?? null
			);
		}
		if (inline.argumentPrefix !== undefined) {
			// Argument phase: `<name:arg…` completes the inline command's own
			// candidates (skills, prompt templates), mirroring line commands.
			const command = this.engine.inline(inline.name);
			if (!command?.complete) return null;
			let candidates: readonly CandidateItem[];
			try {
				candidates = await command.complete(
					this.commandContext(),
					inline.argumentPrefix,
				);
			} catch {
				return null;
			}
			if (options.signal.aborted || candidates.length === 0) return null;
			return {
				items: candidates.map((candidate) => ({
					value: candidate.value,
					label: candidate.label ?? candidate.value,
					description: candidate.description,
				})),
				prefix: inline.argumentPrefix,
			};
		}
		const filtered = fuzzyFilter(
			this.views("inline").map(toCommandCompletionItem),
			inline.name,
			(item) => item.search,
		).map((item) => ({
			value: `${INLINE_COMMAND_TRIGGER}${item.view.name}:>`,
			label: item.label,
			description: item.description,
		}));
		return filtered.length > 0
			? { items: filtered, prefix: inline.rawPrefix }
			: null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] ?? "";
		const isCommandCompletion =
			prefix.startsWith(LINE_COMMAND_TRIGGER) ||
			prefix.startsWith(INLINE_COMMAND_TRIGGER);
		if (!isCommandCompletion && this.fileProvider) {
			return this.fileProvider.applyCompletion(
				lines,
				cursorLine,
				cursorCol,
				item,
				prefix,
			);
		}
		const before = currentLine.slice(0, cursorCol - prefix.length);
		const after = currentLine.slice(cursorCol);
		const value = item.value;
		const nextLines = [...lines];
		nextLines[cursorLine] = `${before}${value}${after}`;
		// Inline completions insert the close trigger; land the cursor inside it.
		const closeOffset =
			value.startsWith(INLINE_COMMAND_TRIGGER) && value.endsWith(">") ? 1 : 0;
		return {
			lines: nextLines,
			cursorLine,
			cursorCol: before.length + value.length - closeOffset,
		};
	}

	shouldTriggerFileCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): boolean {
		return (
			this.fileProvider?.shouldTriggerFileCompletion?.(
				lines,
				cursorLine,
				cursorCol,
			) ?? false
		);
	}

	private views(kind: "line" | "inline"): CommandView[] {
		return this.engine
			.list(this.getStatus())
			.filter((view) => view.kind === kind);
	}

	private commandContext() {
		return {
			agentId: this.agentId,
			orchestrator: this.orchestrator,
			pendingModel: this.getPendingModel?.(),
		};
	}
}

function matchInlinePrefix(
	text: string,
): { name: string; argumentPrefix?: string; rawPrefix: string } | undefined {
	const boundary = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"));
	const rawPrefix = text.slice(boundary + 1);
	if (!rawPrefix.startsWith(INLINE_COMMAND_TRIGGER)) return undefined;
	if (rawPrefix.includes(">")) return undefined;
	const body = rawPrefix.slice(INLINE_COMMAND_TRIGGER.length);
	const separator = body.indexOf(":");
	if (separator === -1) return { name: body, rawPrefix };
	return {
		name: body.slice(0, separator),
		argumentPrefix: body.slice(separator + 1),
		rawPrefix,
	};
}

function toCommandCompletionItem(view: CommandView): CommandCompletionItem {
	const availability =
		view.available === false
			? `unavailable: ${view.unavailableReason ?? "not available"}`
			: undefined;
	return {
		view,
		search: view.name,
		label:
			view.kind === "line"
				? `${LINE_COMMAND_TRIGGER}${view.name}`
				: `${INLINE_COMMAND_TRIGGER}${view.name}`,
		description: [view.argumentHint, view.description, availability]
			.filter(Boolean)
			.join(" — "),
	};
}
