import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { colors } from "./colors.ts";

export const markdownTheme: MarkdownTheme = {
	heading: (text) => colors.bold(colors.accent(text)),
	link: colors.info,
	linkUrl: colors.dim,
	code: colors.warn,
	codeBlock: colors.ok,
	codeBlockBorder: colors.rule,
	quote: colors.italic,
	quoteBorder: colors.dim,
	hr: colors.dim,
	listBullet: colors.accent,
	bold: colors.bold,
	italic: colors.italic,
	strikethrough: colors.strikethrough,
	underline: colors.underline,
};
