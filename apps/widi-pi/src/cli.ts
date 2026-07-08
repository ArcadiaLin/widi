/**
 * Minimal stdout/CLI adapter.
 *
 * This is the first non-test consumer of the runtime. It deliberately uses
 * only the public composition surface: createWidiRuntime, orchestrator
 * events via subscribe/registerClient, and inputAgent. Anything this file
 * cannot do through that surface is an extension-surface finding, not a
 * reason to import core internals.
 */

import { createInterface } from "node:readline";
import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type {
	AgentOrchestrator,
	OrchestratorEvent,
} from "./core/agent-orchestrator.ts";
import type { OrchestratorDiagnostic } from "./core/diagnostics.ts";
import type {
	HumanRequestEnvelope,
	HumanResponse,
} from "./core/human-request.ts";
import { createWidiRuntime } from "./core/runtime-service.ts";

interface CliOptions {
	cwd: string;
	agentDir?: string;
	profileId?: string;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { cwd: process.cwd() };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--cwd":
				options.cwd = requireValue(argv, ++i, arg);
				break;
			case "--agent-dir":
				options.agentDir = requireValue(argv, ++i, arg);
				break;
			case "--profile":
				options.profileId = requireValue(argv, ++i, arg);
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
	const value = argv[index];
	if (value === undefined) {
		throw new Error(`Missing value for ${flag}`);
	}
	return value;
}

function printDiagnostic(diagnostic: OrchestratorDiagnostic): void {
	process.stdout.write(
		`[diagnostic:${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}\n`,
	);
}

/**
 * Streaming render state. The CLI writes deltas inline; any non-delta output
 * must first close an open streaming line so lines stay whole.
 */
let streamOpen = false;

function writeDelta(text: string): void {
	streamOpen = true;
	process.stdout.write(text);
}

function writeLine(text: string): void {
	if (streamOpen) {
		process.stdout.write("\n");
		streamOpen = false;
	}
	process.stdout.write(`${text}\n`);
}

