/**
 * Locating the viewer's built assets.
 *
 * The viewer is bundled ahead of time into `dist/viewer/`, and the generator
 * inlines what it finds there. Two candidate locations are tried because the
 * generator itself runs from two places: from `dist/` once built, and from
 * `src/` under tsx during development. Both reach the same built viewer, so
 * `npm run build:viewer` is the only prerequisite either way.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface ViewerAssets {
	readonly script: string;
	readonly style: string;
}

const CANDIDATE_ROOTS = ["../viewer/", "../../dist/viewer/"];

async function readFirst(fileName: string): Promise<string> {
	const attempted: string[] = [];
	for (const root of CANDIDATE_ROOTS) {
		const path = fileURLToPath(new URL(`${root}${fileName}`, import.meta.url));
		attempted.push(path);
		try {
			return await readFile(path, "utf8");
		} catch {}
	}
	throw new Error(
		`Viewer asset ${fileName} is missing. Run "npm --workspace apps/widi-trajectory run build:viewer" first.\nLooked in:\n  ${attempted.join("\n  ")}`,
	);
}

export async function loadViewerAssets(): Promise<ViewerAssets> {
	const [script, style] = await Promise.all([readFirst("bundle.js"), readFirst("bundle.css")]);
	return { script, style };
}
