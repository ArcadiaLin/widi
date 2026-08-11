import type { SpawnAgentOptions } from "../core/agent-orchestrator.ts";
import type { RuntimeModel } from "../core/types.ts";
import type { PendingAgentStart, PendingAgentViewState, TuiApplicationState } from "./state.ts";

export interface PendingAgentDisplay {
	/** The profile's own id, which is also the prefix of the id it will be given. */
	readonly profileId: string;
	readonly profileLabel: string;
	readonly model: RuntimeModel;
	readonly thinkingLevel?: string;
}

export interface PendingAgentRuntime {
	// The orchestrator's own parameter, not a narrowed restatement of it: a
	// method parameter is bivariant, so a narrower one here would keep type
	// checking a call the orchestrator cannot answer.
	spawnAgent(options: SpawnAgentOptions): Promise<string>;
}

export class PendingAgentController {
	private readonly state: TuiApplicationState;
	private readonly runtime: PendingAgentRuntime;
	private inFlight?: { readonly start: PendingAgentStart; readonly promise: Promise<string> };

	constructor(state: TuiApplicationState, runtime: PendingAgentRuntime, display: PendingAgentDisplay) {
		this.state = state;
		this.runtime = runtime;
		this.beginDefault(display);
	}

	beginDefault(display: PendingAgentDisplay): void {
		this.state.activeAgentId = undefined;
		this.state.pendingAgent = createPendingAgent({ kind: "default" }, display);
	}

	beginNewSession(
		source: { readonly profileId: string; readonly model: RuntimeModel },
		display: PendingAgentDisplay,
	): void {
		this.state.activeAgentId = undefined;
		this.state.pendingAgent = createPendingAgent(
			{ kind: "new-session", profileId: source.profileId, model: source.model },
			display,
		);
	}

	cancel(): void {
		this.state.pendingAgent = undefined;
	}

	async materialize(): Promise<string> {
		const pending = this.state.pendingAgent;
		if (!pending) throw new Error("No pending agent is available.");
		if (this.inFlight?.start === pending.start) {
			return await this.inFlight.promise;
		}

		const promise = this.start(pending.start);
		this.inFlight = { start: pending.start, promise };
		try {
			const agentId = await promise;
			if (this.state.pendingAgent?.start === pending.start) {
				this.state.pendingAgent = undefined;
			}
			return agentId;
		} finally {
			if (this.inFlight?.promise === promise) this.inFlight = undefined;
		}
	}

	private async start(start: PendingAgentStart): Promise<string> {
		if (start.kind === "default") return await this.runtime.spawnAgent({ origin: { kind: "new" } });
		return await this.runtime.spawnAgent({ origin: { kind: "new", profileId: start.profileId }, model: start.model });
	}
}

function createPendingAgent(start: PendingAgentStart, display: PendingAgentDisplay): PendingAgentViewState {
	return { start, timeline: [], draft: "", display: { ...display }, nextLiveItemId: 1 };
}
