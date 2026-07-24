import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { BackgroundJobReport } from "../../core/background-job.ts";
import { singleLine } from "../format.ts";
import type { BackgroundJobViewState, TuiApplicationState } from "../state.ts";
import { colors } from "../theme/colors.ts";
import { activeAgent } from "./common.ts";

const MAX_COLLAPSED_JOBS = 3;

type JobReportRenderer = (report: BackgroundJobReport) => string[];

const REPORT_RENDERERS = new Map<string, JobReportRenderer>([
	["widi.plan@1", renderPlanReport],
]);

/**
 * Background jobs of the active agent, shown above the editor. The panel is
 * a pure projection of the per-job view state maintained by the projector
 * (lifecycle events, progress increments, seeding pulls); it renders nothing
 * while the agent has no jobs.
 */
export class JobsPanelView implements Component {
	private readonly state: TuiApplicationState;
	private expanded = false;

	constructor(state: TuiApplicationState) {
		this.state = state;
	}

	toggleExpanded(): void {
		this.expanded = !this.expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agent = activeAgent(this.state);
		if (!agent || agent.backgroundJobs.size === 0) return [];
		const jobs = orderedJobs(agent.backgroundJobs);
		const lines = [colors.rule("─".repeat(width)), colors.accent("  Jobs")];
		const visible = this.expanded ? jobs : jobs.slice(0, MAX_COLLAPSED_JOBS);
		for (const job of visible) {
			lines.push(renderJob(job));
			const reportLines = renderJobReport(job);
			if (reportLines.length > 0) {
				lines.push(...reportLines);
			} else if (isLive(job) && job.lastLine) {
				lines.push(colors.dim(`    ${singleLine(job.lastLine, 200)}`));
			}
		}
		if (jobs.length > visible.length) {
			lines.push(
				colors.dim(
					`  … +${jobs.length - visible.length} more · ctrl+t to expand`,
				),
			);
		}
		if (this.expanded && jobs.length > MAX_COLLAPSED_JOBS) {
			lines.push(colors.dim(`  all ${jobs.length} jobs · ctrl+t to collapse`));
		}
		return lines.map((line) => truncateToWidth(line, width, ""));
	}
}

function isLive(job: BackgroundJobViewState): boolean {
	return job.status === "live" || job.status === "aborting";
}

/** Live jobs first, then the most recently active settled jobs. */
function orderedJobs(
	jobs: ReadonlyMap<string, BackgroundJobViewState>,
): BackgroundJobViewState[] {
	return [...jobs.values()].sort((left, right) => {
		if (isLive(left) !== isLive(right)) return isLive(left) ? -1 : 1;
		return (
			(right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt)
		);
	});
}

function renderJob(job: BackgroundJobViewState): string {
	const description = singleLine(job.description ?? job.toolName, 120);
	return `  ${jobGlyph(job)} ${description} ${colors.dim(`· ${elapsedText(job)} · ${bytesText(job.totalBytesSeen)}`)}`;
}

function renderJobReport(job: BackgroundJobViewState): string[] {
	const report = job.report?.value;
	if (!report) return [];
	const renderer = REPORT_RENDERERS.get(
		`${report.kind}@${report.schemaVersion}`,
	);
	const rendered = renderer?.(report);
	if (rendered && rendered.length > 0) return rendered;
	const headline = reportHeadline(report);
	return [
		colors.dim(
			`    ${singleLine(headline || `${report.kind} v${report.schemaVersion}`, 200)}`,
		),
	];
}

function renderPlanReport(report: BackgroundJobReport): string[] {
	const data = readPlanReportData(report.data);
	const headline =
		reportHeadline(report) ?? (data ? `Plan: ${data.title}` : undefined);
	if (!data) {
		return headline ? [colors.dim(`    ${singleLine(headline, 200)}`)] : [];
	}
	const lines = headline
		? [colors.dim(`    ${singleLine(headline, 200)}`)]
		: [];
	for (const item of data.items) {
		lines.push(
			`    ${planItemGlyph(item.status)} ${singleLine(item.title, 180)}`,
		);
	}
	return lines;
}

function reportHeadline(report: BackgroundJobReport): string | undefined {
	const parts: string[] = [];
	if (report.summary) parts.push(report.summary);
	if (report.progress) {
		parts.push(
			report.progress.total === undefined
				? `${report.progress.completed}`
				: `${report.progress.completed}/${report.progress.total}`,
		);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

type PlanItemStatus = "pending" | "in_progress" | "done";

function readPlanReportData(value: unknown):
	| {
			title: string;
			items: Array<{ title: string; status: PlanItemStatus }>;
	  }
	| undefined {
	if (!isRecord(value) || typeof value.title !== "string") return undefined;
	if (!Array.isArray(value.items)) return undefined;
	const items: Array<{ title: string; status: PlanItemStatus }> = [];
	for (const item of value.items) {
		if (
			!isRecord(item) ||
			typeof item.title !== "string" ||
			!isPlanItemStatus(item.status)
		) {
			return undefined;
		}
		items.push({ title: item.title, status: item.status });
	}
	return { title: value.title, items };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanItemStatus(value: unknown): value is PlanItemStatus {
	return value === "pending" || value === "in_progress" || value === "done";
}

function planItemGlyph(status: PlanItemStatus): string {
	switch (status) {
		case "pending":
			return colors.muted("○");
		case "in_progress":
			return colors.info("●");
		case "done":
			return colors.ok("✓");
	}
}

function jobGlyph(job: BackgroundJobViewState): string {
	switch (job.status) {
		case "live":
			return colors.info("●");
		case "aborting":
			return colors.warn("◌");
		case "completed":
			return colors.ok("✓");
		case "failed":
			return colors.error("✕");
		case "cancelled":
			return colors.muted("⊘");
	}
}

function elapsedText(job: BackgroundJobViewState): string {
	const seconds = Math.max(
		0,
		Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1_000),
	);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function bytesText(bytes: number): string {
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
	return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
