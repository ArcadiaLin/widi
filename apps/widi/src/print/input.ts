/**
 * The prompts, assembled from the three places a non-interactive run gets text.
 *
 * The CLI sorts arguments and stops there; folding them together is here because
 * the rules are about content, not syntax. Files and piped stdin join the
 * *first* prompt rather than becoming prompts of their own: they are context for
 * the instruction, and a file delivered as its own turn would be answered before
 * the instruction that explains it ever arrived.
 *
 * A file is included verbatim under a header naming it. Nothing is inferred from
 * the extension - a file that is not text is refused rather than pasted in as
 * mojibake, and images have their own option because they are their own content
 * type on the wire.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { formatError } from "../utils/errors.ts";

export interface PrintPromptSources {
	readonly cwd: string;
	readonly prompts: readonly string[];
	/** `@path` or `path`; the CLI's marker is stripped either way. */
	readonly fileArgs?: readonly string[];
	/** Piped input, already read. Absent when stdin was a terminal. */
	readonly stdin?: string;
}

export async function resolvePrintPrompts(sources: PrintPromptSources): Promise<readonly string[]> {
	const attachments: string[] = [];
	for (const argument of sources.fileArgs ?? []) {
		const path = argument.startsWith("@") ? argument.slice(1) : argument;
		attachments.push(await readAttachment(sources.cwd, path));
	}
	const piped = sources.stdin?.trim();
	if (piped !== undefined && piped !== "") attachments.push(piped);

	if (attachments.length === 0) return [...sources.prompts];
	const [first, ...rest] = sources.prompts;
	const head = first === undefined ? attachments.join("\n\n") : [first, ...attachments].join("\n\n");
	return [head, ...rest];
}

async function readAttachment(cwd: string, path: string): Promise<string> {
	const absolute = isAbsolute(path) ? path : resolve(cwd, path);
	let content: string;
	try {
		content = await readFile(absolute, "utf8");
	} catch (error) {
		throw new Error(`Cannot read ${absolute}: ${formatError(error)}`);
	}
	// The decoder replaces undecodable bytes rather than failing, so a binary file
	// arrives as plausible-looking text. A NUL is what actually distinguishes it.
	if (content.includes("\u0000")) {
		throw new Error(`${absolute} is not a text file. Pass images through the image option instead.`);
	}
	return `--- ${absolute} ---\n${content}`;
}
