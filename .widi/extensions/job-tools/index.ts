import type {
	ExtensionContext,
	ExtensionDefinition,
} from "../../../apps/widi-pi/src/core/extension/api.ts";

/**
 * Job-tools gating sample: keep the job-control tools (read_job /
 * wait_for_jobs / kill_job) out of the model's active tool set until the agent
 * actually has live background jobs, and retract them once the last job
 * settles.
 *
 * Wiring:
 * - agent_spawned / agent_resumed: initial retraction. The active set defaults
 *   to every profile tool and no job can exist before the first run, so the
 *   job tools start hidden.
 * - agent_background_job_changed: the live count drives activation. The event
 *   carries the absolute liveCount, so a missed event self-heals on the next
 *   change (for example after an extension reload).
 *
 * Caveat: activation races the model's next request by design. The t0 handle
 * text names the job tools unconditionally; if the model calls one before the
 * activation lands it gets an unknown-tool error once and retries. Retraction
 * after the last settlement is likewise eventually consistent - a stale job
 * tool call just reports "not tracked".
 */

const JOB_TOOLS = ["read_job", "wait_for_jobs", "kill_job"];

async function syncJobTools(
	context: ExtensionContext,
	liveCount: number,
): Promise<void> {
	const { toolNames, activeToolNames } = context.actions.getTools();
	const available = JOB_TOOLS.filter((name) => toolNames.includes(name));
	if (available.length === 0) return;
	const active = new Set(activeToolNames);
	if (liveCount > 0) {
		const missing = available.filter((name) => !active.has(name));
		if (missing.length === 0) return;
		await context.actions.setActiveTools([...activeToolNames, ...missing]);
		return;
	}
	if (!available.some((name) => active.has(name))) return;
	await context.actions.setActiveTools(
		activeToolNames.filter((name) => !JOB_TOOLS.includes(name)),
	);
}

const extension: ExtensionDefinition = {
	apiVersion: 1,
	activate: (api) => {
		// Last-seen live background job count for this agent.
		let liveCount = 0;
		api.observe("agent_spawned", async (_event, context) => {
			await syncJobTools(context, liveCount);
		});
		api.observe("agent_resumed", async (_event, context) => {
			await syncJobTools(context, liveCount);
		});
		api.observe("agent_background_job_changed", async (event, context) => {
			liveCount = event.liveCount;
			await syncJobTools(context, liveCount);
		});
	},
};

export default extension;
