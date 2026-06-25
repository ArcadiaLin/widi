import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const sourceAliases = [
	{
		find: "@earendil-works/pi-ai/base",
		replacement: resolve(repoRoot, "pi/packages/ai/src/base.ts"),
	},
	{
		find: "@earendil-works/pi-ai/oauth",
		replacement: resolve(repoRoot, "pi/packages/ai/src/oauth.ts"),
	},
	{
		find: "@earendil-works/pi-ai",
		replacement: resolve(repoRoot, "pi/packages/ai/src/index.ts"),
	},
	{
		find: "@earendil-works/pi-agent-core/base",
		replacement: resolve(repoRoot, "pi/packages/agent/src/base.ts"),
	},
	{
		find: "@earendil-works/pi-agent-core/node",
		replacement: resolve(repoRoot, "pi/packages/agent/src/node.ts"),
	},
	{
		find: "@earendil-works/pi-agent-core",
		replacement: resolve(repoRoot, "pi/packages/agent/src/index.ts"),
	},
	{
		find: "@earendil-works/pi-tui",
		replacement: resolve(repoRoot, "pi/packages/tui/src/index.ts"),
	},
];

export default defineConfig({
	resolve: {
		alias: sourceAliases,
	},
});
