const ESC = "\u001b[";

function ansi(open: number, close = 39): (text: string) => string {
	return (text) => `${ESC}${open}m${text}${ESC}${close}m`;
}

function decoration(open: number, close: number): (text: string) => string {
	return (text) => `${ESC}${open}m${text}${ESC}${close}m`;
}

function foreground256(color: number): (text: string) => string {
	return (text) => `${ESC}38;5;${color}m${text}${ESC}39m`;
}

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
	accent: foreground256(214),
};

export function severityColor(
	severity: "info" | "warning" | "error",
): (text: string) => string {
	switch (severity) {
		case "error":
			return colors.red;
		case "warning":
			return colors.yellow;
		default:
			return colors.cyan;
	}
}
