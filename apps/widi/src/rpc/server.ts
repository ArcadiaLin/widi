/**
 * The protocol side of RPC mode: one orchestrator client that speaks JSONL.
 *
 * It is a client in the exact sense `core/client.ts` means, which is why this
 * mode needs no new core seam - the TUI registers the same way. `receive`
 * awaits the outbound drain, and because every hop from the harness up
 * (`agent-harness.ts` emitAny, `_handleHarnessEvent`, `event-bus.ts` publish)
 * awaits its callee, a consumer that reads slowly throttles the model loop
 * rather than growing a queue in memory.
 *
 * The cost of that, which the TUI does not pay: one bus, one client and one
 * write tail are shared by every agent, so a slow consumer slows all of them
 * and not just the one it is reading about. Accepted for v1 - "everything slows
 * down" is a safe failure and unbounded buffering is not.
 *
 * Commands are dispatched as they arrive rather than queued behind each other:
 * a `wait_idle` on one agent must not stall a `send` to another.
 *
 * The commands that can wait indefinitely - `prompt` and the three waits - run
 * under a signal, which a deadline or a `cancel` trips. They are also the only
 * ones: everything else either returns at once or is bounded by one harness
 * call.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentOrchestrator } from "../core/agent-orchestrator.ts";
import type { OrchestratorClient } from "../core/client.ts";
import type { HumanRequestEnvelope, HumanResponse } from "../core/human-request.ts";
import { type MessageSink, messageBindingFor } from "../core/message.ts";
import type { ModelRegistry } from "../core/model-registry.ts";
import type { AgentId, OrchestratorEvent, PromptOutcome, RuntimeModel } from "../core/types.ts";
import { formatError } from "../utils/errors.ts";
import { classifyError, RpcError, type RpcErrorCode } from "./errors.ts";
import type { RpcHumanChannel } from "./human-channel.ts";
import { RunAccounting } from "./run-summary.ts";
import type { RpcCommand, RpcCommandName, RpcCommandResults, RpcOutbound, RpcSuccessFrame } from "./types.ts";
import { toWireEvent } from "./wire-event.ts";

/**
 * How long a delegation tree has to stay idle before `wait_tree_idle` believes
 * it. Sized for one session-branch read, which is the gap it covers; see
 * {@link RpcServer._waitTreeIdle}.
 */
const DEFAULT_TREE_QUIET_MS = 250;

/** A command in flight under a signal, and the way to stop being one. */
interface CommandRun {
	readonly signal: AbortSignal;
	end(): void;
}

export interface RpcServerOptions {
	readonly orchestrator: AgentOrchestrator;
	readonly modelRegistry: ModelRegistry;
	readonly human: RpcHumanChannel;
	readonly send: (frame: RpcOutbound) => void;
	/** Awaited after each event frame. Omitted means no backpressure coupling. */
	readonly drain?: () => Promise<void>;
	readonly onShutdown?: (reason?: string) => void;
	/** Every accepted command has been answered. See {@link RpcServer.outstandingCommands}. */
	readonly onCommandsDrained?: () => void;
}

export class RpcServer implements OrchestratorClient<OrchestratorEvent> {
	readonly id = "rpc";

	/**
	 * A bound value, not a method: `findHumanRequestHandler` pulls this off the
	 * client and calls it detached (`core/event-bus.ts`), so a prototype method
	 * would run with no `this`. The channel's own `request` is already bound.
	 */
	readonly requestHuman: (request: HumanRequestEnvelope, signal?: AbortSignal) => Promise<HumanResponse>;

	private readonly _orchestrator: AgentOrchestrator;
	private readonly _models: ModelRegistry;
	private readonly _send: (frame: RpcOutbound) => void;
	private readonly _drain: (() => Promise<void>) | undefined;
	private readonly _onShutdown: ((reason?: string) => void) | undefined;
	private readonly _onCommandsDrained: (() => void) | undefined;
	private readonly _sink: MessageSink;
	private readonly _accounting = new RunAccounting();
	private readonly _inFlight = new Map<string, AbortController>();
	private readonly _treeWaiters = new Set<() => void>();
	private _outstanding = 0;

