/**
 * RPC mode as a subprocess: the only place several of the protocol's claims can
 * be tested at all.
 *
 * `ready` being the first byte on the pipe, stdout carrying nothing but frames,
 * the process actually ending - none of those are properties of `RpcServer`, so
 * no unit test can reach them. Each test here asserts something that needs a
 * real process, a real pipe and a real config directory; anything that does not
 * need those belongs in `server.test.ts`.
 *
 * The model is a local HTTP server speaking the OpenAI completions wire format.
 * That keeps a real provider round trip in the test without a network or a key,
 * and it is the only way `prompt` gets exercised end to end.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcInbound, RpcOutbound, RpcResponseFrame } from "../../src/rpc/types.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tsx = resolve(appDir, "../../node_modules/.bin/tsx");

/** Boot is a TypeScript transpile plus a full runtime; give it room. */
const TEST_TIMEOUT_MS = 90_000;

interface FakeProvider {
	readonly baseUrl: string;
	readonly requestCount: () => number;
	close(): Promise<void>;
}

/**
 * An OpenAI-completions endpoint. `respond` writes the SSE body; a handler that
 * never writes leaves the request hanging, which is how the deadline is tested.
 */
async function startFakeProvider(respond: (res: ServerResponse, body: string) => void): Promise<FakeProvider> {
	let requests = 0;
	const open = new Set<ServerResponse>();
	const server: Server = createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			body += chunk;
		});
		req.on("end", () => {
			requests += 1;
			open.add(res);
			res.on("close", () => open.delete(res));
			res.writeHead(200, { "content-type": "text/event-stream" });
			respond(res, body);
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Fake provider did not bind a port.");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requestCount: () => requests,
		close: async () => {
			for (const res of open) res.destroy();
			await new Promise<void>((done) => server.close(() => done()));
		},
	};
}

function sseChunk(payload: Record<string, unknown>): string {
	return `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "e2e-model", ...payload })}\n\n`;
}

const USAGE_CHUNK = { choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } };

function finishWithText(res: ServerResponse, text: string): void {
	res.write(sseChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
	res.write(sseChunk({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
	res.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
	res.write(sseChunk(USAGE_CHUNK));
	res.write("data: [DONE]\n\n");
	res.end();
}

function finishWithToolCall(res: ServerResponse, name: string, args: unknown): void {
	const call = { index: 0, id: "call_1", type: "function", function: { name, arguments: "" } };
	res.write(
		sseChunk({
			choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: null }],
		}),
	);
	res.write(
		sseChunk({
			choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }],
		}),
	);
	res.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
	res.write(sseChunk(USAGE_CHUNK));
	res.write("data: [DONE]\n\n");
	res.end();
}

/** A complete streamed reply: two content deltas, a stop, and usage. */
function replyWith(text: string): (res: ServerResponse) => void {
	return (res) => finishWithText(res, text);
}

const SUBAGENT_TASK = "SUBAGENT-TASK compute the answer";
const SUBAGENT_REPORT = "SUBAGENT-REPORT-42";
const ROOT_REPLY = "ROOT-SPOKE";

/**
 * A model that delegates once and then talks.
 *
 * It tells the two agents apart by their first user message, which is the RPC
 * prompt for the root and the delegated task for the subagent. `subagentDelayMs`
 * is what makes the test deterministic: the subagent must report *after* the
 * root's own run has ended, or the report folds into that run instead.
 */
function delegatingModel(subagentDelayMs: number): (res: ServerResponse, body: string) => void {
	return (res, body) => {
		const { messages } = JSON.parse(body) as { readonly messages: readonly { readonly role: string }[] };
		const firstUser = messages.find((message) => message.role === "user");
		if (JSON.stringify(firstUser ?? "").includes(SUBAGENT_TASK)) {
			setTimeout(() => finishWithText(res, SUBAGENT_REPORT), subagentDelayMs);
			return;
		}
		if (!messages.some((message) => message.role === "tool")) {
			finishWithToolCall(res, "spawn_agent", { agents: [{ profile: "e2e", task: SUBAGENT_TASK }] });
			return;
		}
		finishWithText(res, ROOT_REPLY);
	};
}

