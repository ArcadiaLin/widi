import { Type, type Static } from "typebox";
import type {
	BackgroundJobReport,
	ExtensionActivationApi,
	ToolDefinition,
} from "../../../apps/widi-pi/src/core/extension/api.ts";

/**
 * Plan demo extension: an `update_plan` tool rendered through background-job
 * semantics instead of a dedicated UI channel.
 *
 * The tool is `backgroundable` with a zero deadline, so every call moves to a
 * background job essentially immediately and shows up in the Jobs panel above
 * the editor. The call publishes a replace-only report through `job.setReport`
 * as each plan item becomes visible and independently appends a text trace to
 * `job.output`.
 * This exercises structured current state and raw streaming output; settlement
 * (ok or fail=true) exercises terminal glyphs and retention.
 *
 * This exists primarily to demo and smoke-test the Jobs panel. A real plan
 * feature would keep the same shape: register a backgroundable tool, describe
 * it with `backgroundDescription`, publish structured reports, and reserve
 * `job.output` for unstructured logs.
 */

const planItemSchema = Type.Object({
	title: Type.String({ description: "Plan item title." }),
	status: Type.Union(
		[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done")],
		{ description: "Current state of the item." },
	),
});

const updatePlanParams = Type.Object({
	title: Type.String({
		description: "Short plan title; becomes the job label in the Jobs panel.",
	}),
	items: Type.Array(planItemSchema, {
		description:
			"The full plan item list. Every call replaces the previous plan, kimi TodoList style.",
	}),
	stepMs: Type.Optional(
		Type.Number({
			description:
				"Pacing between streamed item updates in milliseconds (default 150). Lower values settle faster.",
		}),
	),
	fail: Type.Optional(
		Type.Boolean({
			description:
				"When true, settle the job as failed after streaming, to demo the panel's error state.",
		}),
	),
});

type UpdatePlanParams = Static<typeof updatePlanParams>;

const STATUS_GLYPHS: Record<UpdatePlanParams["items"][number]["status"], string> = {
	pending: "○",
	in_progress: "●",
	done: "✓",
};

const DEFAULT_STEP_MS = 150;

function planReport(
	params: UpdatePlanParams,
	publishedItems: number,
): BackgroundJobReport {
	return {
		kind: "widi.plan",
		schemaVersion: 1,
		summary:
			publishedItems === params.items.length
				? `Plan: ${params.title}`
				: `Publishing plan: ${params.title}`,
		progress: {
			completed: publishedItems,
			total: params.items.length,
		},
		data: {
			title: params.title,
			items: params.items.slice(0, publishedItems).map((item) => ({
				title: item.title,
				status: item.status,
			})),
		},
	};
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("update_plan aborted"));
			return;
		}
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			cleanup();
			reject(new Error("update_plan aborted"));
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function createUpdatePlanToolDefinition(): ToolDefinition<
	typeof updatePlanParams,
	undefined
> {
	return {
		name: "update_plan",
		label: "Plan",
		description:
			"Publish a plan as a background job so it renders live in the Jobs panel above the editor. " +
			"Pass the full item list on every call; items stream into the panel one by one and the job " +
			"settles when all items are published.",
		parameters: updatePlanParams,
		backgroundable: true,
		// Zero deadline: every call becomes a background job, which is the whole
		// point of this tool — the Jobs panel is its display surface.
		backgroundTimeoutMs: 0,
		backgroundDescription: (params) => `plan: ${params.title}`,
		execute: async (_toolCallId, params, context) => {
			const output = context.job?.output;
			const stepMs = params.stepMs ?? DEFAULT_STEP_MS;
			context.job?.setReport(planReport(params, 0));
			output?.append(`Plan: ${params.title}\n`);
			for (const [index, item] of params.items.entries()) {
				await sleep(stepMs, context.signal);
				output?.append(`${STATUS_GLYPHS[item.status]} ${item.title}\n`);
				context.job?.setReport(planReport(params, index + 1));
			}
			if (params.fail) {
				throw new Error("update_plan settling as failed because fail=true was passed");
			}
			const done = params.items.filter((item) => item.status === "done").length;
			const inProgress = params.items.filter(
				(item) => item.status === "in_progress",
			).length;
			const pending = params.items.length - done - inProgress;
			return {
				content: [
					{
						type: "text",
						text: `Plan '${params.title}' published: ${done} done, ${inProgress} in progress, ${pending} pending.`,
					},
				],
				details: undefined,
			};
		},
	};
}

export function activatePlanExtension(api: ExtensionActivationApi): void {
	api.registerTool(createUpdatePlanToolDefinition());
}
