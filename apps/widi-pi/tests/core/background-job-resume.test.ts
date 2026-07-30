import type { JsonlSessionMetadata } from "@widi/agent-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import { BACKGROUND_JOBS_FILE_NAME } from "../../src/core/background/index.ts";
import { sessionDirPath } from "../../src/core/session-repo.ts";
import {
	createOrchestrator,
	MemoryExecutionEnv,
	requireAgentRecord,
} from "../helpers/orchestrator.ts";

/**
 * A background job cannot outlive the runtime that owns it, but the t0 handle
 * the model holds does outlive it: it is written into the session. These tests
 * pin the recovery that follows from that asymmetry - every handle a previous
 * run left open is closed exactly once on resume.
 */

/** Start a runtime, background one job, and return the session it left behind. */
async function runWithBackgroundedJob(env: MemoryExecutionEnv): Promise<{
	metadata: JsonlSessionMetadata;
	jobId: string;
	jobsLogPath: string;
}> {
	const orchestrator = await createOrchestrator(env);
	const agentId = await orchestrator.spawnAgent();
	const record = requireAgentRecord(orchestrator, agentId);
	const job = record.backgroundJobTable.create({
		toolCallId: "call-dev-server",
		toolName: "bash",
		description: "npm run dev",
	});
	expect(record.backgroundJobTable.background(job.id)).toBe(true);
	const metadata = record.sessionMetadata as JsonlSessionMetadata;
	const jobsLogPath = `${sessionDirPath(metadata.path)}/jobs/${BACKGROUND_JOBS_FILE_NAME}`;
	// The t0 record is written off the lifecycle listener, not awaited by it.
	await vi.waitFor(() => expect(env.files.has(jobsLogPath)).toBe(true));
	return { metadata, jobId: job.id, jobsLogPath };
}

function userMessageTexts(entries: readonly unknown[]): string[] {
	const texts: string[] = [];
	for (const entry of entries as Array<{
		type?: string;
		message?: {
			role?: string;
			content?: Array<{ type: string; text?: string }>;
		};
	}>) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		for (const part of entry.message.content ?? []) {
			if (part.type === "text" && part.text !== undefined)
				texts.push(part.text);
		}
	}
	return texts;
}

async function resumedUserMessages(
	orchestrator: AgentOrchestrator,
	metadata: JsonlSessionMetadata,
): Promise<string[]> {
	const { agentId } = await orchestrator.resumeAgentSessionByReference(
		metadata.path,
	);
	const snapshot =
		await orchestrator.sessionManager.getAgentSessionSnapshot(agentId);
	return userMessageTexts(snapshot.pathToRoot);
}

describe("background jobs across a restart", () => {
	it("closes a job the previous runtime never settled", async () => {
		const env = new MemoryExecutionEnv();
		const { metadata, jobId } = await runWithBackgroundedJob(env);

		const texts = await resumedUserMessages(
			await createOrchestrator(env),
			metadata,
		);

		const closing = texts.filter((text) => text.includes(jobId));
		expect(closing).toHaveLength(1);
		expect(closing[0]).toContain("call-dev-server");
		expect(closing[0]).toContain("cancelled");
		expect(closing[0]).toContain("did not survive the restart");
	});

	// The session, not the job log, is the record of what the model was told, so
	// a resume that is itself interrupted must not double up on the next one.
	it("does not close the same job twice across repeated resumes", async () => {
		const env = new MemoryExecutionEnv();
		const { metadata, jobId } = await runWithBackgroundedJob(env);

		await resumedUserMessages(await createOrchestrator(env), metadata);
		const texts = await resumedUserMessages(
			await createOrchestrator(env),
			metadata,
		);

		expect(texts.filter((text) => text.includes(jobId))).toHaveLength(1);
	});

	// The narrow window the persist-before-deliver ordering exists for: the
	// outcome was recorded, then the runtime died before the model could read it.
	it("delivers a recorded outcome the previous runtime never handed over", async () => {
		const env = new MemoryExecutionEnv();
		const { metadata, jobId, jobsLogPath } = await runWithBackgroundedJob(env);
		const recorded = env.files.get(jobsLogPath) ?? "";
		const epoch = JSON.parse(recorded.split("\n")[0]).epoch as string;
		env.files.set(
			jobsLogPath,
			`${recorded}${JSON.stringify({
				type: "settled",
				epoch,
				jobId,
				status: "completed",
				endedAt: 1700,
				messageText: `Background job ${jobId} (started by tool call call-dev-server, tool bash) completed:\n\nserver listening on 3000`,
			})}\n`,
		);

		const texts = await resumedUserMessages(
			await createOrchestrator(env),
			metadata,
		);

		const closing = texts.filter((text) => text.includes(jobId));
		expect(closing).toHaveLength(1);
		expect(closing[0]).toContain("server listening on 3000");
		expect(closing[0]).not.toContain("did not survive the restart");
	});

	it("leaves a session with no carried-over jobs untouched", async () => {
		const env = new MemoryExecutionEnv();
		const orchestrator = await createOrchestrator(env);
		const agentId = await orchestrator.spawnAgent();
		const metadata = requireAgentRecord(orchestrator, agentId)
			.sessionMetadata as JsonlSessionMetadata;

		const texts = await resumedUserMessages(
			await createOrchestrator(env),
			metadata,
		);

		expect(texts).toEqual([]);
	});
});
