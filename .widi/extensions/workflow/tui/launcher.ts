import { type Component, getKeybindings, Input, truncateToWidth } from "@earendil-works/pi-tui";
import type { CommandSelectorRequest } from "../../../../apps/widi/src/tui/commands/types.ts";
import { actionKeyLabel } from "../../../../apps/widi/src/tui/keybindings.ts";
import { ListSelector } from "../../../../apps/widi/src/tui/selectors/list-selector.ts";
import type { Theme } from "../../../../apps/widi/src/tui/theme/theme.ts";
import type { FlowEntry } from "../flow/discover.ts";

/**
 * The `/workflow` picker, in two screens.
 *
 * The host's default selector produces one token and resubmits it, which is one
 * short of what starting a flow takes: a flow needs a name and something to run
 * it on. The dock holds a component rather than a list, so the second screen is
 * this component's own business and the dock never learns there was one - what
 * finally reaches the submit path is still the one string it expects.
 *
 * The screens are also where a flow's price belongs. `/workflows` already
 * prints it, but the moment it decides anything is this one.
 */
export class WorkflowLauncher implements Component {
	private readonly request: CommandSelectorRequest;
	private readonly paint: Theme;
	private readonly entries: readonly FlowEntry[];
	private picker: ListSelector;
	private input = new Input();
	private stage: "pick" | "input" | "refused" = "pick";
	private chosen?: FlowEntry;
	/** What screen two starts with, kept across a trip back to screen one. */
	private draft: string;
	private focus = false;

	constructor(request: CommandSelectorRequest, paint: Theme, entries: readonly FlowEntry[]) {
		this.request = request;
		this.paint = paint;
		this.entries = entries;

		// The query is whatever the person typed after `/workflow`, which the
		// engine could not resolve on its own: `survey`, `surv`, or a name it
		// does not know followed by the input meant for it. Splitting it here
		// keeps typed text alive down every one of those paths.
		const query = request.initialFilter ?? "";
		const separator = query.search(/\s/);
		const head = separator < 0 ? query : query.slice(0, separator);
		this.draft = separator < 0 ? "" : query.slice(separator + 1).trim();
		const named = this.entries.find((entry) => entry.name.toLowerCase() === head.toLowerCase());
		this.picker = this.buildPicker(named ? "" : head);
		if (named) this.enter(named);
	}

	get focused(): boolean {
		return this.focus;
	}