/**
 * A self-contained agent directory. Trust is granted outright and the extension
 * set is empty by default, so nothing here depends on the developer's own
 * `~/.widi` or on this repository's.
 */
async function createAgentDir(
	baseUrl: string,
	options: { readonly noisyExtension?: boolean; readonly echoExtension?: boolean } = {},
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "widi-rpc-e2e-"));
	const agentDir = join(root, "agentdir");
	await mkdir(join(agentDir, "agent"), { recursive: true });
	await mkdir(join(agentDir, "profiles"), { recursive: true });
	await mkdir(join(root, "work"), { recursive: true });

	await writeFile(
		join(agentDir, "agent", "models.json"),
		JSON.stringify({
			providers: {
				e2e: {
					name: "e2e",
					baseUrl,
					api: "openai-completions",
					apiKey: "test-key",
					// The context window has to clear the compaction reserve (16384 by
					// default) with room to spare. Below it, every settle triggers a
					// compaction, and each of those is another provider call - which is
					// exactly the "one prompt made two requests" mystery this fixture
					// created for itself.
					models: [{ id: "e2e-model", name: "E2E Model", reasoning: false, contextWindow: 200_000, maxTokens: 1024 }],
				},
			},
		}),
	);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "e2e",
			defaultModel: "e2e-model",
			defaultProfile: "e2e",
			enabledProfiles: ["e2e"],
			enabledModels: ["e2e/*"],
			enabledExtensions: [...(options.noisyExtension ? ["noisy"] : []), ...(options.echoExtension ? ["echo"] : [])],
			defaultProjectTrust: "always",
			quietStartup: true,
			retry: { enabled: false },
		}),
	);
	await writeFile(
		join(agentDir, "profiles", "e2e.md"),
		"---\nid: e2e\nlabel: E2E Agent\npersist: true\n---\nYou are a test agent.\n",
	);

	if (options.noisyExtension) {
		await mkdir(join(agentDir, "extensions", "noisy"), { recursive: true });
		await writeFile(
			join(agentDir, "extensions", "noisy", "index.ts"),
			[
				'console.log("noisy extension speaking at load");',
				"export default {",
				"\tapiVersion: 1,",
				'\tactivate: () => { console.log("noisy extension speaking at activate"); },',
				"};",
				"",
			].join("\n"),
		);
	}

	if (options.echoExtension) {
		await mkdir(join(agentDir, "extensions", "echo"), { recursive: true });
		await writeFile(
			join(agentDir, "extensions", "echo", "index.ts"),
			[
				"export default {",
				"\tapiVersion: 1,",
				"\tactivate: (api) => {",
				'\t\tapi.onExtensionEvent("driver:run", async (event, context) => {',
				'\t\t\tawait context.actions.emitExtensionEvent("echo:done", { saw: event.payload });',
				"\t\t});",
				"\t},",
				"};",
				"",
			].join("\n"),
		);
	}
	return root;
}

class RpcProcess {
	readonly frames: RpcOutbound[] = [];
	readonly lines: string[] = [];
	stderr = "";
	exitCode: number | null = null;

	private readonly _child: ChildProcessWithoutNullStreams;
	private readonly _exited: Promise<number | null>;
	private _buffer = "";

