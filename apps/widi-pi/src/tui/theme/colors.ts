const ESC = "\u001b[";

function ansi(open: number, close = 39): (text: string) => string {
	return (text) => `${ESC}${open}m${text}${ESC}${close}m`;
}

function decoration(open: number, close: number): (text: string) => string {
	return (text) => `${ESC}${open}m${text}${ESC}${close}m`;
}

function foregroundRgb(hex: string): (text: string) => string {
	const value = Number.parseInt(hex.slice(1), 16);
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;
	return (text) => `${ESC}38;2;${red};${green};${blue}m${text}${ESC}39m`;
}

/**
 * Design palette from the extension presentation overview: semantic hues for
 * outcome (ok/warn/error), activity (info), emphasis (accent), and de-emphasis
 * (muted/faint/rule). Components pick by meaning, not by raw terminal color.
 */
export const colors = {
	reset: (text: string) => `${ESC}0m${text}${ESC}0m`,
	bold: decoration(1, 22),
	dim: decoration(2, 22),
	italic: decoration(3, 23),
	underline: decoration(4, 24),
	inverse: decoration(7, 27),
	strikethrough: decoration(9, 29),
	red: ansi(31),
	green: ansi(32),
	yellow: ansi(33),
	blue: ansi(34),
	magenta: ansi(35),
	cyan: ansi(36),
	white: ansi(37),
	gray: ansi(90),
	accent: foregroundRgb("#e4ad6c"),
	ok: foregroundRgb("#83c092"),
	warn: foregroundRgb("#dbbc7f"),
	error: foregroundRgb("#e67e80"),
	info: foregroundRgb("#7fbbb3"),
	muted: foregroundRgb("#9ba3af"),
	faint: foregroundRgb("#747c89"),
	rule: foregroundRgb("#454c57"),
};

export function severityColor(
	severity: "info" | "warning" | "error",
): (text: string) => string {
	switch (severity) {
		case "error":
			return colors.error;
		case "warning":
			return colors.warn;
		default:
			return colors.info;
	}
}
