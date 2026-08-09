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
	appendCompactionCheckpoint,
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

/**
 * Every text the model reads as input on this branch.
 *
 * Three entry forms carry it: a bare `role:"user"` message (the shell's own
 * input), a `role:"custom"` message (anything that woke the agent on someone
 * else's behalf), and a `custom_message` entry (a `precede` notice, which never
 * woke it at all). All three project into context as user text.
 */
async function branchUserText(orchestrator: AgentOrchestrator, agentId: string): Promise<string> {
	const snapshot = await orchestrator.getAgentSession(agentId);
	const toText = (content: string | readonly { type: string; text?: string }[]): string =>
		typeof content === "string"
			? content
			: content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join(" ");
	return snapshot.pathToRoot
		.flatMap((entry) => {
			if (entry.type === "custom_message") return [toText(entry.content)];
			if (entry.type !== "message") return [];
			const { message } = entry;
			return message.role === "user" || message.role === "custom" ? [toText(message.content)] : [];
		})
		.join("\n");
}

/** The session address of a live agent, for resuming it from another runtime. */
function sessionRef(orchestrator: AgentOrchestrator, agentId: string): string {
	const ref = orchestrator.sessionManager.getAgentSessionRef(agentId);
	if (ref === undefined) throw new Error(`Agent ${agentId} has no persisted session.`);
	return ref;
}

/**
 * Every recap of one kind on the branch, in the ids it recorded.
 *
 * Read from the persisted source rather than through the reader under test: what
 * these assert is that the mark is on the branch in the shape a later run will
 * look for, and reusing the reader would pass whatever shape it happened to write.
 */
async function recapIds(
	orchestrator: AgentOrchestrator,
	agentId: string,
	recap: string,
): Promise<readonly (readonly string[])[]> {
	const snapshot = await orchestrator.getAgentSession(agentId);
	return snapshot.pathToRoot.flatMap((entry) => {
		if (entry.type !== "custom_message") return [];
		const source = (entry.details as { source?: { kind?: string; details?: { recap?: string; ids?: string[] } } })
			?.source;
		if (source?.kind !== "recap" || source.details?.recap !== recap) return [];
		return [source.details.ids ?? []];
	});
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
		const ref = sessionRef(first, agentId);

		// A second runtime over the same files: the process died, the session did not.
		const second = await createOrchestrator(env);
		const resumed = await second.spawnAgent({ origin: { kind: "resume", reference: ref } });

		expect(second.agentBackgroundJobHistory(resumed)).toMatchObject([
			{ toolCallId: "call-1", state: "closed", cause: "resume" },
		]);
		// A third runtime believes the branch, not this process: the job is over.
		const third = await createOrchestrator(env);
		const again = await third.spawnAgent({ origin: { kind: "resume", reference: ref } });
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
		const ref = sessionRef(first, agentId);

		const second = await createOrchestrator(env);
		const resumed = await second.spawnAgent({ origin: { kind: "resume", reference: ref } });

		// Nothing is recorded for it: this branch has no start to close, and
		// inventing one would put a job on a branch that never ran it.
		expect(await branchRefs(second, resumed)).toHaveLength(0);
		await expect(branchUserText(second, resumed)).resolves.toContain("job-1");
		await expect(branchUserText(second, resumed)).resolves.toContain("never recorded the job");

		// With no record to write, the recap is its own record: the handle is still
		// orphaned on this branch and still unknown to the job history, and the only
		// thing that stops a third runtime restating it is the recap already there.
		const third = await createOrchestrator(env);
		const again = await third.spawnAgent({ origin: { kind: "resume", reference: ref } });
		expect(await recapIds(third, again, "orphaned_job_handles")).toEqual([["call-1"]]);
	});

	it("gets a disposal's own settlement onto the branch before the harness is torn down", async () => {
		const env = new MemoryExecutionEnv();
		const first = await createOrchestrator(env);
		const agentId = await first.spawnAgent({ origin: { kind: "new" } });
		startBackgroundedJob(requireAgentJobs(first, agentId), { toolCallId: "call-1", toolName: "sleeper" });
		await vi.waitFor(async () => expect(await branchRefs(first, agentId)).toHaveLength(1));
		const ref = sessionRef(first, agentId);

		// Disposal cancels the job, and that cancellation is the executor's own
		// answer: the branch has to carry it, or the next resume re-closes a job
		// this runtime already accounted for.
		await first.disposeAgent(agentId, { intent: "removed" });

		const second = await createOrchestrator(env);
		const resumed = await second.spawnAgent({ origin: { kind: "resume", reference: ref } });
		expect(second.agentBackgroundJobHistory(resumed)).toMatchObject([
			{ toolCallId: "call-1", state: "settled", status: "cancelled" },
		]);
	});
});

/**
 * What the branch says was already said.
 *
 * A recap corrects a belief only the branch holds, so the branch is both what
 * decides it is owed and what records that it was given. The idempotence half is
 * asserted where the handles are; what is left here is the other input to that
 * judgement - the branch a recap reads is the model's context, not the file.
 */
describe("recaps", () => {
	it("says nothing about a handle compaction has already dropped", async () => {
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
		const keptId = await requireAgentHarness(first, agentId).appendMessage({
			role: "user",
			content: "carry on",
			timestamp: Date.now(),
		});
		if (keptId === undefined) throw new Error("Expected the appended message to land immediately.");
		await appendCompactionCheckpoint(first, agentId, keptId);
		const ref = sessionRef(first, agentId);

		const second = await createOrchestrator(env);
		const resumed = await second.spawnAgent({ origin: { kind: "resume", reference: ref } });

		expect(await recapIds(second, resumed, "orphaned_job_handles")).toEqual([]);
	});
});
