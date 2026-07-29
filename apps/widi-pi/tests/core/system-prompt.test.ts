import { describe, expect, it } from "vitest";
import {
	buildAgentSystemPrompt,
	formatProjectContextForSystemPrompt,
	formatToolGuidanceForSystemPrompt,
} from "../../src/core/system-prompt.ts";

const skill = {
	name: "code-review",
	description: "Review code for issues.",
	content: "BODY",
	filePath: "/skills/code-review/SKILL.md",
};

describe("buildAgentSystemPrompt", () => {
	it("deduplicates guidance and omits the section without contributions", () => {
		expect(
			formatToolGuidanceForSystemPrompt([
				{ name: "a", promptSnippet: "First", promptGuidelines: ["Shared."] },
				{ name: "b", promptGuidelines: ["Shared.", "  ", "Extra."] },
				{ name: "c" },
			]),
		).toBe(
			"Available tools:\n- a: First\n\nTool guidelines:\n- Shared.\n- Extra.",
		);
		expect(formatToolGuidanceForSystemPrompt([{ name: "plain" }])).toBe("");
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				resources: {},
				activeTools: [{ name: "plain" }],
			}),
		).toBe("base prompt");
	});

	it("names the agent only when it can address other agents", () => {
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				resources: {},
				activeTools: [{ name: "read" }],
				agentId: "worker-2",
			}),
		).toBe("base prompt");
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				resources: {},
				activeTools: [{ name: "send_message" }],
				agentId: "worker-2",
			}),
		).toBe(
			"base prompt\n\nYou are agent worker-2. Other agents address you by that id.",
		);
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				resources: {},
				activeTools: [{ name: "send_message" }],
			}),
		).toBe("base prompt");
	});

	it("keeps the base system prompt when skills are absent or model-hidden", () => {
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				resources: {},
				activeTools: [{ name: "read" }],
			}),
		).toBe("base prompt");
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				resources: {
					skills: [{ ...skill, disableModelInvocation: true }],
				},
				activeTools: [{ name: "read" }],
			}),
		).toBe("base prompt");
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				resources: { skills: [skill] },
				activeTools: [{ name: "read" }],
			}),
		).toContain("<available_skills>");
	});

	it("lets includeSkills decide the listing over the active tools", () => {
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				resources: { skills: [skill] },
				activeTools: [{ name: "read" }],
				includeSkills: false,
			}),
		).toBe("base prompt");
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				resources: { skills: [skill] },
				activeTools: [{ name: "write" }],
				includeSkills: true,
			}),
		).toContain("<available_skills>");
	});

	it("appends sections in the order given and drops blank ones", () => {
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				resources: {},
				activeTools: [],
				appendSections: ["  from profile  ", "   ", "from extension", ""],
			}),
		).toBe("base prompt\n\nfrom profile\n\nfrom extension");
	});

	it("places appended sections between the tool guidance and the skills listing", () => {
		const prompt = buildAgentSystemPrompt({
			basePrompt: "base prompt",
			resources: { skills: [skill] },
			activeTools: [{ name: "read", promptSnippet: "Read file contents" }],
			appendSections: ["APPENDED"],
			contextFiles: [{ path: "/repo/AGENTS.md", content: "RULES" }],
			cwd: "/repo",
		});
		const order = [
			"base prompt",
			"Available tools:",
			"APPENDED",
			"<project_context>",
			"<available_skills>",
			"Current working directory: /repo",
		].map((marker) => prompt.indexOf(marker));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it("inlines project context files in the pi wrapper format", () => {
		expect(
			formatProjectContextForSystemPrompt([
				{ path: "/repo/AGENTS.md", content: "ROOT RULES" },
				{ path: "/repo/app/AGENTS.md", content: "APP RULES" },
			]),
		).toBe(
			[
				"<project_context>",
				"",
				"Project-specific instructions and guidelines:",
				"",
				'<project_instructions path="/repo/AGENTS.md">',
				"ROOT RULES",
				"</project_instructions>",
				"",
				'<project_instructions path="/repo/app/AGENTS.md">',
				"APP RULES",
				"</project_instructions>",
				"",
				"</project_context>",
			].join("\n"),
		);
		expect(formatProjectContextForSystemPrompt([])).toBe("");
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				resources: {},
				activeTools: [],
				contextFiles: [],
			}),
		).toBe("base prompt");
	});

	it("states the working directory only when one is given, in one path shape", () => {
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				resources: {},
				activeTools: [],
			}),
		).toBe("base prompt");
		expect(
			buildAgentSystemPrompt({
				basePrompt: "base prompt",
				resources: {},
				activeTools: [],
				cwd: "C:\\repo\\app",
			}),
		).toBe("base prompt\n\nCurrent working directory: C:/repo/app");
	});
});
