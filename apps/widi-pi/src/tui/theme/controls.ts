import type { EditorTheme, SelectListTheme } from "@earendil-works/pi-tui";
import { colors } from "./colors.ts";

export const selectListTheme: SelectListTheme = {
	selectedPrefix: colors.accent,
	selectedText: colors.bold,
	description: colors.muted,
	scrollInfo: colors.faint,
	noMatch: colors.faint,
};

export const editorTheme: EditorTheme = {
	borderColor: colors.rule,
	selectList: selectListTheme,
};
