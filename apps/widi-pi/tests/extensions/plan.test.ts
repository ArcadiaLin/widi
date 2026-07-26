import { describe, expect, it } from "vitest";
import { createUpdatePlanToolDefinition } from "../../../../.widi/extensions/plan-demo/lib.ts";
import {
	BackgroundJobOutput,
	type BackgroundJobReport,
} from "../../src/core/background-job.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";

function makeContext(
	output?: BackgroundJobOutput,
	signal?: AbortSignal,
	reports?: BackgroundJobReport[],
): ToolExecutionContext<undefined> {
	return {
		signal,
		onUpdate: undefined,
		extension: undefined,
		human: undefined,
		job: output
			? {
					id: "job-1",
					output,
					setReport: (report) => {
						reports?.push(report);
						return true;
					},
				}
			: undefined,
	};
}

const sampleItems = [
	{ title: "survey the codebase", status: "done" },
	{ title: "draft the plan", status: "in_progress" },
	{ title: "implement", status: "pending" },
] as const;

describe("update_plan tool definition", () => {
	it("always runs as a background job with the plan title as label", () => {
		const definition = createUpdatePlanToolDefinition();
		expect(definition.backgroundable).toBe(true);
		expect(definition.backgroundTimeoutMs).toBe(0);
		expect(
			definition.backgroundDescription?.({
				title: "ship the panel",
				items: [],
			}),
		).toBe("plan: ship the panel");
	});

	it("streams the header and one glyph line per item, then settles with a summary", async () => {
		const definition = createUpdatePlanToolDefinition();
		const output = new BackgroundJobOutput();
		const reports: BackgroundJobReport[] = [];
		const result = await definition.execute(
			"call-1",
			{ title: "demo", items: [...sampleItems], stepMs: 0 },
			makeContext(output, undefined, reports),
		);
		expect(output.read()).toBe(
			"Plan: demo\n" +
				"✓ survey the codebase\n" +
				"● draft the plan\n" +
				"○ implement\n",
		);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Plan 'demo' published: 1 done, 1 in progress, 1 pending.",
			},
		]);
		expect(reports).toHaveLength(4);
		expect(reports[0]).toMatchObject({
			kind: "widi.plan",
			schemaVersion: 1,
			progress: { completed: 0, total: 3 },
			data: { title: "demo", items: [] },
		});
		expect(reports.at(-1)).toMatchObject({
			summary: "Plan: demo",
			progress: { completed: 3, total: 3 },
			data: { title: "demo", items: sampleItems },
		});
	});

	it("settles as failed when fail=true, after streaming the items", async () => {
		const definition = createUpdatePlanToolDefinition();
		const output = new BackgroundJobOutput();
		await expect(
			definition.execute(
				"call-1",
				{ title: "demo", items: [...sampleItems], stepMs: 0, fail: true },
				makeContext(output),
			),
		).rejects.toThrow(/fail=true/);
		expect(output.read()).toContain("○ implement\n");
	});

	it("rejects promptly on an aborted signal", async () => {
		const definition = createUpdatePlanToolDefinition();
		const controller = new AbortController();
		controller.abort();
		await expect(
			definition.execute(
				"call-1",
				{ title: "demo", items: [...sampleItems], stepMs: 0 },
				makeContext(new BackgroundJobOutput(), controller.signal),
			),
		).rejects.toThrow(/aborted/);
	});

	it("tolerates a missing job output (plain synchronous context)", async () => {
		const definition = createUpdatePlanToolDefinition();
		const result = await definition.execute(
			"call-1",
			{ title: "demo", items: [...sampleItems], stepMs: 0 },
			makeContext(),
		);
		expect(result.content[0]?.type).toBe("text");
	});
});
