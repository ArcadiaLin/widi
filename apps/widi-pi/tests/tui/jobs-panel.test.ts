// NOTE: This file was reconstructed from the current jobs-panel.ts source
// after the original test was accidentally deleted; its assertions may differ
// from the lost version. Extend freely.
import { describe, expect, it } from "vitest";
import type { BackgroundJobReport } from "../../src/core/background-job.ts";
import { JobsPanelView } from "../../src/tui/components/jobs-panel.ts";
import {
	type BackgroundJobViewState,
	createTuiApplicationState,
	setActiveAgent,
} from "../../src/tui/state.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function job(
	overrides: Partial<BackgroundJobViewState> &
		Pick<BackgroundJobViewState, "jobId">,
): BackgroundJobViewState {
	return {
		toolName: "bash",
		status: "live",
		startedAt: 0,
		totalBytesSeen: 0,
		...overrides,
	};
}

function report(value: BackgroundJobReport): BackgroundJobViewState["report"] {
	return { revision: 1, updatedAt: 0, value };
}

function setup(jobs: BackgroundJobViewState[]) {
	const state = createTuiApplicationState();
	const agent = setActiveAgent(state, "main");
	for (const entry of jobs) agent.backgroundJobs.set(entry.jobId, entry);
	return { state, panel: new JobsPanelView(state) };
}

function plain(panel: JobsPanelView, width = 80): string {
	return panel.render(width).join("\n").replace(ANSI_SEQUENCE, "");
}

describe("JobsPanelView", () => {
	it("renders nothing when the active agent has no jobs", () => {
		const { panel } = setup([]);
		expect(panel.render(80)).toEqual([]);
	});

	it("renders a live job with its description and byte count", () => {
		const { panel } = setup([
			job({
				jobId: "job-1",
				description: "run the suite",
				totalBytesSeen: 1_536,
			}),
		]);
		const rendered = plain(panel);
		expect(rendered).toContain("Jobs");
		expect(rendered).toContain("run the suite");
		expect(rendered).toContain("1.5 KB");
	});

	it("shows the last output line for a live job without a report", () => {
		const { panel } = setup([
			job({ jobId: "job-1", lastLine: "compiling module 3" }),
		]);
		expect(plain(panel)).toContain("compiling module 3");
	});

	it("collapses beyond three jobs and expands on toggle", () => {
		const { panel } = setup([
			job({ jobId: "job-1", description: "one", startedAt: 5 }),
			job({ jobId: "job-2", description: "two", startedAt: 4 }),
			job({ jobId: "job-3", description: "three", startedAt: 3 }),
			job({ jobId: "job-4", description: "four", startedAt: 2 }),
		]);
		const collapsed = plain(panel);
		expect(collapsed).toContain("+1 more");
		expect(collapsed).not.toContain("four");

		panel.toggleExpanded();
		const expanded = plain(panel);
		expect(expanded).toContain("four");
		expect(expanded).toContain("all 4 jobs");
	});

	it("renders a plan report as a titled checklist", () => {
		const { panel } = setup([
			job({
				jobId: "job-1",
				description: "planning",
				report: report({
					kind: "widi.plan",
					schemaVersion: 1,
					data: {
						title: "Ship it",
						items: [
							{ title: "design", status: "done" },
							{ title: "build", status: "in_progress" },
							{ title: "test", status: "pending" },
						],
					},
				}),
			}),
		]);
		const rendered = plain(panel);
		expect(rendered).toContain("Plan: Ship it");
		expect(rendered).toContain("design");
		expect(rendered).toContain("build");
		expect(rendered).toContain("test");
		expect(rendered).toContain("✓");
	});
});
