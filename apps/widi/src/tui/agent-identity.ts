import { parseSessionOrigin } from "../core/persistence/index.ts";
import type { AgentId } from "../core/types.ts";
import { singleLine } from "./format.ts";
import { agentLabel } from "./labels.ts";
import type { AgentViewState, TuiApplicationState } from "./state.ts";

const COMPACT_ID_LENGTH = 12;
const LONG_ID_SUFFIX_LENGTH = 8;

export function shortAgentId(agentId: AgentId): string {
	const sanitizedAgentId = singleLine(agentId, agentId.length);
	return sanitizedAgentId.length <= COMPACT_ID_LENGTH
		? sanitizedAgentId
		: sanitizedAgentId.slice(-LONG_ID_SUFFIX_LENGTH);
}

export function agentIdentityLabel(state: TuiApplicationState, agent: AgentViewState): string {
	const label = agentLabel(agent);
	const visibleAgents = [...state.agents.values()].filter((candidate) => candidate.status !== "disposed");
	if (visibleAgents.length <= 1) return label;

	const ownToken = shortAgentId(agent.agentId);
	const source = findForkSource(state, agent);
	if (source) {
		const sessionName = source.display.sessionName ? singleLine(source.display.sessionName) : undefined;
		const sourceToken = sessionName || shortAgentId(source.agentId);
		return `${label} [fork from ${sourceToken} · ${ownToken}]`;
	}
	return hasForkParent(agent) ? `${label} [fork · ${ownToken}]` : `${label} [${ownToken}]`;
}

export function forkSourceAgentId(state: TuiApplicationState, agent: AgentViewState): AgentId | undefined {
	return findForkSource(state, agent)?.agentId;
}

/**
 * The fork event when this runtime took the fork, the session header otherwise.
 *
 * The header records which session the history was copied from, which is what
 * survives the runtime that did the copying. It is deliberately not the session
 * that *spawned* this one - every subagent has one of those, and treating it as
 * fork provenance would label the whole spawn tree as forks.
 */
function findForkSource(state: TuiApplicationState, agent: AgentViewState): AgentViewState | undefined {
	if (agent.display.forkedFromAgentId) {
		return state.agents.get(agent.display.forkedFromAgentId);
	}
	const forkedFrom = forkSourceRef(agent);
	if (!forkedFrom) return undefined;
	return [...state.agents.values()].find((candidate) => candidate.snapshot?.sessionRef === forkedFrom);
}

function hasForkParent(agent: AgentViewState): boolean {
	return agent.display.forkedFromAgentId !== undefined || forkSourceRef(agent) !== undefined;
}

function forkSourceRef(agent: AgentViewState): string | undefined {
	const metadata = agent.snapshot?.sessionMetadata;
	return parseSessionOrigin(metadata && "metadata" in metadata ? metadata.metadata : undefined)?.forkedFrom;
}