	constructor(options: RpcServerOptions) {
		this._orchestrator = options.orchestrator;
		this._models = options.modelRegistry;
		this.requestHuman = options.human.request;
		this._send = options.send;
		this._drain = options.drain;
		this._onShutdown = options.onShutdown;
		this._onCommandsDrained = options.onCommandsDrained;
		// Fixed at construction, like every other sink holder: the policy belongs
		// to the binding and a request may not override it. An RPC peer speaks in
		// the human's place, so it gets the human binding.
		this._sink = options.orchestrator.messageSinkFor(messageBindingFor({ kind: "human" }));
	}

	async receive(event: OrchestratorEvent): Promise<void> {
		// Before the send, so a summary read cannot answer with an event counted
		// only after the client had already been told about it.
		this._accounting.record(event);
		this._send({ type: "event", event: toWireEvent(event) });
		// Before the drain, so a tree's quiet window is measured from when the
		// runtime did something and not from when the consumer got round to it.
		for (const restart of [...this._treeWaiters]) restart();
		await this._drain?.();
	}

	/**
	 * Accepted but not yet answered. Counted from `handleCommand` rather than from
	 * inside the dispatch so it is already correct when this call returns: a caller
	 * deciding whether it may shut down must not read zero for a command it just
	 * handed over.
	 */
	get outstandingCommands(): number {
		return this._outstanding;
	}

	/**
	 * Run one command and answer it. A rejection becomes an error response, so a
	 * refused command never reaches the process as an unhandled rejection.
	 */
	handleCommand(command: RpcCommand): void {
		this._outstanding += 1;
		void this._dispatch(command)
			.catch((error: unknown) => {
				this.fail(command.id, command.cmd, formatError(error), classifyError(error));
			})
			.finally(() => {
				this._outstanding -= 1;
				if (this._outstanding === 0) this._onCommandsDrained?.();
			});
	}

	fail(id: string | undefined, cmd: string, error: string, code: RpcErrorCode): void {
		this._send({ type: "response", id, cmd, ok: false, error, code });
	}

	private async _dispatch(command: RpcCommand): Promise<void> {
		const run = this._beginRun(command);
		try {
			const data = await this._run(command, run?.signal);
			// The switch in `_run` pairs each `cmd` with its own result, which the
			// distributed response type states but no inference can carry across the
			// call. The cast is that pairing, asserted once here.
			this._send({ type: "response", id: command.id, cmd: command.cmd, ok: true, data } as RpcSuccessFrame);
		} finally {
			run?.end();
		}
	}

	/**
	 * Put a command under a signal, if it is one that can wait. The deadline and a
	 * `cancel` trip the same signal and each aborts with its own `RpcError`, so
	 * whichever fired is what the client is told - the code comes from the reason
	 * rather than from asking afterwards which of the two it was.
	 */
	private _beginRun(command: RpcCommand): CommandRun | undefined {
		if (
			command.cmd !== "prompt" &&
			command.cmd !== "wait_idle" &&
			command.cmd !== "wait_stop" &&
			command.cmd !== "wait_tree_idle"
		) {
			return undefined;
		}
		const { id, deadlineMs } = command;
		if (id !== undefined && this._inFlight.has(id)) {
			throw new RpcError("invalid_command", `Command id ${id} is already in flight.`);
		}
		if (deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) {
			throw new RpcError("invalid_command", `deadlineMs must be a positive number of milliseconds: ${deadlineMs}`);
		}

		const controller = new AbortController();
		if (id !== undefined) this._inFlight.set(id, controller);
		const timer =
			deadlineMs === undefined
				? undefined
				: setTimeout(() => {
						controller.abort(new RpcError("timeout", `${command.cmd} exceeded its ${deadlineMs}ms deadline.`));
					}, deadlineMs);
		return {
			signal: controller.signal,
			end: () => {
				if (timer !== undefined) clearTimeout(timer);
				if (id !== undefined && this._inFlight.get(id) === controller) this._inFlight.delete(id);
			},
		};
	}

