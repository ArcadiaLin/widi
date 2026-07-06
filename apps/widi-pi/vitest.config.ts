import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import codspeedPlugin from "@codspeed/vitest-plugin";
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
		find: "@earendil-works/pi-ai/api/anthropic-messages.lazy",
		replacement: resolve(
			repoRoot,
			"pi/packages/ai/src/api/anthropic-messages.lazy.ts",
		),
	},
	{
		find: "@earendil-works/pi-ai/api/azure-openai-responses.lazy",
		replacement: resolve(
			repoRoot,
			"pi/packages/ai/src/api/azure-openai-responses.lazy.ts",
		),
	},
	{
		find: "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy",
		replacement: resolve(
			repoRoot,
			"pi/packages/ai/src/api/bedrock-converse-stream.lazy.ts",
		),
	},
	{
		find: "@earendil-works/pi-ai/api/google-generative-ai.lazy",
		replacement: resolve(
			repoRoot,
			"pi/packages/ai/src/api/google-generative-ai.lazy.ts",
		),
	},
	{
		find: "@earendil-works/pi-ai/api/google-vertex.lazy",
		replacement: resolve(
			repoRoot,
			"pi/packages/ai/src/api/google-vertex.lazy.ts",
		),
	},
	{
		find: "@earendil-works/pi-ai/api/mistral-conversations.lazy",
		replacement: resolve(
			repoRoot,
			"pi/packages/ai/src/api/mistral-conversations.lazy.ts",
		),
	},
	{
		find: "@earendil-works/pi-ai/api/openai-codex-responses.lazy",
		replacement: resolve(
			repoRoot,
			"pi/packages/ai/src/api/openai-codex-responses.lazy.ts",
		),
	},
	{
		find: "@earendil-works/pi-ai/api/openai-completions.lazy",
		replacement: resolve(
			repoRoot,
			"pi/packages/ai/src/api/openai-completions.lazy.ts",
		),
	},
	{
		find: "@earendil-works/pi-ai/api/openai-responses.lazy",
		replacement: resolve(
			repoRoot,
			"pi/packages/ai/src/api/openai-responses.lazy.ts",
		),
	},
	{
		find: "@earendil-works/pi-ai/providers/all",
		replacement: resolve(repoRoot, "pi/packages/ai/src/providers/all.ts"),
	},
	{
		find: "@earendil-works/pi-ai/compat",
		replacement: resolve(repoRoot, "pi/packages/ai/src/compat.ts"),
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
	plugins: [codspeedPlugin()],
	resolve: {
		alias: sourceAliases,
	},
});
