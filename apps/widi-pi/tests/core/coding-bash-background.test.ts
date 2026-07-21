import { describe, expect, it } from "vitest";
import {
	type BackgroundJobSettlement,
	BackgroundJobTable,
} from "../../src/core/background-job.ts";
import {
	createAgentToolFromResolvedTool,
	ToolRegistry,
} from "../../src/core/tool-registry.ts";
import { createBashToolDefinition } from "../../src/core/tools/coding/bash.ts";
import type { ToolSource } from "../../src/core/tools/types.ts";

const coreSource: ToolSource = { kind: "core", id: "builtin" };

function resolveBashTool(table: BackgroundJobTable) {
	const registry = new ToolRegistry();
	registry.defineTool(createBashToolDefinition(process.cwd()), coreSource);
	const resolved = registry.resolve().getTool("bash");
	if (!resolved) throw new Error("bash tool did not resolve");
	return createAgentToolFromResolvedTool(resolved, {
		backgroundJobTable: table,
	});
}

describe("bash background integration", () => {
	it("returns a job handle immediately and delivers the real output later", async () => {
		const table = new BackgroundJobTable();
		const settled = new Promise<BackgroundJobSettlement>((resolve) => {
			table.onResult(resolve);
		});
		const bash = resolveBashTool(table);

		const t0 = await bash.execute(
			"call-1",
			{ command: "sleep 0.2 && echo hi", background: true },
			undefined,
			undefined,
		);

		// t0 is the handle, not the command output: the command is still running.
		expect(t0.details).toMatchObject({ toolName: "bash", backgrounded: true });
		expect(table.list()).toHaveLength(1);

		const settlement = await settled;
		expect(settlement.outcome.status).toBe("completed");
		const text = settlement.outcome.result?.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("");
		expect(text?.trim()).toBe("hi");
		expect(table.list()).toEqual([]);
	});

	it("runs inline when background is not requested", async () => {
		const table = new BackgroundJobTable();
		const bash = resolveBashTool(table);

		const result = await bash.execute(
			"call-1",
			{ command: "echo inline" },
			undefined,
			undefined,
		);

		const text = result.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("");
		expect(text.trim()).toBe("inline");
		// No job was ever registered for a synchronous call.
		expect(table.list()).toEqual([]);
	});
});
