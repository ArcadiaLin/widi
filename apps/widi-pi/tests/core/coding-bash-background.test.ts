import { describe, expect, it, vi } from "vitest";
import {
	type BackgroundJobSettlement,
	BackgroundJobTable,
} from "../../src/core/background-job.ts";
import {
	createAgentHarnessToolFromResolvedTool,
	ToolRegistry,
} from "../../src/core/tool-registry.ts";
import { createBashToolDefinition } from "../../src/core/tools/coding/bash.ts";
import type { ToolSource } from "../../src/core/tools/types.ts";

const coreSource: ToolSource = { kind: "core", id: "builtin" };

function resolveBashTool() {
	const registry = new ToolRegistry();
	registry.defineTool(createBashToolDefinition(process.cwd()), coreSource);
	const resolved = registry.resolve().getTool("bash");
	if (!resolved) throw new Error("bash tool did not resolve");
	return createAgentHarnessToolFromResolvedTool(resolved);
}

describe("bash background integration", () => {
	it("returns a job handle immediately and delivers the real output later", async () => {
		const table = new BackgroundJobTable();
		const settled = new Promise<BackgroundJobSettlement>((resolve) => {
			table.onChange((change) => {
				if (change.transition === "settled") resolve(change);
			});
		});
		const bash = resolveBashTool();

		const t0 = await bash.execute(
			"call-1",
			{ command: "sleep 0.2 && echo hi", background: true },
			undefined,
			undefined,
			{ backgroundJobTable: table },
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

	it("mirrors live output into the job's rolling tail while backgrounded", async () => {
		const table = new BackgroundJobTable();
		const settled = new Promise<BackgroundJobSettlement>((resolve) => {
			table.onChange((change) => {
				if (change.transition === "settled") resolve(change);
			});
		});
		const bash = resolveBashTool();

		const t0 = await bash.execute(
			"call-1",
			{ command: "echo progress && sleep 0.3", background: true },
			undefined,
			undefined,
			{ backgroundJobTable: table },
		);
		const jobId = (t0.details as { jobId: string }).jobId;

		// The tail is readable through the table while the command still runs.
		await vi.waitFor(() => {
			expect(table.get(jobId)?.output.read()).toContain("progress");
		});

		await settled;
		// Settlement drops the record — and its output — from the table.
		expect(table.get(jobId)).toBeUndefined();
	});

	it("runs inline when background is not requested", async () => {
		const table = new BackgroundJobTable();
		const bash = resolveBashTool();

		const result = await bash.execute(
			"call-1",
			{ command: "echo inline" },
			undefined,
			undefined,
			{ backgroundJobTable: table },
		);

		const text = result.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("");
		expect(text.trim()).toBe("inline");
		// No job was ever registered for a synchronous call.
		expect(table.list()).toEqual([]);
	});
});
