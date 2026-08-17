/**
 * The generated page.
 *
 * One file, no network. A trajectory is something you send to someone or open
 * six months later, and either use fails the moment the page needs a server, a
 * CDN or a sibling directory. So the data, the stylesheet and the viewer are
 * all inlined, and the only cost is that images have a budget.
 *
 * The payload rides in an `application/json` script rather than in a JavaScript
 * literal: no parse of session text as code, and one escape - `<` - is enough
 * to keep the closing tag out of it.
 */

import type { TrajectoryBundle } from "../model/types.ts";
import type { ViewerAssets } from "./assets.ts";

export const DATA_ELEMENT_ID = "widi-trajectory-data";

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** `<` only ever occurs inside a JSON string, so escaping it keeps valid JSON. */
function embedJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

function titleOf(bundle: TrajectoryBundle): string {
	const root = bundle.agents[0];
	if (root === undefined) return "WIDI trajectory";
	return `${root.name ?? root.agentId} · trajectory`;
}

export function renderHtml(bundle: TrajectoryBundle, assets: ViewerAssets): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="widi-trajectory">
<title>${escapeHtml(titleOf(bundle))}</title>
<style>
${assets.style}
</style>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="${DATA_ELEMENT_ID}">${embedJson(bundle)}</script>
<script>
${assets.script}
</script>
</body>
</html>
`;
}
