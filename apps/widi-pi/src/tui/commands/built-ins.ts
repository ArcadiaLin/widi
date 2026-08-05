import { getSupportedThinkingLevels, type TextContent, type UserMessage } from "@earendil-works/pi-ai";
import {
	type CompactResult,
	formatPromptTemplateInvocation,
	formatSkillInvocation,
	type NavigateTreeResult,
	parseCommandArgs,
} from "@widi/agent-core";
import type { AgentListResult, AgentSessionListResult, ExtensionReloadResult } from "../../core/agent-orchestrator.ts";
import type { AgentSnapshot } from "../../core/agent-types.ts";
import type {
	AgentSessionCandidate,
	AgentSessionSnapshot,
	AgentSessionTreeSnapshot,
} from "../../core/session-manager.ts";
import type { AgentMaintenanceKind, CandidateItem } from "../../core/types.ts";
import { splitLeadingToken } from "./parse.ts";
import type { CommandContext, CommandDefinition } from "./types.ts";

export const builtInCommands: readonly CommandDefinition[] = [
	{
		kind: "action",
		agentPolicy: "active",
		name: "abort",
		description: "Abort the current agent run.",
		checkActivity: (activity) => unavailableDuringMaintenance("abort", activity.maintenance),
		execute: async (context) => await context.orchestrator.abortAgent(requireAgentId(context)),
	},
	{
		kind: "action",
		agentPolicy: "active",
		name: "compact",
		description: "Compact the current agent session.",
		argumentHint: "[instructions]",
		execute: async (context, argument) =>
			await context.orchestrator.compactAgent(requireAgentId(context), argument.trim() || undefined),
		formatResult: (result) => {
			const compact = result as CompactResult;
			// The summary itself stays in the session (shown as a collapsed
			// "Compacted session" marker); its first line was always the "## Goal"
			// heading, which meant nothing here.
			return `compacted ${compact.tokensBefore} tokens`;
		},
	},
	{
		kind: "action",
		agentPolicy: "active",
		name: "follow-up",
		description: "Queue a follow-up for the current agent.",
		argumentHint: "<text>",
		requiresArgument: true,
		checkActivity: (activity) => unavailableDuringMaintenance("follow-up", activity.maintenance),
		execute: async (context, argument) => {
			await context.orchestrator.followUpAgent(requireAgentId(context), argument.trim());
			return undefined;
		},
	},
	{
		kind: "action",
		agentPolicy: "active",
		name: "fork",
		description: "Fork the current agent session.",
		argumentHint: "[entry]",
		complete: async (context) => await listUserMessageEntryCandidates(context),
		execute: async (context, argument) => {
			const entryId = argument.trim() || undefined;
			const agentId = await context.orchestrator.spawnAgent({
				origin: {
					kind: "fork",
					sourceAgentId: requireAgentId(context),
					...(entryId === undefined ? undefined : { entryId }),
				},
			});
			return context.orchestrator.inspectAgent(agentId);
		},
		formatResult: (result) => agentSnapshotResultText("forked", result),
	},
	{
		kind: "action",
		agentPolicy: "active",
		name: "inspect",
		description: "Inspect the current agent runtime facts.",
		execute: async (context) => context.orchestrator.inspectAgent(requireAgentId(context)),
		formatResult: (result) => {
			const snapshot = result as AgentSnapshot;
			return [
				`${snapshot.agentId} · ${activityLabel(snapshot)} · ${profileLabel(snapshot)} · ${snapshot.model.provider}/${snapshot.model.id}`,
				`${snapshot.tools.toolNames.length} tools · ${snapshot.extensions.extensionIds.length} extensions`,
			].join("\n");
		},
	},
	{
		kind: "action",
		agentPolicy: "runtime",
		name: "agent",
		description: "List runtime agents.",
		execute: async ({ orchestrator }) => orchestrator.listAgents(),
		formatResult: (result) => {
			const { agents } = result as AgentListResult;
			if (agents.length === 0) return "No runtime agents.";
			return agents.map((agent) => `${agent.agentId} · ${activityLabel(agent)} · ${profileLabel(agent)}`).join("\n");
		},
	},
	{
		kind: "action",
		agentPolicy: "runtime",
		name: "login",
		description: "Log in to an LLM provider subscription.",
		argumentHint: "[provider]",
		complete: async ({ orchestrator }) => orchestrator.listAuthProviderCandidates().providers,
		execute: async ({ orchestrator, agentId }, argument) => {
			const result = await orchestrator.loginAuthProvider(argument.trim(), { agentId });
			return `Logged in to ${result.providerName}`;
		},
	},
	{
		kind: "action",
		agentPolicy: "runtime",
		name: "logout",
		description: "Remove a stored LLM provider credential.",
		argumentHint: "[provider]",
		complete: async ({ orchestrator }) => (await orchestrator.listAuthCredentialCandidates()).providers,
		execute: async ({ orchestrator }, argument) => {
			const result = await orchestrator.logoutAuthProvider(argument.trim());
			return result.removed
				? `Removed the stored credential for ${result.providerId}`
				: `No stored credential for ${result.providerId}`;
		},
	},
	{
		kind: "action",
		agentPolicy: "materialize",
		name: "model",
		description: "Set the current agent model.",
		argumentHint: "[provider/model]",
		requiresArgument: true,
		complete: async ({ orchestrator }) => (await orchestrator.listAvailableModelCandidates()).models,
		execute: async (context, argument) => {
			const model = await context.orchestrator.setAgentModelByReference(requireAgentId(context), argument.trim());
			return `Switched to ${model.provider}/${model.id}`;
		},
	},
	{
		kind: "action",
		agentPolicy: "materialize",
		name: "thinking",
		description: "Set the current agent thinking level.",
		argumentHint: "[level]",
		requiresArgument: true,
		complete: async (context) => {
			if (context.agentId) {
				return context.orchestrator.listAgentThinkingLevelCandidates(context.agentId).levels;
			}
			if (!context.pendingModel?.reasoning) return [];
			return getSupportedThinkingLevels(context.pendingModel).map((level) => ({ value: level, label: level }));
		},
		execute: async (context, argument) =>
			await context.orchestrator.setAgentThinkingLevelByName(requireAgentId(context), argument.trim()),
	},
	{
		kind: "action",
		agentPolicy: "materialize",
		name: "rename",
		description: "Rename the current agent session.",
		argumentHint: "<name>",
		requiresArgument: true,
		execute: async (context, argument) =>
			await context.orchestrator.setAgentSessionName(requireAgentId(context), argument.trim()),
		formatResult: (result) => {
			const snapshot = result as AgentSessionSnapshot;
			return `renamed to ${snapshot.name ?? "(unnamed)"}`;
		},
	},
	{
		kind: "action",
		agentPolicy: "active",
		name: "reload",
		description: "Reload extensions for the current agent.",
		execute: async (context) => await context.orchestrator.reloadExtensions({ agentIds: [requireAgentId(context)] }),
		formatResult: (result) => {
			const reload = result as ExtensionReloadResult;
			return [
				`${reload.catalog.loaded.length} extensions loaded`,
				...reload.agents.map((agent) => `${agent.agentId}: ${agent.status}${agent.reason ? ` (${agent.reason})` : ""}`),
			].join("\n");
		},
	},
	{
		kind: "action",
		agentPolicy: "runtime",
		name: "resume",
		description: "Resume an existing agent session.",
		argumentHint: "[session]",
		checkActivity: (activity) =>
			activity.activity === "running" ? "Command /resume is not available while the agent is running." : undefined,
		complete: async ({ orchestrator }) =>
			(await orchestrator.listAgentSessions()).sessions.map((session) => ({
				// Resolve by address, not id: the session id equals the creating
				// agent's id and repeats across runs, making bare ids ambiguous.
				value: session.ref,
				label: sessionCandidateLabel(session),
				description: sessionCandidateDescription(session),
			})),
		execute: async ({ orchestrator }, argument) => {
			const agentId = await orchestrator.spawnAgent({ origin: { kind: "resume", reference: argument.trim() } });
			return orchestrator.inspectAgent(agentId);
		},
		formatResult: (result) => agentSnapshotResultText("resumed", result),
	},
	{
		kind: "action",
		agentPolicy: "runtime",
		name: "session",
		description: "List persisted agent sessions.",
		execute: async ({ orchestrator }) => await orchestrator.listAgentSessions(),
		formatResult: (result) => {
			const { sessions } = result as AgentSessionListResult;
			if (sessions.length === 0) return "No persisted sessions.";
			return sessions.map((session) => `${sessionCandidateLabel(session)} · ${session.id}`).join("\n");
		},
	},
	{
		kind: "action",
		agentPolicy: "active",
		name: "status",
		description: "Get the current agent status.",
		execute: async (context) => context.orchestrator.getAgentActivity(requireAgentId(context)),
	},
	{
		kind: "action",
		agentPolicy: "active",
		name: "steer",
		description: "Steer the current running agent.",
		argumentHint: "<text>",
		requiresArgument: true,
		checkActivity: (activity) =>
			unavailableDuringMaintenance("steer", activity.maintenance) ??
			(activity.activity === "running"
				? undefined
				: `Command /steer requires a running agent (status: ${activity.activity}).`),
		execute: async (context, argument) => {
			const outcome = await context.orchestrator.sendMessage({
				source: { kind: "human" },
				targetAgentId: requireAgentId(context),
				body: argument.trim(),
				mode: "interrupt",
			});
			if (outcome.kind === "blocked") {
				throw new Error(
					outcome.reason
						? `Input blocked by ${outcome.blockedBy}: ${outcome.reason}`
						: `Input blocked by ${outcome.blockedBy}.`,
				);
			}
			return undefined;
		},
	},
	{
		kind: "action",
		agentPolicy: "active",
		name: "tree",
		description: "Inspect or navigate the current session tree.",
		argumentHint: "[entry]",
		complete: async (context) => await listUserMessageEntryCandidates(context),
		execute: async (context, argument) => {
			const agentId = requireAgentId(context);
			const targetId = argument.trim();
			if (!targetId) {
				return await context.orchestrator.getAgentSessionTree(agentId);
			}
			return await context.orchestrator.navigateAgentTree(agentId, targetId);
		},
		formatResult: (result) => {
			// Bare /tree returns the tree snapshot; /tree <entry> navigates.
			if (typeof result === "object" && result !== null && "entries" in result) {
				const tree = result as AgentSessionTreeSnapshot;
				return `${tree.entries.length} entries · leaf ${tree.leafId ?? "none"}`;
			}
			const navigation = result as NavigateTreeResult;
			if (navigation.cancelled) return "Navigation cancelled.";
			return navigation.summaryEntry ? "Navigated (branch summarized)." : "Navigated.";
		},
	},
	{
		kind: "prompt",
		agentPolicy: "materialize",
		name: "prompt",
		description: "Send a prompt template as the prompt.",
		argumentHint: "<template> [args…]",
		requiresArgument: true,
		complete: async (context) =>
			(await context.orchestrator.listAgentPromptTemplateCandidates(requireAgentId(context))).templates,
		expand: async (context, argument) => {
			// The template name is the first token; the rest are positional
			// arguments for the template's own "$1"/"$@" placeholders.
			const [name, ...args] = parseCommandArgs(argument);
			if (!name) throw new Error("Command /prompt requires a template name.");
			const template = await context.orchestrator.getAgentPromptTemplate(requireAgentId(context), name);
			return formatPromptTemplateInvocation(template, args);
		},
	},
	{
		kind: "prompt",
		agentPolicy: "materialize",
		name: "skill",
		description: "Apply a skill as the prompt.",
		argumentHint: "<skill_name> [instructions]",
		requiresArgument: true,
		complete: async (context) => (await context.orchestrator.listAgentSkillCandidates(requireAgentId(context))).skills,
		// Naming a skill is an explicit request to apply it, so the body is
		// inlined rather than pointed at: it saves a read round-trip and keeps
		// skills usable on agents that have no read tool. Automatic discovery
		// stays the system prompt's job (see buildAgentSystemPrompt).
		expand: async (context, argument) => {
			const { token: name, rest: instructions } = splitLeadingToken(argument);
			const skill = await context.orchestrator.getAgentSkill(requireAgentId(context), name);
			return formatSkillInvocation(skill, instructions || undefined);
		},
	},
];

