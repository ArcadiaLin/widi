/**
 * RPC mode entry: core's second front end, beside the TUI rather than under it.
 *
 * Startup order is load-bearing.
 *
 * The stdout takeover and the human channel come up first, because
 * `createWidiRuntime` can ask a human before an orchestrator exists - the "ask"
 * project-trust policy runs through the broker during startup.
 *
 * The root agent is then created *before* the client registers, and everything
 * else waits, so `ready` is unconditionally the first frame on the stream.
 * `ready` states the initial facts and every frame after it describes a change
 * to them; a client that saw `agent_spawned` for the root before knowing the
 * protocol version would have to buffer events to interpret them.
 *
 * Only the core halves of extensions load here. That is not a degradation: the
 * dual-entry contract keeps every UI capability on the `tui` export, so a core
 * half has nothing to lose by there being no terminal - see `docs/rpc.md`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_DIR } from "../core/constants.ts";
import { createWidiRuntime } from "../core/runtime-service.ts";
import { formatError } from "../utils/errors.ts";
import { parseInbound } from "./frames.ts";
import { RpcHumanChannel } from "./human-channel.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { RpcServer } from "./server.ts";
import { ProtocolStdout, takeOverStdout } from "./stdout-guard.ts";
import { RPC_PROTOCOL_VERSION, type RpcOutbound } from "./types.ts";

export interface WidiRpcOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly profileId?: string;
	/** Start with no agent at all; the client spawns whatever it needs. */
	readonly noRoot?: boolean;
	/** How long a human request waits for an answer. Unset waits forever. */
	readonly humanTimeoutMs?: number;
}

