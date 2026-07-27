import { type Component, Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalText, singleLine } from "../format.ts";
import type { TuiApplicationState } from "../state.ts";
import { theme } from "../theme/theme.ts";
import { diagnosticGlyph } from "./common.ts";

export class NoticeView implements Component {
	private readonly state: TuiApplicationState;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const startup = this.state.globalNotices.filter(
			(notice) => notice.kind === "startup",
		);
		const transient = this.state.globalNotices
			.filter((notice) => notice.kind !== "startup")
			.slice(-4);
		const notices = [...startup, ...transient];
		if (notices.length === 0) return [];
		const lines = notices.map((notice) => {
			if (notice.kind === "startup") {
				return theme.dim(singleLine(notice.text, 400));
			}
			const attribution = [
				notice.agentId && `agent:${notice.agentId}`,
				notice.extensionId && `extension:${notice.extensionId}`,
			]
				.filter(Boolean)
				.join(" · ");
			if (notice.diagnostic) {
				const color = theme.severityPaint(notice.diagnostic.severity);
				return color(
					`${diagnosticGlyph(notice.diagnostic)} ${notice.diagnostic.code}: ${singleLine(notice.text)}`,
				);
			}
			const text =
				notice.textMode === "full"
					? sanitizeTerminalText(notice.text)
					: singleLine(notice.text);
			return theme.info(`✱${attribution ? ` ${attribution}` : ""} ${text}`);
		});
		return new Text(lines.join("\n"), 1, 0).render(width);
	}
}
