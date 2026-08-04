/**
 * The branch as the register of what a persistence namespace holds.
 *
 * `core:jobs` is the only namespace wired to it today, so these read as job
 * tests, but what is asserted is the wiring: the ref reaches the branch, the
 * branch is what a later runtime believes, and the ref survives the two moments
 * where the harness is about to stop accepting writes.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import { JOBS_NAMESPACE } from "../../src/core/background/index.ts";
import { PERSISTENCE_REF_CUSTOM_TYPE, type PersistenceRefData } from "../../src/core/persistence/index.ts";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import { startBackgroundedJob } from "../helpers/background-jobs.ts";
import {
	createOrchestrator,
	MemoryExecutionEnv,
	requireAgentHarness,
	requireAgentJobs,
} from "../helpers/orchestrator.ts";

/** Every persistence ref entry on the agent's current branch, oldest first. */
async function branchRefs(
	orchestrator: AgentOrchestrator,
	agentId: string,
): Promise<{ readonly id: string; readonly data: PersistenceRefData }[]> {
	const snapshot = await orchestrator.getAgentSession(agentId);
	return snapshot.pathToRoot
		.filter((entry) => entry.type === "custom" && entry.customType === PERSISTENCE_REF_CUSTOM_TYPE)
		.map((entry) => ({ id: entry.id, data: (entry as { data: PersistenceRefData }).data }));
}

/** The text of every user message on the agent's current branch. */
async function branchUserText(orchestrator: AgentOrchestrator, agentId: string): Promise<string> {
	const snapshot = await orchestrator.getAgentSession(agentId);
	return snapshot.pathToRoot
		.flatMap((entry) => (entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : []))
		.map((content) =>
			typeof content === "string"
				? content
				: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" "),
		)
		.join("\n");
}

/** The session path of a live agent, for resuming it from another runtime. */
async function sessionPath(orchestrator: AgentOrchestrator, agentId: string): Promise<string> {
	const { metadata } = await orchestrator.getAgentSession(agentId);
	if (!("path" in metadata)) throw new Error(`Agent ${agentId} has no persisted session.`);
	return metadata.path;
}