	private async _run(command: RpcCommand, signal?: AbortSignal): Promise<RpcCommandResults[RpcCommandName]> {
		const orchestrator = this._orchestrator;
		switch (command.cmd) {
			case "spawn": {
				const agentId = await orchestrator.spawnAgent({
					origin: command.origin,
					parent: command.parent,
					cwd: command.cwd,
					model: command.model === undefined ? undefined : this._requireModel(command.model),
					thinkingLevel: command.thinkingLevel,
				});
				return { agentId };
			}
			case "send":
				return await this._sink.send({
					targetAgentId: command.agentId,
					body: command.body,
					mode: command.mode,
					images: command.images,
				});
			case "prompt":
				return await this._prompt(command.agentId, { body: command.body, images: command.images }, signal);
			case "abort":
				return await orchestrator.abortAgent(command.agentId, "human");
			case "dispose": {
				const agentIds = await orchestrator.disposeAgent(command.agentId, {
					intent: "removed",
					scope: command.scope,
					reason: command.reason,
				});
				return { agentIds };
			}
			case "compact":
				return await orchestrator.compactAgent(command.agentId, command.customInstructions);
			case "wait_idle":
				// A stopped wait leaves the agent exactly as it was: this command only
				// ever watched it.
				await orchestrator.waitForAgentIdle(command.agentId, signal === undefined ? {} : { signal });
				return {};
			case "wait_stop":
				// No waiter agent: an RPC client stands beside the orchestrator, so the
				// only disposal that can end this wait is the watched agent's own.
				return await orchestrator.waitForAgentStop(undefined, command.agentId, signal === undefined ? {} : { signal });
			case "wait_tree_idle":
				return await this._waitTreeIdle(command.agentId, command.quietMs ?? DEFAULT_TREE_QUIET_MS, signal);
			case "read_report": {
				const report = await orchestrator.readAgentReport(command.agentId);
				return report === undefined ? {} : { report };
			}
			case "run_summary":
				return this._accounting.summarize();
			case "list_agents":
				return { agents: orchestrator.listAgents().agents };
			case "inspect":
				return orchestrator.inspectAgent(command.agentId);
			case "set_model":
				return await orchestrator.setAgentModelByReference(command.agentId, command.model);
			case "set_thinking_level":
				await orchestrator.setAgentThinkingLevel(command.agentId, command.level);
				return {};
			case "cancel_human_request":
				return { cancelled: await orchestrator.cancelHumanRequest(command.requestId, command.reason) };
			case "cancel": {
				const controller = this._inFlight.get(command.commandId);
				if (!controller) return { cancelled: false };
				controller.abort(new RpcError("aborted", `Command ${command.commandId} was cancelled by the client.`));
				return { cancelled: true };
			}
			case "shutdown":
				this._onShutdown?.(command.reason);
				return {};
			default:
				// The union is exhaustive above; this is a frame off the wire, so the
				// name is whatever the client typed. Answering `ok` with no data
				// would let a typo read as success.
				throw new RpcError("invalid_command", `Unknown command: ${(command as { cmd: string }).cmd}`);
		}
	}

	/**
	 * A prompt, and if it is under a signal, a prompt whose end is guaranteed
	 * before the answer goes out.
	 *
	 * A tripped signal aborts the agent and then *awaits the run it aborted*. That
	 * is the point: when the `timeout` or `aborted` response arrives, the agent has
	 * settled and its remaining events are already on the stream, so a batch runner
	 * can move to the next sample without racing the last one's tail. Abandoning
	 * the run and answering early would leave a live model loop writing events
	 * attributed to a command the client considers finished.
	 */
	private async _prompt(
		agentId: AgentId,
		input: { readonly body: string; readonly images?: readonly ImageContent[] },
		signal?: AbortSignal,
	): Promise<PromptOutcome> {
		const run = this._sink.prompt({
			targetAgentId: agentId,
			body: input.body,
			mode: "next_turn",
			images: input.images,
		});
		if (!signal) return await run;

		const stopped = new Promise<never>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
		try {
			return await Promise.race([run, stopped]);
		} catch (error) {
			if (!signal.aborted) throw error;
			// Both are best-effort: the agent may already be gone, and the run's own
			// failure is not what the client asked about.
			await this._orchestrator.abortAgent(agentId, "human").catch(() => {});
			await run.catch(() => {});
			throw signal.reason;
		}
	}

