/**
 * System prompt composition.
 *
 * The role's own text comes from its profile body; everything else in the
 * prompt is a runtime fact the profile author cannot write down - the active
 * tools, the agent's id, the project's own instructions, the working
 * directory. This module is where those facts get their wording.
 */

import type { AgentHarnessResources } from "@earendil-works/pi-agent-core";
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import { CORE_AGENT_TOOL_NAMES } from "./agent-host.ts";
import type { AgentId } from "./types.ts";

/**
 * Prompt guidance carried by an active tool. Resolved harness tools match this
 * shape; tools without registry prompt metadata contribute nothing.
 */
export interface ToolPromptGuidance {
	name: string;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
}

/** A project instruction file (AGENTS.md and friends) inlined into the prompt. */
export interface ProjectContextFile {
	readonly path: string;
	readonly content: string;
}

export interface BuildAgentSystemPromptOptions {
	/** The profile body: what the agent is told it is. */
	readonly basePrompt: string;
	readonly resources: AgentHarnessResources;
	readonly activeTools: readonly ToolPromptGuidance[];
	readonly agentId?: AgentId;
	/** Extra sections, already ordered by their source. */
	readonly appendSections?: readonly string[];
	readonly contextFiles?: readonly ProjectContextFile[];
	/**
	 * Whether to list the agent's skills. Omit to let the active tools decide,
	 * which is the default the roles that say nothing get.
	 */
	readonly includeSkills?: boolean;
	/** Omit to leave the working directory out of the prompt. */
	readonly cwd?: string;
}

/**
 * Compose the tool guidance section from the active tools' promptSnippet and
 * promptGuidelines. Snippets keep the active tool order; guidelines are
 * deduplicated by exact text so shared guidance appears once. Returns an
 * empty string when no active tool contributes guidance.
 */
export function formatToolGuidanceForSystemPrompt(
	activeTools: readonly ToolPromptGuidance[],
): string {
	const snippetLines: string[] = [];
	const guidelineLines: string[] = [];
	const seenGuidelines = new Set<string>();
	for (const tool of activeTools) {
		const snippet = tool.promptSnippet?.trim();
		if (snippet) {
			snippetLines.push(`- ${tool.name}: ${snippet}`);
		}
		for (const guideline of tool.promptGuidelines ?? []) {
			const normalized = guideline.trim();
			if (!normalized || seenGuidelines.has(normalized)) continue;
			seenGuidelines.add(normalized);
			guidelineLines.push(`- ${normalized}`);
		}
	}

	const parts: string[] = [];
	if (snippetLines.length > 0) {
		parts.push(`Available tools:\n${snippetLines.join("\n")}`);
	}
	if (guidelineLines.length > 0) {
		parts.push(`Tool guidelines:\n${guidelineLines.join("\n")}`);
	}
	return parts.join("\n\n");
}

/**
 * Inline the project's own instruction files. The wording and the wrapper
 * tags follow pi so a prompt built here reads the same to a model that has
 * seen the other harness. Returns an empty string when there are no files.
 */
export function formatProjectContextForSystemPrompt(
	contextFiles: readonly ProjectContextFile[],
): string {
	if (contextFiles.length === 0) return "";
	const lines = [
		"<project_context>",
		"",
		"Project-specific instructions and guidelines:",
		"",
	];
	for (const { path, content } of contextFiles) {
		lines.push(`<project_instructions path="${path}">`);
		lines.push(content);
		lines.push("</project_instructions>");
		lines.push("");
	}
	lines.push("</project_context>");
	return lines.join("\n");
}

/**
 * Compose the harness system prompt from the profile prompt plus the runtime
 * facts around it: the active tools' prompt guidance, appended sections, the
 * project's instruction files, a model-visible skills listing (agentskills.io
 * block via pi-agent-core), and the working directory.
 *
 * The skills listing is how the model discovers skills on its own; it tells
 * the model to read the skill file, so by default it is only appended when a
 * read tool is active. A role that states `includeSkills` decides for itself -
 * it may read files through a tool this module does not know by name, or want
 * the listing out of a prompt that would otherwise get one. Explicit invocation
 * stays available either way through `/skill`, which inlines the body instead
 * of pointing at it.
 *
 * The agent's own id is appended on the same principle: it is a per-agent
 * value a static prompt snippet cannot carry, and it only means anything to an
 * agent that can address other agents, so it follows the active collaboration
 * tools.
 */
export function buildAgentSystemPrompt(
	options: BuildAgentSystemPromptOptions,
): string {
	const {
		basePrompt,
		resources,
		activeTools,
		agentId,
		appendSections,
		contextFiles,
		includeSkills,
		cwd,
	} = options;

	const sections = [basePrompt];
	if (
		agentId !== undefined &&
		activeTools.some((tool) => CORE_AGENT_TOOL_NAMES.includes(tool.name))
	) {
		sections.push(
			`You are agent ${agentId}. Other agents address you by that id.`,
		);
	}
	const toolGuidance = formatToolGuidanceForSystemPrompt(activeTools);
	if (toolGuidance !== "") {
		sections.push(toolGuidance);
	}
	for (const section of appendSections ?? []) {
		const normalized = section.trim();
		if (normalized !== "") {
			sections.push(normalized);
		}
	}
	const projectContext = formatProjectContextForSystemPrompt(
		contextFiles ?? [],
	);
	if (projectContext !== "") {
		sections.push(projectContext);
	}
	const listSkills =
		includeSkills ?? activeTools.some((tool) => tool.name === "read");
	if (listSkills) {
		const skillsSection = formatSkillsForSystemPrompt(resources.skills ?? []);
		if (skillsSection !== "") {
			sections.push(skillsSection);
		}
	}
	if (cwd !== undefined) {
		// Addressed paths are platform-shaped; the prompt states one form.
		sections.push(`Current working directory: ${cwd.replace(/\\/g, "/")}`);
	}
	return sections.join("\n\n");
}
