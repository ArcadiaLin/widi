import { Markdown, Text } from "@earendil-works/pi-tui";
import { boundedText, formatUnknown, singleLine } from "../format.ts";
import type { TimelineItem } from "../state.ts";
import { theme } from "../theme/theme.ts";
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
		case "window-marker":
			return [item.hiddenTurns];
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
				`${theme.bold("❯")} ${boundedText(item.text)}`,
				1,
				0,
			).render(width);
		case "assistant-message": {
			const text = item.text.trim();
			// A failed run (stopReason "error", e.g. provider timeout after a
			// model switch) often carries no text at all; without this the
			// failure is completely invisible in the transcript.
			const errorMessage =
				item.message?.stopReason === "error"
					? item.message.errorMessage
					: undefined;
			if (!text) {
				if (errorMessage) {
					return new Text(
						`${theme.error("✕")} ${theme.error(singleLine(errorMessage, 400))}`,
						1,
						0,
					).render(width);
				}
				// A live thinking-status item already shows the indicator; render
				// nothing here so "Thinking…" never appears twice.
				if (
					item.streaming &&
					!context.liveThinkingIds.has(`${item.id}:thinking`)
				) {
					return new Text(theme.dim("✻ Thinking…"), 1, 0).render(width);
				}
				return [];
			}
			const lines = new Markdown(
				boundedText(text, { maxLines: 200, maxCharacters: 30_000 }),
				1,
				0,
				theme.markdownTheme,
			).render(width);
			if (errorMessage) {
				lines.push(
					...new Text(
						`${theme.error("✕")} ${theme.error(singleLine(errorMessage, 400))}`,
						1,
						0,
					).render(width),
				);
			}
			return lines;
		}
		case "thinking-status":
			return item.status === "thinking"
				? new Text(theme.dim("✻ Thinking…"), 1, 0).render(width)
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
			const color = theme.severityPaint(item.diagnostic.severity);
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
				return new Text(theme.dim(`/${item.name} …`), 1, 0).render(width);
			}
			if (item.status === "failed") {
				return new Text(
					`${theme.dim(`/${item.name}`)} ${theme.severityPaint("error")(
						item.error?.message ?? "command failed",
					)}`,
					1,
					0,
				).render(width);
			}
			if (item.result === undefined) return [];
			return new Text(
				`${theme.dim(`/${item.name}`)}\n${formatUnknown(item.result)}`,
				1,
				0,
			).render(width);
		case "extension-output":
			return new Text(
				`${theme.dim(`[${item.extensionId}]`)} ${boundedText(item.text, {
					maxLines: 16,
					maxCharacters: 4_000,
				})}`,
				1,
				0,
			).render(width);
		case "extension-message": {
			const title = item.message.title
				? theme.title(singleLine(item.message.title, 400))
				: theme.dim(`[${item.extensionId}]`);
			const meta = theme.dim(
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
			if (item.answer.kind === "answered-questions") {
				const { items } = item.answer;
				if (context.toolOutputExpanded) {
					const lines = [theme.dim(`❯ ${singleLine(item.title, 400)}`)];
					for (const entry of items) {
						lines.push(theme.dim(`  ${singleLine(entry.title, 400)}`));
						if (entry.values.length === 0) {
							lines.push(theme.dim("    → (no answer)"));
						} else {
							for (const value of entry.values) {
								lines.push(
									`    ${theme.selection("▸")} ${singleLine(value, 400)}`,
								);
							}
						}
					}
					return new Text(lines.join("\n"), 1, 0).render(width);
				}
				const summary = items
					.map(
						(entry) =>
							`${singleLine(entry.title, 80)}: ${
								entry.values.length > 0 ? entry.values.join(", ") : "(none)"
							}`,
					)
					.join(" · ");
				return new Text(
					theme.dim(`❯ ${singleLine(item.title, 200)} → `) +
						singleLine(summary, 400),
					1,
					0,
				).render(width);
			}
			// The selected labels drive both the inline summary and the ▸ marks
			// in the expanded list; multi-select carries several at once.
			const selected =
				item.answer.kind === "confirm"
					? [item.answer.confirmed ? "Yes" : "No"]
					: item.answer.kind === "selected-option"
						? [item.answer.value]
						: item.answer.kind === "selected-options"
							? item.answer.values
							: [];
			const summary = selected.length > 0 ? selected.join(", ") : "Answered";
			// input/custom/free-input answers never expand: only options the
			// request itself offered may appear in the transcript.
			const options =
				item.answer.kind === "confirm"
					? ["Yes", "No"]
					: item.answer.kind === "selected-option" ||
							item.answer.kind === "selected-options"
						? (item.options ?? [])
						: [];
			if (context.toolOutputExpanded && options.length > 0) {
				const selectedSet = new Set(selected);
				const lines = [theme.dim(`❯ ${singleLine(item.title, 400)}`)];
				for (const option of options) {
					lines.push(
						selectedSet.has(option)
							? `  ${theme.selection("▸")} ${singleLine(option, 400)}`
							: theme.dim(`    ${singleLine(option, 400)}`),
					);
				}
				return new Text(lines.join("\n"), 1, 0).render(width);
			}
			return new Text(
				theme.dim(`❯ ${singleLine(item.title, 400)} → `) +
					singleLine(summary, 400),
				1,
				0,
			).render(width);
		}
		case "application-notice":
			return new Text(
				theme.dim(
					`✱ ${boundedText(item.text, { maxLines: 4, maxCharacters: 600 })}`,
				),
				1,
				0,
			).render(width);
		case "session-marker":
			return new Text(
				theme.dim(
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
		case "window-marker":
			return new Text(
				theme.dim(
					`— earlier turns hidden (${item.hiddenTurns} turns trimmed) —`,
				),
				1,
				0,
			).render(width);
	}
}