function shortJson(value: unknown, maxLength = 200): string {
	let text: string;
	try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (text === undefined) return "undefined";
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function renderEvent(event: OrchestratorEvent): void {
	switch (event.type) {
		case "agent_harness_event":
			renderHarnessEvent(event.event);
			return;
		case "tool_lifecycle_event":
			return;
		case "command_detected":
		case "command_accepted":
			return;
		case "command_completed":
			writeLine(
				`[command:${event.command.name}] ${shortJson(event.result, 2000)}`,
			);
			return;
		case "command_failed":
		case "command_rejected":
			writeLine(
				`[command:${event.command?.name ?? "?"}:${event.type === "command_failed" ? "failed" : "rejected"}] ${event.diagnostic.message}`,
			);
			return;
		case "diagnostic":
			printDiagnostic(event.diagnostic);
			return;
		case "agent_spawned":
			writeLine(
				`[agent] spawned ${event.agentId} profile=${event.profile.id} model=${event.model.provider}/${event.model.id}`,
			);
			return;
		case "agent_resumed":
			writeLine(`[agent] resumed ${event.agentId}`);
			return;
		default:
			return;
	}
}

function renderHarnessEvent(event: AgentHarnessEvent): void {
	switch (event.type) {
		case "message_update": {
			const streamEvent = event.assistantMessageEvent;
			if (streamEvent.type === "text_delta" && streamEvent.delta) {
				writeDelta(streamEvent.delta);
			} else if (streamEvent.type === "thinking_start") {
				writeLine("[thinking]");
			} else if (streamEvent.type === "thinking_delta" && streamEvent.delta) {
				writeDelta(streamEvent.delta);
			} else if (streamEvent.type === "thinking_end") {
				writeLine("[/thinking]");
			}
			return;
		}
		case "tool_execution_start":
			writeLine(`[tool:${event.toolName}] ${shortJson(event.args)}`);
			return;
		case "tool_execution_end": {
			const result = event.result as {
				content?: Array<{ type: string; text?: string }>;
			};
			const text =
				result?.content
					?.filter((item) => item.type === "text")
					.map((item) => item.text ?? "")
					.join("\n") ?? "";
			writeLine(
				`[tool:${event.toolName}:${event.isError ? "error" : "ok"}] ${shortJson(text)}`,
			);
			return;
		}
		case "agent_end":
			writeLine("[turn done]");
			return;
		default:
			return;
	}
}

/**
 * Buffering line source. Lines are queued from process start so input that
 * arrives while the runtime is still composing (piped stdin) is not lost to
 * a readline interface that has no pending question yet.
 */
class LineReader {
	private readonly queue: string[] = [];
	private readonly waiters: Array<(line: string | undefined) => void> = [];
	private closed = false;

	constructor(input: NodeJS.ReadableStream) {
		const rl = createInterface({ input });
		rl.on("line", (line) => {
			const waiter = this.waiters.shift();
			if (waiter) {
				waiter(line);
			} else {
				this.queue.push(line);
			}
		});
		rl.on("close", () => {
			this.closed = true;
			for (const waiter of this.waiters.splice(0)) {
				waiter(undefined);
			}
		});
	}

	/** Returns the next line, or undefined once stdin is closed and drained. */
	async next(promptText: string): Promise<string | undefined> {
		const queued = this.queue.shift();
		if (queued !== undefined) return queued;
		if (this.closed) return undefined;
		process.stdout.write(promptText);
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}
}

async function promptHuman(
	lines: LineReader,
	request: HumanRequestEnvelope,
): Promise<HumanResponse> {
	writeLine(`[human:${request.kind}] ${request.title}`);
	if (request.message) writeLine(request.message);
	if (request.options && request.options.length > 0) {
		for (const [index, option] of request.options.entries()) {
			writeLine(`  ${index + 1}. ${option}`);
		}
	}
	const answer = ((await lines.next("human> ")) ?? "").trim();

	switch (request.kind) {
		case "confirm":
			return { kind: "confirm", confirmed: /^y(es)?$/i.test(answer) };
		case "select":
			return { kind: "select", value: pickOption(request, answer) };
		default:
			// input / argumentsCompletion / custom all reduce to a free-form
			// value in this adapter; empty input means "no value".
			return { kind: "input", value: answer === "" ? undefined : answer };
	}
}

function pickOption(
	request: HumanRequestEnvelope,
	answer: string,
): string | undefined {
	if (answer === "") return undefined;
	const options = request.options ?? [];
	const byNumber = Number.parseInt(answer, 10);
	if (Number.isFinite(byNumber) && byNumber >= 1 && byNumber <= options.length) {
		return options[byNumber - 1];
	}
	return options.find((option) => option === answer) ?? answer;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const runtime = await createWidiRuntime({
		cwd: options.cwd,
		agentDir: options.agentDir,
		defaultProfileId: options.profileId,
	});
	const orchestrator: AgentOrchestrator = runtime.orchestrator;

	for (const diagnostic of runtime.diagnostics) {
		printDiagnostic(diagnostic);
	}

	const lines = new LineReader(process.stdin);
	orchestrator.registerClient({
		id: "cli",
		requestHuman: (request) => promptHuman(lines, request),
	});
	if (process.env.WIDI_CLI_DEBUG) {
		orchestrator.subscribe((event) => {
			process.stderr.write(`[debug] ${shortJson(event, 600)}\n`);
		});
	}
	orchestrator.subscribe(renderEvent);

	const { agentId } = await orchestrator.spawnAgentHarness();

	writeLine(`[cli] cwd=${runtime.services.cwd}`);
	writeLine(`[cli] type a prompt, or /<command>; .exit quits`);

	for (;;) {
		const line = await lines.next("> ");
		if (line === undefined) break; // stdin closed
		const input = line.trim();
		if (input === "") continue;
		if (input === ".exit") break;
		try {
			await orchestrator.inputAgent(agentId, input);
		} catch (error) {
			writeLine(`[error] ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	await orchestrator.disposeAll("cli exit");
	process.exit(0);
}

main().catch((error) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : error);
	process.exit(1);
});