	/**
	 * When a whole delegation tree has stopped, which is the question a batch
	 * runner is actually asking and the one no single event answers.
	 *
	 * `prompt` and `wait_idle` speak about one agent, and a root that delegated is
	 * idle for as long as its subagent works. The join over the subtree is what
	 * answers the real question, and it is the load-bearing half.
	 *
	 * The other half is the deferred re-check, and it needs its claim stated
	 * precisely. The handover between two agents is not atomic anywhere this code
	 * can see: a subagent's stop becomes the watcher's wake-up inside
	 * `AgentWatches`, which reads the report from the session in between and only
	 * then enqueues. So the tree can read idle while it is not finished, and the
	 * condition is never believed at the instant it first holds - it is re-checked
	 * after a delay, and any runtime event restarts that delay.
	 *
	 * What the tests demonstrate is the re-check, which catches everything the
	 * handover completes within one turn of the event loop. They do not
	 * demonstrate the *length* of the window, and no fixture here can: it only
	 * buys anything if that session read reaches disk. It is set rather than zero
	 * because being early costs a silently truncated sample and being late costs
	 * one window.
	 *
	 * Removing the guesswork means the orchestrator knowing about the watch table,
	 * which lives under the tool registry and below it. Until that is worth doing,
	 * the window is tunable - `quietMs: 0` keeps the re-check and drops the guess.
	 * Restarting on every event, not just this tree's, is safe because a sample
	 * owns its process (`docs/rpc.md` section 7.4).
	 */
	private async _waitTreeIdle(
		agentId: AgentId,
		quietMs: number,
		signal?: AbortSignal,
	): Promise<{ readonly agentIds: readonly AgentId[] }> {
		if (!Number.isFinite(quietMs) || quietMs < 0) {
			throw new RpcError("invalid_command", `quietMs must be a non-negative number of milliseconds: ${quietMs}`);
		}
		// Rejects now rather than waiting out a deadline on an id that was never a
		// live agent. A tree that empties later is a different case, handled below.
		this._orchestrator.inspectAgent(agentId);

		const settledTree = (): readonly AgentId[] | undefined => {
			const tree = this._orchestrator.listAgentSubtree(agentId);
			return tree.length > 0 && tree.every((id) => this._orchestrator.isAgentIdle(id)) ? tree : undefined;
		};

		return await new Promise<{ readonly agentIds: readonly AgentId[] }>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let restart = (): void => {};
			const finish = (settle: () => void): void => {
				if (timer !== undefined) clearTimeout(timer);
				this._treeWaiters.delete(restart);
				signal?.removeEventListener("abort", onAbort);
				settle();
			};
			const onAbort = (): void => finish(() => reject(signal?.reason));

			restart = (): void => {
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
				if (!settledTree()) return;
				timer = setTimeout(() => {
					timer = undefined;
					const tree = settledTree();
					// An empty tree is the whole subtree having been disposed while this
					// waited. There is nothing left to be idle, and saying so is more
					// useful than answering with an empty list.
					if (this._orchestrator.listAgentSubtree(agentId).length === 0) {
						finish(() => reject(new RpcError("agent_unavailable", `Agent ${agentId}'s tree is gone.`)));
					} else if (tree) {
						finish(() => resolve({ agentIds: tree }));
					}
				}, quietMs);
			};

			this._treeWaiters.add(restart);
			if (signal) {
				if (signal.aborted) {
					finish(() => reject(signal.reason));
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			restart();
		});
	}

	/**
	 * A `provider/id` reference resolved against the registry, for the one path
	 * that needs the model object up front. Everything else routes through
	 * `setAgentModelByReference`, which resolves it in core.
	 */
	private _requireModel(reference: string): RuntimeModel {
		const separator = reference.indexOf("/");
		if (separator <= 0 || separator === reference.length - 1) {
			throw new RpcError("invalid_command", `Model reference must be 'provider/id': ${reference}`);
		}
		const model = this._models.find(reference.slice(0, separator), reference.slice(separator + 1));
		if (!model) throw new RpcError("model_unavailable", `Unknown model reference: ${reference}`);
		return model;
	}
}
