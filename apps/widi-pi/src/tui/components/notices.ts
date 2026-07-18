import { type Component, Text } from "@earendil-works/pi-tui";
import { singleLine } from "../format.ts";
import type { TuiApplicationState } from "../state.ts";
import { colors, severityColor } from "../theme/colors.ts";
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
				return colors.dim(singleLine(notice.text, 400));
			}
			const attribution = [
				notice.agentId && `agent:${notice.agentId}`,
				notice.extensionId && `extension:${notice.extensionId}`,
			]
				.filter(Boolean)
				.join(" · ");
			if (notice.diagnostic) {
				const color = severityColor(notice.diagnostic.severity);
				return color(
					`${diagnosticGlyph(notice.diagnostic)} ${notice.diagnostic.code}: ${singleLine(notice.text)}`,
				);
			}
			return colors.info(
				`✱${attribution ? ` ${attribution}` : ""} ${singleLine(notice.text)}`,
			);
		});
		return new Text(lines.join("\n"), 1, 0).render(width);
	}
}