describe("branch state", () => {
	it("records a backgrounded job on the branch and names the namespace that changed", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const events: OrchestratorEvent[] = [];
		orchestrator.subscribe((event) => {
			events.push(event);
		});
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });

		startBackgroundedJob(requireAgentJobs(orchestrator, agentId), { toolCallId: "call-1", toolName: "sleeper" });

		await vi.waitFor(async () => expect(await branchRefs(orchestrator, agentId)).toHaveLength(1));
		const [ref] = await branchRefs(orchestrator, agentId);
		expect(ref?.data).toMatchObject({ namespace: JOBS_NAMESPACE, stateRoot: expect.any(String) });
		// The event is published from the write's own session_write, so its entry id
		// is the real one rather than the undefined the buffered append returned.
		expect(events.filter((event) => event.type === "agent_persistence_ref_changed")).toMatchObject([
			{ agentId, namespace: JOBS_NAMESPACE, stateRoot: ref?.data.stateRoot, entryId: ref?.id },
		]);
	});

	it("closes a job the previous runtime left open, on the branch and not just in the message", async () => {
		const env = new MemoryExecutionEnv();
		const first = await createOrchestrator(env);
		const agentId = await first.spawnAgent({ origin: { kind: "new" } });
		startBackgroundedJob(requireAgentJobs(first, agentId), { toolCallId: "call-1", toolName: "sleeper" });
		await vi.waitFor(async () => expect(await branchRefs(first, agentId)).toHaveLength(1));
		const path = await sessionPath(first, agentId);

		// A second runtime over the same files: the process died, the session did not.
		const second = await createOrchestrator(env);
		const resumed = await second.spawnAgent({ origin: { kind: "resume", reference: path } });

		expect(second.agentBackgroundJobHistory(resumed)).toMatchObject([
			{ toolCallId: "call-1", state: "closed", cause: "resume" },
		]);
		// A third runtime believes the branch, not this process: the job is over.
		const third = await createOrchestrator(env);
		const again = await third.spawnAgent({ origin: { kind: "resume", reference: path } });
		expect(third.agentBackgroundJobHistory(again)).toMatchObject([{ toolCallId: "call-1", state: "closed" }]);
	});

	// Navigating back to a point where a job was still running does not un-run it.
	// The result exists; it is just recorded on the branch that was left behind.
	it("hands a navigated-to branch the job outcome this runtime already has", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent({ origin: { kind: "new" } });
		// The t1 delivery would otherwise drive a real turn; the branch is what is
		// under test, not what the model does about it.
		vi.spyOn(requireAgentHarness(orchestrator, agentId), "prompt").mockResolvedValue({} as AssistantMessage);
		const { execution } = startBackgroundedJob(requireAgentJobs(orchestrator, agentId), {
			toolCallId: "call-1",
			toolName: "sleeper",
		});
		await vi.waitFor(async () => expect(await branchRefs(orchestrator, agentId)).toHaveLength(1));
		const [startedRef] = await branchRefs(orchestrator, agentId);
		execution.settle({
			status: "completed",
			result: { content: [{ type: "text", text: "build done" }], details: undefined },
		});
		await vi.waitFor(async () => expect(await branchRefs(orchestrator, agentId)).toHaveLength(2));

		await orchestrator.navigateAgentTree(agentId, startedRef?.id ?? "");

		// Two refs on the new branch: the start it inherited, and the settlement it
		// was just handed. Reading the reduction alone would prove nothing - that is
		// this process's memory, and the point is what the branch itself now says.
		expect(await branchRefs(orchestrator, agentId)).toHaveLength(2);
		expect(orchestrator.agentBackgroundJobHistory(agentId)).toMatchObject([
			{ toolCallId: "call-1", state: "settled", status: "completed" },
		]);
		await expect(branchUserText(orchestrator, agentId)).resolves.toContain("build done");
	});

	// A t0 tool result is written inside the turn; the ref that records the job is
	// buffered behind it and lands at the save point. A branch can carry the first
	// without the second, and then nothing in the job history knows the promise the
	// model is holding.
	it("answers a t0 handle the branch carries but no job history ever recorded", async () => {
		const env = new MemoryExecutionEnv();
		const first = await createOrchestrator(env);
		const agentId = await first.spawnAgent({ origin: { kind: "new" } });
		await requireAgentHarness(first, agentId).appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "moved to the background as job-1" }],
			details: { jobId: "job-1", toolCallId: "call-1", toolName: "bash", backgrounded: true },
			isError: false,
			timestamp: Date.now(),
		});
		const path = await sessionPath(first, agentId);

		const second = await createOrchestrator(env);
		const resumed = await second.spawnAgent({ origin: { kind: "resume", reference: path } });

		// Nothing is recorded for it: this branch has no start to close, and
		// inventing one would put a job on a branch that never ran it.
		expect(await branchRefs(second, resumed)).toHaveLength(0);
		await expect(branchUserText(second, resumed)).resolves.toContain("job-1");
		await expect(branchUserText(second, resumed)).resolves.toContain("never recorded the job");
	});

	it("gets a disposal's own settlement onto the branch before the harness is torn down", async () => {
		const env = new MemoryExecutionEnv();
		const first = await createOrchestrator(env);
		const agentId = await first.spawnAgent({ origin: { kind: "new" } });
		startBackgroundedJob(requireAgentJobs(first, agentId), { toolCallId: "call-1", toolName: "sleeper" });
		await vi.waitFor(async () => expect(await branchRefs(first, agentId)).toHaveLength(1));
		const path = await sessionPath(first, agentId);

		// Disposal cancels the job, and that cancellation is the executor's own
		// answer: the branch has to carry it, or the next resume re-closes a job
		// this runtime already accounted for.
		await first.disposeAgent(agentId, { intent: "removed" });

		const second = await createOrchestrator(env);
		const resumed = await second.spawnAgent({ origin: { kind: "resume", reference: path } });
		expect(second.agentBackgroundJobHistory(resumed)).toMatchObject([
			{ toolCallId: "call-1", state: "settled", status: "cancelled" },
		]);
	});
});
