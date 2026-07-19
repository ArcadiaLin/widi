import type { AgentId } from "../core/types.ts";
import { agentLabel } from "./components/common.ts";
import { singleLine } from "./format.ts";
import type { AgentViewState, TuiApplicationState } from "./state.ts";

const COMPACT_ID_LENGTH = 12;
const LONG_ID_SUFFIX_LENGTH = 8;

export function shortAgentId(agentId: AgentId): string {
	const sanitizedAgentId = singleLine(agentId, agentId.length);
	return sanitizedAgentId.length <= COMPACT_ID_LENGTH
		? sanitizedAgentId
		: sanitizedAgentId.slice(-LONG_ID_SUFFIX_LENGTH);
}

export function agentIdentityLabel(
	state: TuiApplicationState,
	agent: AgentViewState,
): string {
	const label = agentLabel(agent);
	const visibleAgents = [...state.agents.values()].filter(
		(candidate) => candidate.status !== "disposed",
	);
	if (visibleAgents.length <= 1) return label;

	const ownToken = shortAgentId(agent.agentId);
	const source = findForkSource(state, agent);
	if (source) {
		const sessionName = source.display.sessionName
			? singleLine(source.display.sessionName)
			: undefined;
		const sourceToken = sessionName || shortAgentId(source.agentId);
		return `${label} [fork from ${sourceToken} · ${ownToken}]`;
	}
	return hasForkParent(agent)
		? `${label} [fork · ${ownToken}]`
		: `${label} [${ownToken}]`;
}

export function forkSourceAgentId(
	state: TuiApplicationState,
	agent: AgentViewState,
): AgentId | undefined {
	return findForkSource(state, agent)?.agentId;
}

function findForkSource(
	state: TuiApplicationState,
	agent: AgentViewState,
): AgentViewState | undefined {
	if (agent.display.forkedFromAgentId) {
		return state.agents.get(agent.display.forkedFromAgentId);
	}
	const parentPath = parentSessionPath(agent);
	if (!parentPath) return undefined;
	return [...state.agents.values()].find(
		(candidate) => sessionPath(candidate) === parentPath,
	);
}

function hasForkParent(agent: AgentViewState): boolean {
	return (
		agent.display.forkedFromAgentId !== undefined ||
		parentSessionPath(agent) !== undefined
	);
}

function parentSessionPath(agent: AgentViewState): string | undefined {
	const metadata = agent.snapshot?.sessionMetadata;
	return metadata && "parentSessionPath" in metadata
		? metadata.parentSessionPath
		: undefined;
}

function sessionPath(agent: AgentViewState): string | undefined {
	const metadata = agent.snapshot?.sessionMetadata;
	return metadata && "path" in metadata ? metadata.path : undefined;
}
