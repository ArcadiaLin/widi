/**
 * Prompt assembly: what `@file` and a pipe do to the text the agent reads.
 *
 * The one rule with consequences is that both join the *first* prompt rather
 * than becoming prompts of their own. A file delivered as its own turn would be
 * answered before the instruction explaining it ever arrived, and multi-prompt
 * runs are exactly where that would go unnoticed.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePrintPrompts } from "../../src/print/input.ts";

let root: string | undefined;

afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

async function createFiles(files: Readonly<Record<string, string | Uint8Array>>): Promise<string> {
	root = await mkdtemp(join(tmpdir(), "widi-print-input-"));
	for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
	return root;
}

describe("resolvePrintPrompts", () => {
	it("passes prompts through untouched when there is nothing to fold in", async () => {
		expect(await resolvePrintPrompts({ cwd: "/", prompts: ["one", "two"] })).toEqual(["one", "two"]);
	});

	it("folds files and piped stdin into the first prompt, in that order", async () => {
		const cwd = await createFiles({ "notes.md": "FILE BODY" });

		const prompts = await resolvePrintPrompts({
			cwd,
			prompts: ["review this", "now summarise"],
			fileArgs: ["@notes.md"],
			stdin: "  PIPED  ",
		});

		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toBe(`review this\n\n--- ${join(cwd, "notes.md")} ---\nFILE BODY\n\nPIPED`);
		expect(prompts[1]).toBe("now summarise");
	});

	it("makes the attachments the whole prompt when no prompt was typed", async () => {
		const cwd = await createFiles({ "task.txt": "DO THE THING" });

		const prompts = await resolvePrintPrompts({ cwd, prompts: [], fileArgs: ["task.txt"] });

		expect(prompts).toEqual([`--- ${join(cwd, "task.txt")} ---\nDO THE THING`]);
	});

	it("ignores stdin that is only whitespace", async () => {
		expect(await resolvePrintPrompts({ cwd: "/", prompts: ["ask"], stdin: "\n \n" })).toEqual(["ask"]);
	});

	it("refuses a file that is not text rather than pasting it in as mojibake", async () => {
		const cwd = await createFiles({ "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) });

		await expect(resolvePrintPrompts({ cwd, prompts: ["look"], fileArgs: ["logo.png"] })).rejects.toThrow(
			/is not a text file/,
		);
	});

	it("says which path it could not read", async () => {
		await expect(resolvePrintPrompts({ cwd: "/nowhere", prompts: ["x"], fileArgs: ["missing.md"] })).rejects.toThrow(
			/Cannot read \/nowhere\/missing\.md/,
		);
	});
});
