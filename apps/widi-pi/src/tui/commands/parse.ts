export const LINE_COMMAND_TRIGGER = "/";
export const INLINE_COMMAND_TRIGGER = "<";
export const INLINE_COMMAND_CLOSE_TRIGGER = ">";

export interface ParsedLineCommand {
	readonly name: string;
	readonly argument: string;
	/** false for `/name`, true for `/name:`, `/name:arg` and `/name arg`. */
	readonly hasArgument: boolean;
}

export interface InlineCommandMatch {
	readonly name: string;
	readonly argument: string;
	readonly start: number;
	readonly end: number;
}

export function parseLineCommand(text: string): ParsedLineCommand | undefined {
	const input = text.trimEnd();
	if (!input.startsWith(LINE_COMMAND_TRIGGER)) return undefined;
	const body = input.slice(LINE_COMMAND_TRIGGER.length);
	if (!body) return undefined;
	// The separator is the first ":" or the first whitespace, whichever comes
	// first. Colon syntax keeps the argument verbatim; space syntax skips the
	// separating whitespace itself.
	const colonIndex = body.indexOf(":");
	const whitespaceIndex = /\s/u.exec(body)?.index ?? -1;
	let separatorIndex = -1;
	let colonSyntax = false;
	if (
		colonIndex !== -1 &&
		(whitespaceIndex === -1 || colonIndex < whitespaceIndex)
	) {
		separatorIndex = colonIndex;
		colonSyntax = true;
	} else {
		separatorIndex = whitespaceIndex;
	}
	const rawName = separatorIndex === -1 ? body : body.slice(0, separatorIndex);
	if (!isCommandName(rawName)) return undefined;
	const rawArgument =
		separatorIndex === -1 ? "" : body.slice(separatorIndex + 1);
	return {
		name: rawName,
		hasArgument: separatorIndex !== -1,
		argument: colonSyntax ? rawArgument : rawArgument.replace(/^\s+/u, ""),
	};
}

export function isCommandName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name);
}

// Inline command tokens sit on whitespace or text boundaries; the argument
// runs from ":" to the close trigger. Tokens naming no known command are
// plain text.
export function scanInlineCommands(
	text: string,
	names: readonly string[],
): InlineCommandMatch[] {
	if (names.length === 0) return [];
	const matches: InlineCommandMatch[] = [];
	let index = 0;
	while (index < text.length) {
		if (index > 0 && !isWhitespace(text[index - 1] ?? "")) {
			index += 1;
			continue;
		}
		const match = matchInlineCommandAt(text, index, names);
		if (match) {
			matches.push(match);
			index = match.end;
			continue;
		}
		index += 1;
	}
	return matches;
}

function matchInlineCommandAt(
	text: string,
	start: number,
	names: readonly string[],
): InlineCommandMatch | undefined {
	for (const name of names) {
		const head = `${INLINE_COMMAND_TRIGGER}${name}`;
		if (!text.startsWith(head, start)) continue;
		const cursor = start + head.length;
		if (text.startsWith(INLINE_COMMAND_CLOSE_TRIGGER, cursor)) {
			const end = cursor + INLINE_COMMAND_CLOSE_TRIGGER.length;
			if (!isInlineBoundary(text, end)) continue;
			return { name, argument: "", start, end };
		}
		if (text[cursor] !== ":") continue;
		const closeIndex = text.indexOf(INLINE_COMMAND_CLOSE_TRIGGER, cursor + 1);
		if (closeIndex === -1) continue;
		const end = closeIndex + INLINE_COMMAND_CLOSE_TRIGGER.length;
		if (!isInlineBoundary(text, end)) continue;
		return { name, argument: text.slice(cursor + 1, closeIndex), start, end };
	}
	return undefined;
}

function isInlineBoundary(text: string, index: number): boolean {
	return index >= text.length || isWhitespace(text[index] ?? "");
}

function isWhitespace(char: string): boolean {
	return /\s/u.test(char);
}
