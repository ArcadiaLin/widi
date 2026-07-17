import type { EditorTheme, SelectListTheme } from "@earendil-works/pi-tui";
import { colors } from "./colors.ts";

export const selectListTheme: SelectListTheme = {
	selectedPrefix: colors.accent,
	selectedText: colors.bold,
	description: colors.gray,
	scrollInfo: colors.dim,
	noMatch: colors.dim,
};

export const editorTheme: EditorTheme = {
	borderColor: colors.gray,
	selectList: selectListTheme,
};