	set focused(value: boolean) {
		this.focus = value;
		this.picker.focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (this.stage === "pick") {
			this.picker.handleInput(data);
			return;
		}
		if (this.stage === "refused") {
			if (keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "tui.select.cancel")) {
				this.back();
			}
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.back();
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.run();
			return;
		}
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.picker.invalidate();
		this.input.invalidate();
	}

	render(width: number): string[] {
		if (this.stage === "pick") return this.picker.render(width);
		const entry = this.chosen;
		if (entry === undefined) return this.picker.render(width);
		return this.stage === "refused" ? this.refusal(width, entry) : this.question(width, entry);
	}

	private buildPicker(filter: string): ListSelector {
		return new ListSelector({
			title: this.request.title,
			items: this.entries.map((entry) => ({
				value: entry.name,
				label: entry.name,
				description: this.summarize(entry),
			})),
			operation: { description: "Pick a flow, then say what to run it on.", confirmVerb: "apply" },
			...(filter === "" ? undefined : { initialFilter: filter }),
			// Screen one closes into screen two, not out of the dock. Only the
			// paths that really leave call the host's onClose.
			onClose: () => undefined,
			onSelect: (item) => {
				const entry = this.entries.find((candidate) => candidate.name === item.value);
				if (entry) this.enter(entry);
			},
			onCancel: () => {
				this.request.onClose();
				this.request.onCancel?.();
			},
		});
	}

	private enter(entry: FlowEntry): void {
		this.chosen = entry;
		if (entry.flow === undefined) {
			this.stage = "refused";
			return;
		}
		this.stage = "input";
		// Typed through handleInput rather than setValue so the cursor lands at
		// the end of the restored draft.
		this.input = new Input();
		if (this.draft !== "") this.input.handleInput(this.draft);
		this.input.focused = this.focus;
	}

	private back(): void {
		// Coming back from a refusal, the name is the one thing not worth
		// filtering by: it would leave the person alone with the flow they were
		// just told they cannot run.
		const filter = this.stage === "input" ? (this.chosen?.name ?? "") : "";
		if (this.stage === "input") this.draft = this.input.getValue();
		this.picker = this.buildPicker(filter);
		this.picker.focused = this.focus;
		this.chosen = undefined;
		this.stage = "pick";
	}

	private run(): void {
		const entry = this.chosen;
		const input = this.input.getValue().trim();
		if (entry === undefined || input === "") return;
		this.request.onClose();
		this.request.onSelect({ value: `${entry.name} ${input}`, label: entry.name });
	}

	private question(width: number, entry: FlowEntry): string[] {
		const lines = [this.paint.title(`${this.request.title} ${entry.name}`), ""];
		if (entry.description) lines.push(this.fit(this.paint.muted(entry.description), width));
		lines.push(this.paint.faint(this.price(entry)), this.fit(this.paint.faint(entry.path), width), "");
		lines.push(...this.input.render(width));
		lines.push("", this.paint.dim(this.keyHints("run", "back")));
		return this.frame(width, lines);
	}

	private refusal(width: number, entry: FlowEntry): string[] {
		const lines = [
			this.paint.title(`${this.request.title} ${entry.name}`),
			"",
			this.paint.error("Refused by the audit; nothing was spawned."),
		];
		for (const problem of entry.problems) {
			lines.push(this.fit(`  ${this.paint.warn(problem)}`, width));
		}
		lines.push(this.fit(this.paint.faint(entry.path), width), "", this.paint.dim(this.backHint()));
		return this.frame(width, lines);
	}

	private frame(width: number, body: readonly string[]): string[] {
		const rule = this.paint.border("─".repeat(Math.max(1, width)));
		// The body is already cut to width; the outer pass only guards the rule
		// and the input line, and must not put an ellipsis in either.
		return [rule, "", ...body, rule].map((line) => truncateToWidth(line, width, ""));
	}

	private fit(line: string, width: number): string {
		return truncateToWidth(line, Math.max(1, width - 1), "…");
	}

	private keyHints(confirm: string, cancel: string): string {
		const confirmKey = actionKeyLabel("tui.select.confirm");
		const cancelKey = actionKeyLabel("tui.select.cancel");
		return [confirmKey && `${confirmKey} ${confirm}`, cancelKey && `${cancelKey} ${cancel}`]
			.filter((part): part is string => Boolean(part))
			.join("  ");
	}

	/** The refusal screen has one way out, and both keys take it. */
	private backHint(): string {
		const keys = [actionKeyLabel("tui.select.confirm"), actionKeyLabel("tui.select.cancel")].filter(
			(key): key is string => key !== undefined,
		);
		return keys.length === 0 ? "" : `${keys.join("/")} back to the catalog`;
	}

	private summarize(entry: FlowEntry): string {
		if (entry.flow === undefined) {
			return this.paint.error(`refused: ${entry.problems[0] ?? "failed its audit"}`);
		}
		return entry.description ? `${entry.description} - ${this.price(entry)}` : this.price(entry);
	}

	private price(entry: FlowEntry): string {
		const worst = `worst case ${entry.cost?.modelCalls ?? 0} model calls, ${entry.cost?.agentSpawns ?? 0} agents`;
		const budget = entry.flow?.budget.wallClockMs;
		return budget === undefined ? worst : `${worst}, ${Math.round(budget / 1000)}s`;
	}
}
