import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createAgentToolsFromResolvedTools,
	ToolRegistry,
} from "../../src/core/tool-registry.ts";
import { registerCoreCodingTools } from "../../src/core/tools/coding/builtin.ts";

/**
 * End-to-end smoke test: the seven core coding tools resolved through the
 * ToolRegistry adapter against a real temporary directory, without any TUI
 * or orchestrator involvement.
 */
describe("core coding tools smoke", () => {
	let cwd: string;
	let tools: Map<string, AgentTool<TSchema, unknown>>;

	function tool(name: string): AgentTool<TSchema, unknown> {
		const found = tools.get(name);
		if (!found) throw new Error(`Expected tool ${name} to resolve.`);
		return found;
	}

	function textOf(result: {
		content: { type: string; text?: string }[];
	}): string {
		const first = result.content[0];
		if (first?.type !== "text" || first.text === undefined) {
			throw new Error("Expected a text content block.");
		}
		return first.text;
	}

	beforeAll(async () => {
		cwd = await mkdtemp(join(tmpdir(), "widi-smoke-"));
		const registry = new ToolRegistry();
		registerCoreCodingTools(registry, cwd);
		const resolved = registry.resolve();
		expect(resolved.diagnostics).toEqual([]);
		tools = new Map(
			createAgentToolsFromResolvedTools(resolved.tools, {}).map((agentTool) => [
				agentTool.name,
				agentTool,
			]),
		);
	});

	afterAll(async () => {
		await rm(cwd, { force: true, recursive: true });
	});

	it("resolves the seven core tools in fixed order when no profile allowlist is set", () => {
		const registry = new ToolRegistry();
		registerCoreCodingTools(registry, cwd);
		const resolved = registry.resolve();
		expect(resolved.toolNames).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
		]);
		// No allowlist means every resolved tool is visible and active.
		expect(resolved.activeToolNames).toEqual(resolved.toolNames);
	});

	it("validates resumed active tool names against the registry without aliases", () => {
		const registry = new ToolRegistry();
		registerCoreCodingTools(registry, cwd);
		const resolved = registry.resolve({
			activeToolNames: ["read", "run_shell", "grep"],
		});
		expect(resolved.activeToolNames).toEqual(["read", "grep"]);
		expect(resolved.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"tool.active_missing",
		]);
	});

	it("runs a write-read-edit-bash-grep-find-ls round trip", async () => {
		await tool("write").execute("call-write", {
			path: "src/app.txt",
			content: "alpha needle one\nbeta line two\n",
		});
		expect(await readFile(join(cwd, "src", "app.txt"), "utf-8")).toBe(
			"alpha needle one\nbeta line two\n",
		);

		const readResult = await tool("read").execute("call-read", {
			path: "src/app.txt",
		});
		expect(textOf(readResult)).toBe("alpha needle one\nbeta line two\n");

		await tool("edit").execute("call-edit", {
			path: "src/app.txt",
			edits: [{ oldText: "beta line two", newText: "gamma line two" }],
		});
		expect(await readFile(join(cwd, "src", "app.txt"), "utf-8")).toBe(
			"alpha needle one\ngamma line two\n",
		);

		const bashResult = await tool("bash").execute("call-bash", {
			command: "wc -l < src/app.txt",
		});
		expect(textOf(bashResult).trim()).toBe("2");

		const grepResult = await tool("grep").execute("call-grep", {
			pattern: "needle",
		});
		expect(textOf(grepResult)).toBe("src/app.txt:1: alpha needle one");

		const findResult = await tool("find").execute("call-find", {
			pattern: "*.txt",
		});
		expect(textOf(findResult)).toBe("src/app.txt");

		const lsResult = await tool("ls").execute("call-ls", {});
		expect(textOf(lsResult)).toBe("src/");
	});
});
