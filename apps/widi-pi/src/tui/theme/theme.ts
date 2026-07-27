import type {
	EditorTheme,
	MarkdownTheme,
	SelectListTheme,
} from "@earendil-works/pi-tui";

const ESC = "\u001b[";
const SGR_RESET = `${ESC}0m`;

type Paint = (text: string) => string;

function ansi(open: number, close = 39): Paint {
	return (text) => `${ESC}${open}m${text}${ESC}${close}m`;
}

function decoration(open: number, close: number): Paint {
	return (text) => `${ESC}${open}m${text}${ESC}${close}m`;
}

function foregroundRgb(hex: string): Paint {
	const value = Number.parseInt(hex.slice(1), 16);
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;
	return (text) => `${ESC}38;2;${red};${green};${blue}m${text}${ESC}39m`;
}

function backgroundRgb(hex: string): Paint {
	const value = Number.parseInt(hex.slice(1), 16);
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;
	return (text) => `${ESC}48;2;${red};${green};${blue}m${text}${ESC}49m`;
}

/**
 * Semantic hues of a color scheme, as hex values. Components never pick raw
 * terminal colors; the Theme turns these into paint functions.
 */
export interface ThemePalette {
	/** Emphasis: brand, titles, selection, active frames. */
	accent: string;
	/** Success / positive outcome. */
	ok: string;
	/** Warning. */
	warn: string;
	/** Error / failure. */
	error: string;
	/** Activity in progress, informational. */
	info: string;
	/** De-emphasized text. */
	muted: string;
	/** Barely-there text (scroll info, placeholders). */
	faint: string;
	/** Frames, divider lines, box borders. */
	rule: string;
	/** Row background that lifts a line off the terminal's black. */
	surface: string;
}

/**
 * Default color scheme derived from the IDIW logo (chat_notes/idiw.png): a
 * diagonal blue gradient running from pale cyan #9dcfd3 through #7ab9cd and
 * #4899c3 down to deep blue #0a559e, on white. Accent/info and the
 * de-emphasis grays come straight from that gradient; the outcome hues
 * (ok/warn/error) keep their semantic green/yellow/red since the logo offers
 * none.
 */
export const defaultPalette: ThemePalette = {
	accent: "#4899c3",
	ok: "#83c092",
	warn: "#dbbc7f",
	error: "#e67e80",
	info: "#7ab9cd",
	muted: "#8fa9c0",
	faint: "#5b7186",
	rule: "#2f4d6b",
	surface: "#1e2833",
};

/**
 * Unified color scheme for the TUI. Owns the palette and decides, in one
 * place, which hue paints each visual role: panel frames (`border`), the
 * editor's attention frame (`borderActive`), panel/menu titles (`title`),
 * selection markers and active chips (`selection`), and status hues
 * (`ok`/`warn`/`error`/`info`). Also derives the pi-tui sub-themes
 * (`editorTheme`/`selectListTheme`/`markdownTheme`) so those components pick
 * up the same scheme.
 */
export class Theme {
	readonly palette: ThemePalette;

	// Text decorations (not palette-driven).
	readonly reset: Paint;
	readonly bold: Paint;
	readonly dim: Paint;
	readonly italic: Paint;
	readonly underline: Paint;
	readonly inverse: Paint;
	readonly strikethrough: Paint;

	// Raw ANSI colors for the rare spot that needs one.
	readonly red: Paint;
	readonly green: Paint;
	readonly yellow: Paint;
	readonly blue: Paint;
	readonly magenta: Paint;
	readonly cyan: Paint;
	readonly white: Paint;
	readonly gray: Paint;

	// Status hues from the palette.
	readonly accent: Paint;
	readonly ok: Paint;
	readonly warn: Paint;
	readonly error: Paint;
	readonly info: Paint;
	readonly muted: Paint;
	readonly faint: Paint;

	// Visual roles.
	readonly border: Paint;
	readonly borderActive: Paint;
	readonly title: Paint;
	readonly selection: Paint;
	/** Background of user message rows in the transcript. */
	readonly surface: Paint;

	readonly selectListTheme: SelectListTheme;
	readonly editorTheme: EditorTheme;
	readonly markdownTheme: MarkdownTheme;

	constructor(palette: ThemePalette = defaultPalette) {
		this.palette = palette;

		this.reset = (text) => `${SGR_RESET}${text}${SGR_RESET}`;
		this.bold = decoration(1, 22);
		this.dim = decoration(2, 22);
		this.italic = decoration(3, 23);
		this.underline = decoration(4, 24);
		this.inverse = decoration(7, 27);
		this.strikethrough = decoration(9, 29);

		this.red = ansi(31);
		this.green = ansi(32);
		this.yellow = ansi(33);
		this.blue = ansi(34);
		this.magenta = ansi(35);
		this.cyan = ansi(36);
		this.white = ansi(37);
		this.gray = ansi(90);

		this.accent = foregroundRgb(palette.accent);
		this.ok = foregroundRgb(palette.ok);
		this.warn = foregroundRgb(palette.warn);
		this.error = foregroundRgb(palette.error);
		this.info = foregroundRgb(palette.info);
		this.muted = foregroundRgb(palette.muted);
		this.faint = foregroundRgb(palette.faint);

		this.border = foregroundRgb(palette.rule);
		this.borderActive = this.accent;
		this.title = this.accent;
		this.selection = this.accent;
		this.surface = backgroundRgb(palette.surface);

		this.selectListTheme = {
			selectedPrefix: this.selection,
			selectedText: this.bold,
			description: this.muted,
			scrollInfo: this.faint,
			noMatch: this.faint,
		};
		this.editorTheme = {
			borderColor: this.border,
			selectList: this.selectListTheme,
		};
		this.markdownTheme = {
			heading: (text) => this.bold(this.title(text)),
			link: this.info,
			linkUrl: this.dim,
			code: this.info,
			codeBlock: this.ok,
			codeBlockBorder: this.border,
			quote: this.italic,
			quoteBorder: this.dim,
			hr: this.dim,
			listBullet: this.accent,
			bold: this.bold,
			italic: this.italic,
			strikethrough: this.strikethrough,
			underline: this.underline,
		};
	}

	severityPaint(severity: "warning" | "error"): Paint {
		return severity === "error" ? this.error : this.warn;
	}
}

/** The active color scheme. Components always paint through this singleton. */
export const theme = new Theme();
