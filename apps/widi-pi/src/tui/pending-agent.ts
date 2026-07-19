import type { RuntimeModel } from "../core/types.ts";
import type {
	PendingAgentStart,
	PendingAgentViewState,
	TuiApplicationState,
} from "./state.ts";

export interface PendingAgentDisplay {
	readonly profileLabel: string;
	readonly model: RuntimeModel;
	readonly thinkingLevel?: string;
}

export interface PendingAgentRuntime {
	spawnAgent(): Promise<string>;
	newAgentSessionFromAgent(
		agentId: string,
	): Promise<{ readonly agentId: string }>;
}

export class PendingAgentController {
	private readonly state: TuiApplicationState;
	private readonly runtime: PendingAgentRuntime;
	private inFlight?: {
		readonly start: PendingAgentStart;
		readonly promise: Promise<string>;
	};

	constructor(
		state: TuiApplicationState,
		runtime: PendingAgentRuntime,
		display: PendingAgentDisplay,
	) {
		this.state = state;
		this.runtime = runtime;
		this.beginDefault(display);
	}

	beginDefault(display: PendingAgentDisplay): void {
		this.state.activeAgentId = undefined;
		this.state.pendingAgent = createPendingAgent({ kind: "default" }, display);
	}

	beginNewSession(sourceAgentId: string, display: PendingAgentDisplay): void {
		this.state.activeAgentId = undefined;
		this.state.pendingAgent = createPendingAgent(
			{ kind: "new-session", sourceAgentId },
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
		if (start.kind === "default") return await this.runtime.spawnAgent();
		return (await this.runtime.newAgentSessionFromAgent(start.sourceAgentId))
			.agentId;
	}
}

function createPendingAgent(
	start: PendingAgentStart,
	display: PendingAgentDisplay,
): PendingAgentViewState {
	return {
		start,
		timeline: [],
		draft: "",
		display: { ...display },
		nextLiveItemId: 1,
	};
}
