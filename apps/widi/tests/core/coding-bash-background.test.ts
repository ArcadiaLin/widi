import { describe, expect, it, vi } from "vitest";
import type { BackgroundJobChange, BackgroundJobSettlement } from "../../src/core/background/index.ts";
import { createAgentHarnessToolFromResolvedTool, ToolRegistry } from "../../src/core/tool-registry.ts";
import { createBashToolDefinition } from "../../src/core/tools/coding/bash.ts";
import type { ToolSource } from "../../src/core/tools/types.ts";
import { collectJobChanges, createJobRuntimeHarness } from "../helpers/background-jobs.ts";

const coreSource: ToolSource = { kind: "core", id: "builtin" };

function resolveBashTool() {
	const registry = new ToolRegistry();
	registry.defineTool(createBashToolDefinition(process.cwd()), coreSource);
	const resolved = registry.resolve().getTool("bash");
	if (!resolved) throw new Error("bash tool did not resolve");
	return createAgentHarnessToolFromResolvedTool(resolved);
}

/** The next settlement the owner's watcher sees, as a promise. */
function nextSettlement(changes: readonly BackgroundJobChange[]): Promise<BackgroundJobSettlement> {
	return vi.waitFor(() => {
		const settled = changes.find((change) => change.transition === "settled");
		if (!settled || settled.transition !== "settled") throw new Error("No settlement yet.");
		return { job: settled.job, outcome: settled.outcome };
	});
}

describe("bash background integration", () => {
	it("returns a job handle immediately and delivers the real output later", async () => {
		const jobs = await createJobRuntimeHarness();
		const { changes } = collectJobChanges(jobs.host);
		const bash = resolveBashTool();

		const t0 = await bash.execute(
			"call-1",
			{ command: "sleep 0.2 && echo hi", background: true },
			undefined,
			undefined,
			{ jobs: jobs.host },
		);

		// t0 is the handle, not the command output: the command is still running.
		expect(t0.details).toMatchObject({ toolName: "bash", backgrounded: true });
		expect(jobs.host.list()).toHaveLength(1);

		const settlement = await nextSettlement(changes);
		expect(settlement.outcome.status).toBe("completed");
		const text = settlement.outcome.result?.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		expect(text?.trim()).toBe("hi");
		expect(jobs.host.list()).toEqual([]);
	});

	it("carries the caller's name onto the job and its handle", async () => {
		const jobs = await createJobRuntimeHarness();
		const bash = resolveBashTool();

		const t0 = await bash.execute(
			"call-1",
			{ command: "sleep 0.2 && echo hi", background: true, name: "  run   the e2e suite  " },
			undefined,
			undefined,
			{ jobs: jobs.host },
		);

		// Whitespace is collapsed; the command stays as the derived description.
		expect(jobs.host.list()[0]).toMatchObject({ name: "run the e2e suite", description: "sleep 0.2 && echo hi" });
		expect(t0.details).toMatchObject({ name: "run the e2e suite" });
		const handleText = t0.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		expect(handleText).toContain('bash "run the e2e suite"');
		jobs.host.abort(jobs.host.list()[0]?.jobId ?? "", "test cleanup");
	});

	it("mirrors live output into the job's rolling tail while backgrounded", async () => {
		const jobs = await createJobRuntimeHarness();
		const { changes } = collectJobChanges(jobs.host);
		const bash = resolveBashTool();

		const t0 = await bash.execute(
			"call-1",
			{ command: "echo progress && sleep 0.3", background: true },
			undefined,
			undefined,
			{ jobs: jobs.host },
		);
		const jobId = (t0.details as { jobId: string }).jobId;

		// The tail is readable through the host while the command still runs.
		await vi.waitFor(() => {
			const read = jobs.host.read(jobId);
			expect(read.ok && read.read.output).toContain("progress");
		});

		await nextSettlement(changes);
		// Settlement drops the record - and its output - from the live index.
		expect(jobs.host.read(jobId)).toMatchObject({ ok: false });
	});

	it("runs inline when background is not requested", async () => {
		const jobs = await createJobRuntimeHarness();
		const bash = resolveBashTool();

		const result = await bash.execute("call-1", { command: "echo inline" }, undefined, undefined, { jobs: jobs.host });

		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		expect(text.trim()).toBe("inline");
		// Nothing was ever observable for a synchronous call.
		expect(jobs.host.list()).toEqual([]);
	});
});
