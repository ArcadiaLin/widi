import { Markdown, Text } from "@earendil-works/pi-tui";
import { boundedText, formatUnknown, singleLine } from "../format.ts";
import type { TimelineItem } from "../state.ts";
import { colors, severityColor } from "../theme/colors.ts";
import { markdownTheme } from "../theme/markdown.ts";
import { presentToolExecution } from "../tool-presenter.ts";
import { diagnosticGlyph } from "./common.ts";

export interface TimelineRenderContext {
	readonly liveThinkingIds: ReadonlySet<string>;
	readonly toolOutputExpanded: boolean;
}

/**
 * The render-relevant facts of a timeline item. ChatView caches rendered
 * lines per item and only re-renders when these change, so this list must
 * cover every input renderTimelineItem reads.
 */
export function renderDeps(
	item: TimelineItem,
	context: TimelineRenderContext,
): readonly unknown[] {
	switch (item.type) {
		case "user-message":
			return [item.text];
		case "assistant-message":
			return [
				item.text,
				item.streaming,
				context.liveThinkingIds.has(`${item.id}:thinking`),
			];
		case "tool-execution":
			return [
				item.status,
				item.isError,
				item.toolName,
				item.args,
				item.partialResult,
				item.result,
				context.toolOutputExpanded,
			];
		case "thinking-status":
			return [item.status];
		case "command-result":
			return [item.status, item.result, item.error];
		case "human-request-trace":
			return [context.toolOutputExpanded];
		default:
			return [];
	}
}

export function renderTimelineItem(
	item: TimelineItem,
	width: number,
	context: TimelineRenderContext,
): string[] {
	switch (item.type) {
		case "user-message":
			return new Text(
				`${colors.bold("❯")} ${boundedText(item.text)}`,
				1,
				0,
			).render(width);
		case "assistant-message": {
			const text = item.text.trim();
			if (!text) {
				// A live thinking-status item already shows the indicator; render
				// nothing here so "Thinking…" never appears twice.
				if (
					item.streaming &&
					!context.liveThinkingIds.has(`${item.id}:thinking`)
				) {
					return new Text(colors.dim("✻ Thinking…"), 1, 0).render(width);
				}
				return [];
			}
			return new Markdown(
				boundedText(text, { maxLines: 200, maxCharacters: 30_000 }),
				1,
				0,
				markdownTheme,
			).render(width);
		}
		case "thinking-status":
			return item.status === "thinking"
				? new Text(colors.dim("✻ Thinking…"), 1, 0).render(width)
				: [];
		case "tool-execution":
			return new Text(
				presentToolExecution(item, Math.max(8, width - 2), {
					expanded: context.toolOutputExpanded,
				}).join("\n"),
				1,
				0,
			).render(width);
		case "diagnostic": {
			const color = severityColor(item.diagnostic.severity);
			return new Text(
				`${color(
					`${diagnosticGlyph(item.diagnostic)} ${item.diagnostic.code}`,
				)}\n${boundedText(item.diagnostic.message)}`,
				1,
				0,
			).render(width);
		}
		case "command-result":
			if (item.status === "running") {
				return new Text(colors.dim(`/${item.name} …`), 1, 0).render(width);
			}
			if (item.status === "failed") {
				return new Text(
					`${colors.dim(`/${item.name}`)} ${severityColor("error")(
						item.error?.message ?? "command failed",
					)}`,
					1,
					0,
				).render(width);
			}
			if (item.result === undefined) return [];
			return new Text(
				`${colors.dim(`/${item.name}`)}\n${formatUnknown(item.result)}`,
				1,
				0,
			).render(width);
		case "extension-output":
			return new Text(
				`${colors.dim(`[${item.extensionId}]`)} ${boundedText(item.text, {
					maxLines: 16,
					maxCharacters: 4_000,
				})}`,
				1,
				0,
			).render(width);
		case "extension-message": {
			const title = item.message.title
				? colors.accent(singleLine(item.message.title, 400))
				: colors.dim(`[${item.extensionId}]`);
			const meta = colors.dim(
				`persistent · ${item.extensionId} · ${item.message.kind}`,
			);
			return new Text(
				`${title}  ${meta}\n\n${boundedText(item.message.content, {
					maxLines: 24,
					maxCharacters: 8_000,
				})}`,
				1,
				0,
			).render(width);
		}
		case "human-request-trace": {
			const answer =
				item.answer.kind === "confirm"
					? item.answer.confirmed
						? "Yes"
						: "No"
					: item.answer.kind === "selected-option"
						? item.answer.value
						: "Answered";
			// input/custom/free-input answers never expand: only options the
			// request itself offered may appear in the transcript.
			const options =
				item.answer.kind === "confirm"
					? ["Yes", "No"]
					: item.answer.kind === "selected-option"
						? (item.options ?? [])
						: [];
			if (context.toolOutputExpanded && options.length > 0) {
				const lines = [colors.dim(`❯ ${singleLine(item.title, 400)}`)];
				for (const option of options) {
					lines.push(
						option === answer
							? `  ${colors.accent("▸")} ${singleLine(option, 400)}`
							: colors.dim(`    ${singleLine(option, 400)}`),
					);
				}
				return new Text(lines.join("\n"), 1, 0).render(width);
			}
			return new Text(
				colors.dim(`❯ ${singleLine(item.title, 400)} → `) +
					singleLine(answer, 400),
				1,
				0,
			).render(width);
		}
		case "application-notice":
			return new Text(
				colors.dim(
					`✱ ${boundedText(item.text, { maxLines: 4, maxCharacters: 600 })}`,
				),
				1,
				0,
			).render(width);
		case "session-marker":
			return new Text(
				colors.dim(
					`── ${item.marker === "compaction" ? "Compacted session" : "Branch summary"} ──\n${boundedText(
						item.summary,
						{
							maxLines: 12,
							maxCharacters: 3_000,
						},
					)}`,
				),
				1,
				0,
			).render(width);
	}
}