function profileLabel(snapshot: AgentSnapshot): string {
	return snapshot.profile.reference.label ?? snapshot.profile.reference.id;
}

/** Maintenance is what a bare "running" would hide, so it is named instead. */
function activityLabel(snapshot: AgentSnapshot): string {
	return snapshot.activity.maintenance ?? snapshot.activity.activity;
}

// Resume and fork both answer "which agent did I land on".
function agentSnapshotResultText(verb: string, result: unknown): string {
	const snapshot = result as AgentSnapshot;
	return `${verb} ${snapshot.agentId} · ${profileLabel(snapshot)} · ${snapshot.model.id}`;
}

// A session is recognized by what the user called it or first said in it;
// profile and id are last resorts.
function sessionCandidateLabel(session: AgentSessionCandidate): string {
	const label = session.name ?? session.firstUserMessage ?? session.profile?.label ?? session.profile?.id ?? session.id;
	return label.length > 60 ? `${label.slice(0, 59)}…` : label;
}

function sessionCandidateDescription(session: AgentSessionCandidate): string {
	const preview = session.name !== undefined ? session.firstUserMessage : undefined;
	return [preview, session.cwd, session.createdAt].filter(Boolean).join(" · ");
}

// Fork/navigation targets are the user's own messages: they are the natural
// "points in the conversation" a user thinks in.
async function listUserMessageEntryCandidates(context: CommandContext): Promise<readonly CandidateItem[]> {
	const tree = await context.orchestrator.getAgentSessionTree(requireAgentId(context));
	const candidates: CandidateItem[] = [];
	for (const entry of tree.entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		candidates.push({ value: entry.id, label: userMessageHeadline(entry.message), description: entry.timestamp });
	}
	return candidates;
}

function requireAgentId(context: CommandContext): string {
	if (!context.agentId) throw new Error("Command requires an active agent.");
	return context.agentId;
}

function unavailableDuringMaintenance(
	commandName: string,
	maintenance: AgentMaintenanceKind | undefined,
): string | undefined {
	if (!maintenance) return undefined;
	const operation = maintenance === "compaction" ? "compaction" : "tree navigation";
	return `Command /${commandName} is not available during ${operation}.`;
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