	constructor(root: string, args: readonly string[]) {
		this._child = spawn(
			tsx,
			[
				"--tsconfig",
				"tsconfig.json",
				"src/cli.ts",
				"--mode",
				"rpc",
				"--cwd",
				join(root, "work"),
				"--agent-dir",
				join(root, "agentdir"),
				"--profile",
				"e2e",
				...args,
			],
			// Spawned from the app directory so `--tsconfig` and the module graph
			// resolve; the agent's own working directory is the `--cwd` flag's job.
			{ cwd: appDir, stdio: ["pipe", "pipe", "pipe"] },
		);
		this._child.stdout.setEncoding("utf8");
		this._child.stdout.on("data", (chunk: string) => this._absorb(chunk));
		this._child.stderr.setEncoding("utf8");
		this._child.stderr.on("data", (chunk: string) => {
			this.stderr += chunk;
		});
		this._exited = new Promise((done) => {
			this._child.on("exit", (code) => {
				this.exitCode = code;
				done(code);
			});
		});
	}

	send(frame: RpcInbound): void {
		this.sendRaw(JSON.stringify(frame));
	}

	/** For frames the protocol types would not let a test construct. */
	sendRaw(line: string): void {
		this._child.stdin.write(`${line}\n`);
	}

	closeInput(): void {
		this._child.stdin.end();
	}