export async function runWidiRpc(options: WidiRpcOptions): Promise<void> {
	const takeover = takeOverStdout();
	if (!takeover) {
		throw new Error("RPC mode needs sole ownership of stdout, and something already took it.");
	}
	const { rawWrite, restore: restoreStdout } = takeover;

	const stdout = new ProtocolStdout({
		write: rawWrite,
		onFailure: (error) => {
			// The consumer has already seen a truncated frame; there is no state to
			// resynchronise to. Say so on stderr, which is still ours, and stop.
			process.stderr.write(`widi rpc: stdout failed: ${error.message}\n`);
			process.exitCode = 1;
			void shutdown("stdout failed");
		},
	});
	const send = (frame: RpcOutbound): void => {
		stdout.write(serializeJsonLine(frame));
	};
	const human = new RpcHumanChannel({ send, timeoutMs: options.humanTimeoutMs });

	let server: RpcServer | undefined;
	/**
	 * Work held until `ready` has gone out, so that frame is unconditionally the
	 * first one a client reads.
	 *
	 * Input arriving before then is held rather than refused: a client piped into
	 * stdin has already written its commands by the time anyone could have read
	 * `ready`, and losing them would make the obvious usage wrong. Even the answer
	 * to a malformed frame waits, because "ready is first, always" is a rule a
	 * client can code against and "first, unless you sent bad JSON" is not.
	 *
	 * Human requests are the exception in the other direction: they go out
	 * immediately, and their answers are taken immediately, because startup itself
	 * may be the one asking.
	 */
	const heldUntilReady: (() => void)[] = [];
	const afterReady = (work: () => void): void => {
		if (server) work();
		else heldUntilReady.push(work);
	};

	const route = (line: string): void => {
		const parsed = parseInbound(line);
		if (parsed.kind === "invalid") {
			afterReady(() =>
				send({
					type: "response",
					id: parsed.id,
					// `parse` only when the frame did not name a command it could be
					// answered under - unparseable JSON, or no `cmd` at all.
					cmd: parsed.cmd ?? "parse",
					ok: false,
					error: parsed.message,
					code: "invalid_command",
				}),
			);
			return;
		}
		if (parsed.kind === "human_response") {
			if (!human.settle(parsed.frame)) {
				afterReady(() =>
					send({
						type: "response",
						cmd: "human_response",
						ok: false,
						error: `Unknown human request: ${parsed.frame.requestId}`,
						code: "invalid_command",
					}),
				);
			}
			return;
		}
		afterReady(() => server?.handleCommand(parsed.command));
	};

	/**
	 * End of input means "nothing more will be sent", not "stop now".
	 *
	 * A piped client (`printf '...' | widi --mode rpc`) hits EOF before the runtime
	 * has even finished starting, and everything it wrote is still held or still
	 * running. Shutting down on that edge would defeat the whole hold-until-ready
	 * rule, so the close is remembered and acted on once startup is done and every
	 * accepted command has been answered.
	 */
	let inputClosed = false;
	const shutdownIfInputDone = (): void => {
		if (!inputClosed || !server || server.outstandingCommands > 0) return;
		void shutdown("input stream ended");
	};

	const detachReader = attachJsonlLineReader(process.stdin, {
		onLine: route,
		onEnd: () => {
			inputClosed = true;
			shutdownIfInputDone();
		},
	});

	let shuttingDown = false;
	let unregisterClient: (() => void) | undefined;
	let unsubscribeExtensionEvents: (() => void) | undefined;
	let disposeRuntime: ((reason: string) => Promise<void>) | undefined;
	let resolveClosed: (() => void) | undefined;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});

	async function shutdown(reason: string): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		detachReader();
		// Reading stdin left its handle referenced, and a client that sent
		// `shutdown` normally keeps its end of the pipe open - so without this the
		// process would answer the command and then live on with an empty event
		// loop, waiting for input nobody will send. Releasing it here rather than in
		// the reader's detach: stdin is this function's to own, the reader only
		// borrowed it.
		process.stdin.pause();
		process.stdin.unref();
		human.closeAll(`Shutting down: ${reason}`);
		unregisterClient?.();
		unsubscribeExtensionEvents?.();
		try {
			await disposeRuntime?.(reason);
		} catch (error) {
			process.stderr.write(`widi rpc: shutdown failed: ${formatError(error)}\n`);
		}
		// Frames already handed over still belong to the consumer.
		await stdout.drain();
		restoreStdout();
		resolveClosed?.();
	}

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			void shutdown(signal);
		});
	}

	try {
		const runtime = await createWidiRuntime({
			cwd: options.cwd,
			agentDir: options.agentDir ?? join(homedir(), DEFAULT_AGENT_DIR),
			defaultProfileId: options.profileId,
			requestHuman: human.request,
		});
		disposeRuntime = async (reason) => {
			await runtime.orchestrator.disposeAll(reason);
		};

		// A shutdown that arrived mid-startup could not dispose a runtime that did
		// not exist yet. Now it does, so do that part and stop here: no root agent,
		// no `ready`, no client registration for a process already on its way out.
		if (shuttingDown) {
			try {
				await disposeRuntime("shut down before startup finished");
			} catch (error) {
				process.stderr.write(`widi rpc: shutdown failed: ${formatError(error)}\n`);
			}
			await closed;
			return;
		}

		const rootAgentId = options.noRoot ? undefined : await runtime.orchestrator.spawnAgent({ origin: { kind: "new" } });

		server = new RpcServer({
			orchestrator: runtime.orchestrator,
			modelRegistry: runtime.services.modelRegistry,
			human,
			send,
			drain: () => stdout.drain(),
			onShutdown: (reason) => {
				void shutdown(reason ?? "client requested shutdown");
			},
			onCommandsDrained: shutdownIfInputDone,
		});

		send({
			type: "ready",
			protocolVersion: RPC_PROTOCOL_VERSION,
			rootAgentId,
			cwd: runtime.services.cwd,
			agentDir: runtime.services.agentDir,
			diagnostics: runtime.diagnostics,
		});

		unregisterClient = runtime.orchestrator.registerClient(server);
		// A bus subscriber beside the client, not under it: extension events are not
		// orchestrator events and never reach `receive`.
		unsubscribeExtensionEvents = runtime.orchestrator.registerExtensionEventSubscriber({
			deliver: async (event) => {
				send({ type: "extension_event", event });
				await stdout.drain();
			},
		});

		// After `ready` and after the client is registered, so a held command's
		// events reach the stream in the same order a fresh one's would.
		for (const work of heldUntilReady.splice(0)) work();

		// Covers a client that closed its end during startup and sent nothing, or
		// only frames that answered synchronously.
		shutdownIfInputDone();
	} catch (error) {
		await shutdown("startup failed");
		throw error;
	}

	await closed;
}

export { classifyError, RpcError, type RpcErrorCode } from "./errors.ts";
export { RpcServer } from "./server.ts";
export * from "./types.ts";
export type { WireAssistantMessageEvent, WireHarnessEvent, WireOrchestratorEvent } from "./wire-event.ts";
export { toWireEvent } from "./wire-event.ts";
