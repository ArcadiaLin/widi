import type { Skill } from "@earendil-works/pi-agent-core";
import type { TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { CandidateItem } from "../../core/types.ts";
import type { CommandContext, CommandDefinition } from "./types.ts";

export const builtInCommands: readonly CommandDefinition[] = [
	{
		kind: "line",
		name: "abort",
		description: "Abort the current agent run.",
		execute: async ({ orchestrator, agentId }) =>
			await orchestrator.abortAgent(agentId),
	},
	{
		kind: "line",
		name: "compact",
		description: "Compact the current agent session.",
		argumentHint: "[instructions]",
		execute: async ({ orchestrator, agentId }, argument) =>
			await orchestrator.compactAgent(agentId, argument.trim() || undefined),
	},
	{
		kind: "line",
		name: "follow-up",
		description: "Queue a follow-up for the current agent.",
		argumentHint: "<text>",
		requiresArgument: true,
		execute: async ({ orchestrator, agentId }, argument) => {
			await orchestrator.followUpAgent(agentId, argument.trim());
			return undefined;
		},
	},
	{
		kind: "line",
		name: "fork",
		description: "Fork the current agent session.",
		argumentHint: "[entry]",
		complete: async (context) => await listUserMessageEntryCandidates(context),
		execute: async ({ orchestrator, agentId }, argument) => {
			const entryId = argument.trim() || undefined;
			return await orchestrator.forkAgentSessionFromAgent(
				agentId,
				entryId ? { entryId } : undefined,
			);
		},
	},
	{
		kind: "line",
		name: "inspect",
		description: "Inspect the current agent runtime facts.",
		execute: async ({ orchestrator, agentId }) =>
			orchestrator.inspectAgent(agentId),
	},
	{
		kind: "line",
		name: "agent",
		description: "List runtime agents.",
		execute: async ({ orchestrator }) => orchestrator.listAgents(),
	},
	{
		kind: "line",
		name: "login",
		description: "Log in to an LLM provider subscription.",
		argumentHint: "[provider]",
		complete: async ({ orchestrator }) =>
			orchestrator.listAuthProviderCandidates().providers,
		execute: async ({ orchestrator, agentId }, argument) =>
			await orchestrator.loginAuthProvider(argument.trim(), { agentId }),
	},
	{
		kind: "line",
		name: "logout",
		description: "Remove a stored LLM provider credential.",
		argumentHint: "[provider]",
		complete: async ({ orchestrator }) =>
			(await orchestrator.listAuthCredentialCandidates()).providers,
		execute: async ({ orchestrator }, argument) =>
			await orchestrator.logoutAuthProvider(argument.trim()),
	},
	{
		kind: "line",
		name: "model",
		description: "Set the current agent model.",
		argumentHint: "[provider/model]",
		complete: async ({ orchestrator }) =>
			(await orchestrator.listAvailableModelCandidates()).models,
		execute: async ({ orchestrator, agentId }, argument) =>
			await orchestrator.setAgentModelByReference(agentId, argument.trim()),
	},
	{
		kind: "line",
		name: "thinking",
		description: "Set the current agent thinking level.",
		argumentHint: "[level]",
		complete: async ({ orchestrator, agentId }) =>
			orchestrator.listAgentThinkingLevelCandidates(agentId).levels,
		execute: async ({ orchestrator, agentId }, argument) =>
			await orchestrator.setAgentThinkingLevelByName(agentId, argument.trim()),
	},
	{
		kind: "line",
		name: "name",
		description: "Name the current agent session.",
		argumentHint: "<name>",
		requiresArgument: true,
		execute: async ({ orchestrator, agentId }, argument) =>
			await orchestrator.setAgentSessionName(agentId, argument.trim()),
	},
	{
		kind: "line",
		name: "new",
		description: "Start a new session from the current agent.",
		execute: async ({ orchestrator, agentId }) =>
			await orchestrator.newAgentSessionFromAgent(agentId),
	},
	{
		kind: "line",
		name: "reload",
		description: "Reload extensions for the current agent.",
		execute: async ({ orchestrator, agentId }) =>
			await orchestrator.reloadExtensions({ agentIds: [agentId] }),
	},
	{
		kind: "line",
		name: "resume",
		description: "Resume an existing agent session.",
		argumentHint: "[session]",
		checkStatus: (status) =>
			status === "running"
				? "Command /resume is not available while the agent is running."
				: undefined,
		complete: async ({ orchestrator }) =>
			(await orchestrator.listAgentSessions()).sessions.map((session) => ({
				// Resolve by path, not id: the session id equals the creating
				// agent's id and repeats across runs, making bare ids ambiguous.
				value: session.path,
				label: session.profile?.label ?? session.profile?.id ?? session.id,
				description: `${session.cwd} · ${session.createdAt}`,
			})),
		execute: async ({ orchestrator }, argument) =>
			await orchestrator.resumeAgentSessionByReference(argument.trim()),
	},
	{
		kind: "line",
		name: "session",
		description: "List persisted agent sessions.",
		execute: async ({ orchestrator }) => await orchestrator.listAgentSessions(),
	},
	{
		kind: "line",
		name: "status",
		description: "Get the current agent status.",
		execute: async ({ orchestrator, agentId }) =>
			orchestrator.getAgentStatus(agentId),
	},
	{
		kind: "line",
		name: "steer",
		description: "Steer the current running agent.",
		argumentHint: "<text>",
		requiresArgument: true,
		checkStatus: (status) =>
			status === "running"
				? undefined
				: `Command /steer requires a running agent (status: ${status}).`,
		execute: async ({ orchestrator, agentId }, argument) => {
			await orchestrator.steerAgent(agentId, argument.trim());
			return undefined;
		},
	},
	{
		kind: "line",
		name: "tree",
		description: "Inspect or navigate the current session tree.",
		argumentHint: "[entry]",
		complete: async (context) => await listUserMessageEntryCandidates(context),
		execute: async ({ orchestrator, agentId }, argument) => {
			const targetId = argument.trim();
			if (!targetId) return await orchestrator.getAgentSessionTree(agentId);
			return await orchestrator.navigateAgentTree(agentId, targetId);
		},
	},
	{
		kind: "inline",
		name: "prompt",
		description: "Insert a prompt template inline.",
		argumentHint: "<template>",
		complete: async ({ orchestrator, agentId }) =>
			(await orchestrator.listAgentPromptTemplateCandidates(agentId)).templates,
		expand: async ({ orchestrator, agentId }, argument) =>
			(await orchestrator.getAgentPromptTemplate(agentId, argument.trim()))
				.content,
	},
	{
		kind: "inline",
		name: "skill",
		description: "Apply a skill inline.",
		argumentHint: "<skill_name>",
		complete: async ({ orchestrator, agentId }) =>
			(await orchestrator.listAgentSkillCandidates(agentId)).skills,
		expand: async ({ orchestrator, agentId }, argument) =>
			formatSkillExpansion(
				await orchestrator.getAgentSkill(agentId, argument.trim()),
			),
	},
];

// Fork/navigation targets are the user's own messages: they are the natural
// "points in the conversation" a user thinks in.
async function listUserMessageEntryCandidates(
	context: CommandContext,
): Promise<readonly CandidateItem[]> {
	const tree = await context.orchestrator.getAgentSessionTree(context.agentId);
	const candidates: CandidateItem[] = [];
	for (const entry of tree.entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		candidates.push({
			value: entry.id,
			label: userMessageHeadline(entry.message),
			description: entry.timestamp,
		});
	}
	return candidates;
}

function userMessageHeadline(message: UserMessage): string {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part): part is TextContent => part.type === "text")
					.map((part) => part.text)
					.join(" ");
	const line =
		text
			.split("\n")
			.find((candidate) => candidate.trim() !== "")
			?.trim() ?? "";
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

// The expansion carries metadata and guidance only; the skill body stays in
// the skill file and is loaded on demand by the agent's read tooling.
function formatSkillExpansion(skill: Skill): string {
	return [
		`<skill name="${skill.name}">`,
		skill.description,
		`Skill file: ${skill.filePath}`,
		"Read the skill file for the full instructions before applying it.",
		"</skill>",
	].join("\n");
}
