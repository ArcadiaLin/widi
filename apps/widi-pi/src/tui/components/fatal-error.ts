import {
	type Component,
	SelectList,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { boundedText, singleLine } from "../format.ts";
import { colors } from "../theme/colors.ts";
import { selectListTheme } from "../theme/controls.ts";

/**
 * Modal view for the only two overlay-worthy failures: startup without any
 * usable agent and an uncaught fatal application error. Quit exits; View
 * diagnostics closes the overlay to read the diagnostics view beneath it.
 */
export class FatalErrorView implements Component {
	focused = false;
	private readonly code: string;
	private readonly message: string;
	private readonly list: SelectList;

	constructor(options: {
		readonly code: string;
		readonly message: string;
		readonly onQuit: () => void;
		readonly onViewDiagnostics: () => void;
	}) {
		this.code = singleLine(options.code, 120);
		this.message = boundedText(options.message, {
			maxLines: 8,
			maxCharacters: 1_000,
		});
		this.list = new SelectList(
			[
				{ value: "quit", label: "Quit" },
				{ value: "diagnostics", label: "View diagnostics" },
			],
			2,
			selectListTheme,
		);
		this.list.onSelect = (item) => {
			if (item.value === "quit") options.onQuit();
			else options.onViewDiagnostics();
		};
		this.list.onCancel = options.onViewDiagnostics;
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		const title = truncateToWidth(
			" ✕ WIDI cannot continue ",
			Math.max(1, width - 4),
			"",
		);
		const top = `┌─${colors.error(title)}${"─".repeat(
			Math.max(0, width - visibleWidth(title) - 3),
		)}┐`;
		const lines = [top];
		const add = (line = "") => {
			const clipped = truncateToWidth(line, innerWidth, "");
			lines.push(
				`│ ${clipped}${" ".repeat(
					Math.max(0, innerWidth - visibleWidth(clipped)),
				)} │`,
			);
		};
		add(colors.dim(this.code));
		for (const line of this.message.split("\n")) add(line);
		add();
		for (const line of this.list.render(innerWidth)) add(line);
		lines.push(`└${"─".repeat(Math.max(0, width - 2))}┘`);
		return lines;
	}
}