	/** The first frame matching, waiting for it to arrive. */
	async waitFor<T extends RpcOutbound>(match: (frame: RpcOutbound) => frame is T): Promise<T>;
	async waitFor(match: (frame: RpcOutbound) => boolean): Promise<RpcOutbound>;
	async waitFor(match: (frame: RpcOutbound) => boolean): Promise<RpcOutbound> {
		const deadline = Date.now() + TEST_TIMEOUT_MS - 5_000;
		while (Date.now() < deadline) {
			const found = this.frames.find(match);
			if (found) return found;
			if (this.exitCode !== null) throw new Error(`Process exited (${this.exitCode}) before the frame arrived.`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error("Timed out waiting for a frame.");
	}

	async waitForExit(): Promise<number | null> {
		return await this._exited;
	}

	async kill(): Promise<void> {
		if (this.exitCode === null) this._child.kill("SIGKILL");
		await this._exited;
	}

	private _absorb(chunk: string): void {
		this._buffer += chunk;
		for (;;) {
			const newline = this._buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this._buffer.slice(0, newline).trim();
			this._buffer = this._buffer.slice(newline + 1);
			if (line.length === 0) continue;
			this.lines.push(line);
			this.frames.push(JSON.parse(line) as RpcOutbound);
		}
	}
}

function responseTo(id: string): (frame: RpcOutbound) => frame is RpcResponseFrame {
	return (frame): frame is RpcResponseFrame => frame.type === "response" && frame.id === id;
}

/** Every frame carrying this text, by position in the stream. */
function indicesOfText(frames: readonly RpcOutbound[], text: string): number[] {
	const found: number[] = [];
	frames.forEach((frame, index) => {
		if (frame.type === "event" && JSON.stringify(frame.event).includes(text)) found.push(index);
	});
	return found;
}

describe("widi --mode rpc as a subprocess", () => {
	let running: RpcProcess | undefined;
	let provider: FakeProvider | undefined;
	let root: string | undefined;

	afterEach(async () => {
		await running?.kill();
		await provider?.close();
		if (root) await rm(root, { recursive: true, force: true });
		running = undefined;
		provider = undefined;
		root = undefined;
	});

	it(
		"answers piped commands and exits once the input ends",
		async () => {
			provider = await startFakeProvider(replyWith("unused"));
			root = await createAgentDir(provider.baseUrl);
			running = new RpcProcess(root, ["--no-root"]);

			// Written before anything could have read `ready`, which is the case the
			// hold-until-ready queue exists for. EOF follows immediately, and must not
			// be read as "stop now" - both commands still have to run.
			running.send({ id: "1", cmd: "spawn", origin: { kind: "new" } });
			running.send({ id: "2", cmd: "list_agents" });
			// Validation reaches the wire, not just `parseInbound`'s own tests: this
			// frame would have been cast straight through before.
			running.sendRaw('{"id":"3","cmd":"send","agentId":"a","body":"x","mode":"preced"}');
			running.closeInput();

			expect(await running.waitForExit()).toBe(0);
			expect(running.frames[0]?.type).toBe("ready");
			const spawned = running.frames.find(responseTo("1"));
			const listed = running.frames.find(responseTo("2"));
			const refused = running.frames.find(responseTo("3"));
			expect(spawned?.ok).toBe(true);
			expect(listed?.ok).toBe(true);
			expect(refused?.ok).toBe(false);
			expect(refused?.ok === false && refused.code).toBe("invalid_command");
			expect(refused?.ok === false && refused.error).toContain("/mode");
			expect(running.stderr).toBe("");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps extension output off the protocol stream",
		async () => {
			provider = await startFakeProvider(replyWith("unused"));
			root = await createAgentDir(provider.baseUrl, { noisyExtension: true });
			// With a root agent: the core half activates once per agent runtime, so
			// `--no-root` would never reach the noisier of the two writes.
			running = new RpcProcess(root, []);

			running.send({ id: "1", cmd: "list_agents" });
			running.closeInput();
			expect(await running.waitForExit()).toBe(0);

			// The claim in section 7.1, which nothing short of a real process can
			// check: an extension's console.log is on the same descriptor as the
			// protocol, and one unredirected line would split a frame in half.
			expect(running.stderr).toContain("noisy extension speaking at load");
			expect(running.stderr).toContain("noisy extension speaking at activate");
			for (const line of running.lines) expect(() => JSON.parse(line)).not.toThrow();
			expect(running.frames[0]?.type).toBe("ready");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"runs a prompt against a real provider and streams it without the accumulations",
		async () => {
			provider = await startFakeProvider(replyWith("Hello from e2e."));
			root = await createAgentDir(provider.baseUrl);
			running = new RpcProcess(root, []);

			const ready = await running.waitFor((frame) => frame.type === "ready");
			if (ready.type !== "ready" || ready.rootAgentId === undefined) throw new Error("no root agent");
			running.send({ id: "p", cmd: "prompt", agentId: ready.rootAgentId, body: "say hi", deadlineMs: 60_000 });

			const answer = await running.waitFor(responseTo("p"));
			if (!answer.ok || answer.cmd !== "prompt") throw new Error(`prompt failed: ${JSON.stringify(answer)}`);
			if (answer.data.kind !== "completed") throw new Error("prompt was blocked");
			expect(answer.data.message.content).toEqual([{ type: "text", text: "Hello from e2e." }]);
			expect(answer.data.message.usage?.totalTokens).toBe(15);
			// One turn, one provider call. Worth pinning: maintenance work makes its
			// own calls, and a silent extra one is a cost a benchmark would misattribute
			// to the turn it followed.
			expect(provider.requestCount()).toBe(1);

			// Section 5 checked on a real stream rather than a synthesized event: the
			// deltas arrived, and neither accumulation rode along with them.
			const updates = running.frames.filter(
				(frame) =>
					frame.type === "event" &&
					frame.event.type === "agent_harness_event" &&
					frame.event.event.type === "message_update",
			);
			expect(updates.length).toBeGreaterThan(0);
			for (const frame of updates) {
				const inner = JSON.parse(JSON.stringify(frame)) as { event: { event: Record<string, unknown> } };
				expect(inner.event.event).not.toHaveProperty("message");
				expect(inner.event.event.assistantMessageEvent).not.toHaveProperty("partial");
			}

			running.send({ id: "s", cmd: "shutdown" });
			expect(await running.waitForExit()).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"times out a prompt the provider never answers, then shuts down with the client still attached",
		async () => {
			// Never writes a body: the run hangs until its deadline.
			provider = await startFakeProvider(() => {});
			root = await createAgentDir(provider.baseUrl);
			running = new RpcProcess(root, []);

			const ready = await running.waitFor((frame) => frame.type === "ready");
			if (ready.type !== "ready" || ready.rootAgentId === undefined) throw new Error("no root agent");
			running.send({ id: "p", cmd: "prompt", agentId: ready.rootAgentId, body: "say hi", deadlineMs: 2_000 });

			const answer = await running.waitFor(responseTo("p"));
			if (answer.ok) throw new Error("expected a timeout");
			expect(answer.code).toBe("timeout");

			// stdin is still open here, as it is for any interactive client. `shutdown`
			// has to end the process on its own; waiting for the pipe to close would
			// strand a batch runner that keeps its end open between samples.
			running.send({ id: "s", cmd: "shutdown" });
			expect(await running.waitForExit()).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"lets agents collaborate, and answers the prompt before that collaboration finishes",
		async () => {
			// Three seconds is not a timing margin, it is the point: the subagent must
			// still be working when the root's own run ends.
			provider = await startFakeProvider(delegatingModel(3_000));
			root = await createAgentDir(provider.baseUrl);
			running = new RpcProcess(root, []);

			const ready = await running.waitFor((frame) => frame.type === "ready");
			if (ready.type !== "ready" || ready.rootAgentId === undefined) throw new Error("no root agent");
			const rootAgentId = ready.rootAgentId;
			running.send({ id: "p", cmd: "prompt", agentId: rootAgentId, body: "delegate the work", deadlineMs: 60_000 });

			const process = running;
			const answer = await process.waitFor(responseTo("p"));
			if (!answer.ok || answer.cmd !== "prompt") throw new Error(`prompt failed: ${JSON.stringify(answer)}`);
			const answeredAt = process.frames.indexOf(answer);

			// The agent tools work under RPC exactly as they do under the TUI: they are
			// bound to `AgentToOrchestratorHost`, which knows nothing about front ends.
			// One `agent_spawned`, not two: the root was created before the client
			// registered, which is the whole of section 5.3.
			const spawned = process.frames.filter((frame) => frame.type === "event" && frame.event.type === "agent_spawned");
			expect(spawned.length).toBe(1);
			// Delivered through the agent binding, so it arrives attributed - which the
			// human binding an RPC client sends through would not do.
			expect(indicesOfText(process.frames, `[Message from ${rootAgentId}]`).length).toBeGreaterThan(0);

			// The finding this test exists for. `prompt` resolves when the *root's run*
			// ends, and the root ends its run to wait for the subagent it delegated to.
			// So a driver that treats the prompt answer as "this sample is done" cuts
			// the collaboration off mid-flight - and worse, only sometimes: a subagent
			// that finishes first folds its report into the root's run and the same
			// driver looks correct.
			expect(indicesOfText(process.frames, SUBAGENT_REPORT).every((index) => index > answeredAt)).toBe(true);

			// The tree carries on regardless: the subagent reports, and the watch
			// notification wakes the root into a second run.
			await process.waitFor((frame) => frame.type === "event" && JSON.stringify(frame.event).includes(SUBAGENT_REPORT));
			await process.waitFor(
				(frame) => indicesOfText([frame], ROOT_REPLY).length > 0 && process.frames.indexOf(frame) > answeredAt,
			);

			process.send({ id: "s", cmd: "shutdown" });
			expect(await process.waitForExit()).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"waits out the whole delegation tree, which the prompt answer does not",
		async () => {
			provider = await startFakeProvider(delegatingModel(3_000));
			root = await createAgentDir(provider.baseUrl);
			running = new RpcProcess(root, []);

			const ready = await running.waitFor((frame) => frame.type === "ready");
			if (ready.type !== "ready" || ready.rootAgentId === undefined) throw new Error("no root agent");
			const rootAgentId = ready.rootAgentId;
			const process = running;
			process.send({ id: "p", cmd: "prompt", agentId: rootAgentId, body: "delegate the work", deadlineMs: 60_000 });

			// What a batch runner does instead of trusting the prompt answer: ask when
			// the tree stopped, not when the agent it addressed did.
			const prompted = await process.waitFor(responseTo("p"));
			expect(prompted.ok).toBe(true);
			process.send({ id: "t", cmd: "wait_tree_idle", agentId: rootAgentId, deadlineMs: 60_000 });

			const settled = await process.waitFor(responseTo("t"));
			if (!settled.ok || settled.cmd !== "wait_tree_idle") throw new Error(`wait failed: ${JSON.stringify(settled)}`);
			// Root and subagent, both still live.
			expect(settled.data.agentIds).toContain(rootAgentId);
			expect(settled.data.agentIds.length).toBe(2);

			// The sample boundary the prompt answer got wrong: everything the tree
			// produced is behind this frame, including the root's second run.
			const settledAt = process.frames.indexOf(settled);
			const reports = indicesOfText(process.frames, SUBAGENT_REPORT);
			const replies = indicesOfText(process.frames, ROOT_REPLY);
			expect(reports.length).toBeGreaterThan(0);
			expect(Math.max(...reports)).toBeLessThan(settledAt);
			expect(replies.length).toBeGreaterThan(1);
			expect(Math.max(...replies)).toBeLessThan(settledAt);

			// The accounting, against ground truth the fake provider counted itself.
			// This is the only place that can check it: `RunAccounting`'s own tests
			// feed it events, and events are exactly what could be wrong.
			process.send({ id: "m", cmd: "run_summary" });
			const summary = await process.waitFor(responseTo("m"));
			if (!summary.ok || summary.cmd !== "run_summary") throw new Error(`summary failed: ${JSON.stringify(summary)}`);
			const { total, agents } = summary.data;
			expect(total.providerResponses).toBe(provider.requestCount());
			// Root's tool-call turn, root's reply to the tool result, the subagent's
			// report, and the root's second run after the report woke it.
			expect(total.turns).toBe(4);
			expect(total.turnUsage.totalTokens).toBe(4 * 15);
			expect(total.tools.byName.spawn_agent).toBe(1);
			expect(total.maintenance.compactions).toBe(0);
			expect(total.humanRequests).toBe(0);
			expect(agents.map((agent) => agent.agentId).sort()).toEqual(settled.data.agentIds.slice().sort());
			// Both ran, so agent-time exceeds neither nothing nor the run's own clock
			// by accident: the point is that the phases were actually observed.
			expect(total.phaseMs.turn).toBeGreaterThan(0);

			process.send({ id: "s", cmd: "shutdown" });
			expect(await process.waitForExit()).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"carries a client's extension event to a loaded extension and its answer back",
		async () => {
			provider = await startFakeProvider(replyWith("unused"));
			root = await createAgentDir(provider.baseUrl, { echoExtension: true });
			running = new RpcProcess(root, []);

			const ready = await running.waitFor((frame) => frame.type === "ready");
			if (ready.type !== "ready" || ready.rootAgentId === undefined) throw new Error("no root agent");
			running.send({
				id: "e",
				cmd: "emit_extension_event",
				agentId: ready.rootAgentId,
				extensionId: "driver",
				name: "driver:run",
				payload: { sample: 7 },
			});

			// Both directions, which is the whole point of the pair: the client's own
			// event comes back to it exactly as it reaches a runner, and the extension
			// that handled it answers on the same bus.
			const echoed = await running.waitFor(
				(frame) => frame.type === "extension_event" && frame.event.name === "driver:run",
			);
			if (echoed.type !== "extension_event") throw new Error("not an extension event");
			expect(echoed.event).toMatchObject({ sourceExtensionId: "driver", sourceAgentId: ready.rootAgentId });

			const answered = await running.waitFor(
				(frame) => frame.type === "extension_event" && frame.event.name === "echo:done",
			);
			if (answered.type !== "extension_event") throw new Error("not an extension event");
			expect(answered.event).toMatchObject({ sourceExtensionId: "echo", payload: { saw: { sample: 7 } } });

			running.send({ id: "s", cmd: "shutdown" });
			expect(await running.waitForExit()).toBe(0);
			expect(running.stderr).toBe("");
		},
		TEST_TIMEOUT_MS,
	);
});
