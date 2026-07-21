import { convertToLlm } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	BACKGROUND_JOB_RESULT_CUSTOM_TYPE,
	createBackgroundJobResultMessage,
	isBackgroundJobResultDetails,
} from "../../src/core/background-job.ts";

describe("createBackgroundJobResultMessage", () => {
	it("builds a custom message that carries correlation details", () => {
		const message = createBackgroundJobResultMessage({
			jobId: "job-1",
			toolCallId: "call-1",
			toolName: "bash",
			status: "completed",
			resultText: "build succeeded",
			timestamp: 1000,
		});

		expect(message.role).toBe("custom");
		expect(message.customType).toBe(BACKGROUND_JOB_RESULT_CUSTOM_TYPE);
		expect(message.display).toBe(true);
		expect(message.timestamp).toBe(1000);
		expect(message.details).toEqual({
			jobId: "job-1",
			toolCallId: "call-1",
			toolName: "bash",
			status: "completed",
		});
	});

	it("enters model context as a self-describing user message", () => {
		const message = createBackgroundJobResultMessage({
			jobId: "job-1",
			toolCallId: "call-1",
			toolName: "spawn_agent",
			status: "completed",
			resultText: "subagent finished the migration",
		});

		const llmMessages = convertToLlm([message]);
		expect(llmMessages).toHaveLength(1);
		const llmMessage = llmMessages[0];
		expect(llmMessage.role).toBe("user");
		const text = (llmMessage.content as TextContent[])
			.map((part) => part.text)
			.join("");
		expect(text).toContain("job-1");
		expect(text).toContain("call-1");
		expect(text).toContain("spawn_agent");
		expect(text).toContain("subagent finished the migration");
	});

	it("omits the result body when result text is empty", () => {
		const message = createBackgroundJobResultMessage({
			jobId: "job-2",
			toolCallId: "call-2",
			toolName: "bash",
			status: "failed",
			resultText: "   ",
		});

		expect(message.content).toBe(
			"Background job job-2 (started by tool call call-2, tool bash) failed:",
		);
	});
});

describe("isBackgroundJobResultDetails", () => {
	it("accepts well-formed details", () => {
		expect(
			isBackgroundJobResultDetails({
				jobId: "job-1",
				toolCallId: "call-1",
				toolName: "bash",
				status: "cancelled",
			}),
		).toBe(true);
	});

	it("rejects malformed payloads", () => {
		expect(isBackgroundJobResultDetails(null)).toBe(false);
		expect(isBackgroundJobResultDetails({ jobId: "job-1" })).toBe(false);
		expect(
			isBackgroundJobResultDetails({
				jobId: "job-1",
				toolCallId: "call-1",
				toolName: "bash",
				status: "unknown",
			}),
		).toBe(false);
	});
});
