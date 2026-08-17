/**
 * Message content, projected for reading.
 *
 * Two jobs: turn the on-disk content unions into the viewer's block list, and
 * derive the one-line summary the ledger shows. Text is never truncated in the
 * blocks - the inspector exists to show all of it - so the only budget here is
 * for images, whose base64 payload would otherwise decide the size of the
 * generated page.
 */

import type { RawContent } from "../load/session-file.ts";
import type { ContentBlock } from "./types.ts";

export interface ImageBudget {
	/** Largest single image kept inline, in decoded bytes. */
	readonly maxBytes: number;
	/** Total inline image bytes for the whole bundle. */
	readonly totalBytes: number;
}

export const DEFAULT_IMAGE_BUDGET: ImageBudget = { maxBytes: 2 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 };

/** Spends one shared image allowance across every session in a bundle. */
export class ImageAllowance {
	private readonly _budget: ImageBudget;
	private _spent = 0;
	private _dropped = 0;

	constructor(budget: ImageBudget = DEFAULT_IMAGE_BUDGET) {
		this._budget = budget;
	}

	get dropped(): number {
		return this._dropped;
	}

	/** Whether an image of this encoded size may be inlined. */
	take(encodedLength: number): boolean {
		const bytes = Math.ceil((encodedLength * 3) / 4);
		if (bytes > this._budget.maxBytes || this._spent + bytes > this._budget.totalBytes) {
			this._dropped++;
			return false;
		}
		this._spent += bytes;
		return true;
	}
}

function textOf(content: string | readonly RawContent[] | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			const text = (block as { text?: unknown }).text;
			return block.type === "text" && typeof text === "string" ? text : "";
		})
		.filter((text) => text !== "")
		.join("\n");
}

export function toBlocks(content: string | readonly RawContent[] | undefined, images: ImageAllowance): ContentBlock[] {
	if (content === undefined) return [];
	if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
	const blocks: ContentBlock[] = [];
	for (const block of content) {
		if (block.type === "text") {
			const text = (block as { text?: string }).text ?? "";
			if (text !== "") blocks.push({ type: "text", text });
			continue;
		}
		if (block.type === "thinking") {
			const raw = block as { thinking?: string; redacted?: boolean };
			if (raw.redacted === true) {
				blocks.push({ type: "thinking", text: "[redacted by the provider]" });
				continue;
			}
			if (raw.thinking) blocks.push({ type: "thinking", text: raw.thinking });
			continue;
		}
		if (block.type === "image") {
			const raw = block as { data?: string; mimeType?: string };
			const mimeType = raw.mimeType ?? "image/png";
			if (raw.data && images.take(raw.data.length)) {
				blocks.push({ type: "image", mimeType, data: raw.data });
			} else {
				blocks.push({ type: "image", mimeType, note: "image omitted to keep the page small" });
			}
			continue;
		}
		if (block.type === "toolCall") continue;
		blocks.push({ type: "json", text: stringify(block) });
	}
	return blocks;
}

export function stringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

const CONTROL_CHARS = /\p{Cc}/gu;

/** One line, collapsed and clipped, for a ledger row. */
export function summarize(text: string, limit = 220): string {
	const flat = text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
	if (flat.length <= limit) return flat;
	return `${flat.slice(0, limit - 1)}…`;
}

export function summarizeContent(content: string | readonly RawContent[] | undefined, limit = 220): string {
	return summarize(textOf(content), limit);
}

export function summarizeBlocks(blocks: readonly ContentBlock[], limit = 220): string {
	for (const block of blocks) {
		if (block.type === "text" && block.text.trim() !== "") return summarize(block.text, limit);
	}
	for (const block of blocks) {
		if (block.type === "thinking") return summarize(block.text, limit);
		if (block.type === "json") return summarize(block.text, limit);
		if (block.type === "image") return `[image ${block.mimeType}]`;
	}
	return "";
}
