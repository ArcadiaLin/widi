import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import type { AgentOrchestrator } from "../core/agent-orchestrator.ts";
import type { Command, CommandCandidates } from "../core/command.ts";

interface CommandCompletionItem {
	readonly command: Command;
	readonly search: string;
	readonly label: string;
	readonly description?: string;
}

export class WidiCommandAutocompleteProvider implements AutocompleteProvider {
	readonly triggerCharacters: string[];
	private readonly commands: readonly Command[];
	private readonly agentId: string;
	private readonly orchestrator: AgentOrchestrator;
	private readonly fileProvider?: CombinedAutocompleteProvider;

	constructor(options: {
		readonly commands: readonly Command[];
		readonly agentId: string;
		readonly orchestrator: AgentOrchestrator;
		readonly cwd?: string;
	}) {
		this.commands = options.commands;
		this.agentId = options.agentId;
		this.orchestrator = options.orchestrator;
		this.triggerCharacters = [
			...new Set(
				options.commands
					.map((command) => command.trigger[0])
					.filter((trigger): trigger is string => trigger !== undefined),
			),
		];
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

		const lineCommand = this.matchLineCommand(beforeCursor);
		if (lineCommand) {
			const { command, argumentPrefix, argumentStart } = lineCommand;
			if (!command) {
				const trigger =
					this.commands
						.filter((entry) => entry.placement === "line")
						.map((entry) => entry.trigger)
						.sort((left, right) => right.length - left.length)
						.find((entry) => beforeCursor.startsWith(entry)) ?? "/";
				const prefix = beforeCursor.slice(trigger.length);
				const items = this.commands
					.filter(
						(entry) => entry.placement === "line" && entry.trigger === trigger,
					)
					.map(toCommandCompletionItem);
				const filtered = fuzzyFilter(items, prefix, (item) => item.search).map(
					(item) => ({
						value: `${item.command.trigger}${item.command.name}${
							item.command.argumentHint || item.command.arguments ? ":" : ""
						}`,
						label: item.label,
						description: item.description,
					}),
				);
				return filtered.length > 0
					? { items: filtered, prefix: beforeCursor }
					: null;
			}

			if (
				argumentStart !== undefined &&
				command.arguments?.complete &&
				!options.signal.aborted
			) {
				let candidates: CommandCandidates;
				try {
					candidates = await command.arguments.complete({
						agentId: this.agentId,
						command,
						argumentPrefix,
						orchestrator: this.orchestrator,
					});
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
					prefix: beforeCursor.slice(argumentStart),
				};
			}
			return null;
		}

		const inline = this.matchInlineCommand(beforeCursor);
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
		const filtered = fuzzyFilter(
			inline.commands.map(toCommandCompletionItem),
			inline.prefix,
			(item) => item.search,
		).map((item) => ({
			value: `${item.command.trigger}${item.command.name}:${
				item.command.closeTrigger ?? ""
			}`,
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
		const isCommandCompletion = this.commands.some((command) =>
			prefix.startsWith(command.trigger),
		);
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
		const closeTrigger = this.commands.find(
			(command) =>
				command.placement === "inline" &&
				value.startsWith(`${command.trigger}${command.name}:`),
		)?.closeTrigger;
		const closeOffset = closeTrigger ? closeTrigger.length : 0;
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

	private matchLineCommand(text: string):
		| {
				command?: Command;
				argumentPrefix: string;
				argumentStart?: number;
		  }
		| undefined {
		const commands = this.commands.filter(
			(command) => command.placement === "line",
		);
		const trigger = commands
			.map((command) => command.trigger)
			.sort((left, right) => right.length - left.length)
			.find((candidate) => text.startsWith(candidate));
		if (!trigger) return undefined;
		const body = text.slice(trigger.length);
		const separator = body.indexOf(":");
		if (separator === -1) {
			const exact = commands.find(
				(command) => command.trigger === trigger && command.name === body,
			);
			return { command: exact, argumentPrefix: "" };
		}
		const name = body.slice(0, separator);
		const command = commands.find(
			(entry) => entry.trigger === trigger && entry.name === name,
		);
		return {
			command,
			argumentPrefix: body.slice(separator + 1),
			argumentStart: trigger.length + separator + 1,
		};
	}

	private matchInlineCommand(text: string):
		| {
				commands: Command[];
				prefix: string;
				rawPrefix: string;
		  }
		| undefined {
		const boundary = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"));
		const rawPrefix = text.slice(boundary + 1);
		const commands = this.commands.filter(
			(command) =>
				command.placement === "inline" && rawPrefix.startsWith(command.trigger),
		);
		if (commands.length === 0) return undefined;
		const trigger = commands[0]?.trigger ?? "";
		if (rawPrefix.includes(":")) return undefined;
		return {
			commands,
			prefix: rawPrefix.slice(trigger.length),
			rawPrefix,
		};
	}
}

function toCommandCompletionItem(command: Command): CommandCompletionItem {
	const source =
		command.source.kind === "extension"
			? `extension:${command.source.extensionId}`
			: "built-in";
	const availability =
		command.available === false
			? `unavailable: ${command.unavailableReason ?? "not available"}`
			: source;
	return {
		command,
		search: command.name,
		label: `${command.trigger}${command.name}`,
		description: [command.argumentHint, command.description, availability]
			.filter(Boolean)
			.join(" — "),
	};
}
