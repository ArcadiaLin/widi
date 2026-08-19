import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliParseEnvironment, type CliParseResult, type EntryMode, parseCliArgs } from "../../src/cli/args.ts";

const SHELL_CWD = "/shell";

const TTY: CliParseEnvironment = { cwd: SHELL_CWD, stdinIsTty: true, stdoutIsTty: true };

function parse(argv: readonly string[], env: CliParseEnvironment = TTY): CliParseResult {
	return parseCliArgs(argv, env);
}

function run(argv: readonly string[], env: CliParseEnvironment = TTY) {
	const result = parse(argv, env);
	if (result.kind !== "run") throw new Error(`Expected a run, got ${result.kind}`);
	return result.invocation;
}

function usageError(argv: readonly string[], env: CliParseEnvironment = TTY): string {
	const result = parse(argv, env);
	if (result.kind !== "usage-error") throw new Error(`Expected a usage error, got ${result.kind}`);
	return result.message;
}

function forMode(mode: EntryMode, argv: readonly string[]) {
	return run(mode === "tui" ? argv : ["--mode", mode, ...argv]);
}

describe("mode selection", () => {
	it("defaults to the tui on a terminal", () => {
		expect(run([]).mode).toBe("tui");
	});

	it("downgrades to print when stdin is not a terminal", () => {
		expect(run([], { ...TTY, stdinIsTty: false }).mode).toBe("print");
	});

	it("downgrades to print when stdout is not a terminal", () => {
		expect(run(["hello"], { ...TTY, stdoutIsTty: false }).mode).toBe("print");
	});

	it("keeps an explicit mode over the downgrade", () => {
		expect(run(["--mode", "tui"], { ...TTY, stdinIsTty: false }).mode).toBe("tui");
	});

	it("refuses an unknown mode", () => {
		expect(usageError(["--mode", "repl"])).toContain("Unknown mode: repl");
	});

	it("refuses a missing mode value", () => {
		expect(usageError(["--mode"])).toBe("Missing value for --mode");
	});

	it("refuses an unknown flag", () => {
		expect(usageError(["--wat"])).toBe("Unknown argument: --wat");
	});

	it("refuses -p together with another mode", () => {
		expect(usageError(["-p", "--mode", "rpc"])).toContain("Conflicting modes");
	});
});

describe("-p prompt capture", () => {
	it("eats a following bare token", () => {
		const invocation = run(["-p", "fix the bug"]);
		expect(invocation.mode).toBe("print");
		if (invocation.mode !== "print") return;
		expect(invocation.options.prompts).toEqual(["fix the bug"]);
	});

	it("leaves a following flag alone", () => {
		const invocation = run(["-p", "--output", "json", "go"]);
		if (invocation.mode !== "print") throw new Error("expected print");
		expect(invocation.options.output).toBe("json");
		expect(invocation.options.prompts).toEqual(["go"]);
	});

	it("leaves a following @file alone", () => {
		const invocation = run(["-p", "@spec.md"]);
		if (invocation.mode !== "print") throw new Error("expected print");
		expect(invocation.options.prompts).toEqual([]);
		expect(invocation.options.fileArgs).toEqual(["spec.md"]);
	});

	it("accepts a trailing -p with nothing after it when stdin is piped", () => {
		const invocation = run(["-p"], { ...TTY, stdinIsTty: false });
		if (invocation.mode !== "print") throw new Error("expected print");
		expect(invocation.options.prompts).toEqual([]);
	});
});

describe("runtime flags", () => {
	it("resolves directory flags against the shell cwd", () => {
		const invocation = run(["--cwd", "work", "--agent-dir", "cfg", "--session-root", "s", "-e", "ext"]);
		expect(invocation.options.cwd).toBe(resolve(SHELL_CWD, "work"));
		expect(invocation.options.agentDir).toBe(resolve(SHELL_CWD, "cfg"));
		expect(invocation.options.sessionRoot).toBe(resolve(SHELL_CWD, "s"));
		expect(invocation.options.extensionPaths).toEqual([resolve(SHELL_CWD, "ext")]);
	});

	it("collects repeated --extension in order", () => {
		const invocation = run(["--extension", "/a", "-e", "/b"]);
		expect(invocation.options.extensionPaths).toEqual(["/a", "/b"]);
	});

	it("maps --approve and --no-approve to the trust override", () => {
		expect(run(["--approve"]).options.trustOverride).toBe(true);
		expect(run(["--no-approve"]).options.trustOverride).toBe(false);
		expect(run([]).options.trustOverride).toBeUndefined();
	});

	it("maps both spellings of the extension escape hatch", () => {
		expect(run(["--no-extensions"]).options.noExtensions).toBe(true);
		expect(run(["-ne"]).options.noExtensions).toBe(true);
		expect(run([]).options.noExtensions).toBe(false);
	});

	it("splits --profiles on commas", () => {
		expect(run(["--profiles", "a, b ,c"]).options.enabledProfileIds).toEqual(["a", "b", "c"]);
	});

	it("refuses an empty --profiles list", () => {
		expect(usageError(["--profiles", " , "])).toContain("comma-separated");
	});

	it("takes --profile and --model and --thinking", () => {
		const invocation = run(["--profile", "dev", "--model", "moonshot/kimi-k2", "--thinking", "high"]);
		expect(invocation.options.profileId).toBe("dev");
		expect(invocation.options.model).toBe("moonshot/kimi-k2");
		expect(invocation.options.thinkingLevel).toBe("high");
	});

	it("checks only the shape of --model", () => {
		expect(usageError(["--model", "kimi-k2"])).toContain("provider/id");
		expect(usageError(["--model", "/kimi-k2"])).toContain("provider/id");
		expect(usageError(["--model", "moonshot/"])).toContain("provider/id");
		expect(run(["--model", "vllm/some/nested/id"]).options.model).toBe("vllm/some/nested/id");
	});

	it("refuses an unknown thinking level", () => {
		expect(usageError(["--thinking", "deep"])).toContain("--thinking expects one of");
	});

	it("refuses a missing value for every value-taking runtime flag", () => {
		for (const flag of [
			"--cwd",
			"--agent-dir",
			"--profile",
			"--profiles",
			"--model",
			"--thinking",
			"--session-root",
			"-e",
		]) {
			expect(usageError([flag])).toBe(`Missing value for ${flag}`);
		}
	});
});

describe("mode ownership", () => {
	it("refuses rpc flags outside rpc", () => {
		expect(usageError(["--no-root"])).toBe("--no-root is only valid with --mode rpc");
		expect(usageError(["--mode", "print", "--human-timeout", "50", "go"])).toBe(
			"--human-timeout is only valid with --mode rpc",
		);
	});

	it("accepts rpc flags in rpc", () => {
		const invocation = run(["--mode", "rpc", "--no-root", "--human-timeout", "500"]);
		if (invocation.mode !== "rpc") throw new Error("expected rpc");
		expect(invocation.options.noRoot).toBe(true);
		expect(invocation.options.humanTimeoutMs).toBe(500);
	});

	it("refuses print flags outside print", () => {
		expect(usageError(["--mode", "rpc", "--output", "json"])).toBe("--output is only valid with --mode print");
		expect(usageError(["--deadline", "10"])).toBe("--deadline is only valid with --mode print");
		expect(usageError(["--mode", "rpc", "--quiet-ms", "10"])).toBe("--quiet-ms is only valid with --mode print");
		expect(usageError(["--mode", "tui", "--emit", '{"name":"x"}'])).toBe("--emit is only valid with --mode print");
	});

	it("refuses positional prompts outside print", () => {
		expect(usageError(["hello"])).toContain("only valid with --mode print");
		expect(usageError(["--mode", "rpc", "@spec.md"])).toContain("only valid with --mode print");
	});

	it("lets every shared flag through in every mode", () => {
		const shared = ["--profile", "dev", "--model", "vllm/local", "--thinking", "low", "--approve", "-ne"];
		for (const mode of ["tui", "rpc", "print"] as const) {
			const invocation = forMode(mode, mode === "print" ? [...shared, "go"] : shared);
			expect(invocation.options.profileId).toBe("dev");
			expect(invocation.options.model).toBe("vllm/local");
			expect(invocation.options.thinkingLevel).toBe("low");
			expect(invocation.options.trustOverride).toBe(true);
			expect(invocation.options.noExtensions).toBe(true);
		}
	});
});

describe("print positionals", () => {
	it("splits bare arguments from @files, keeping order", () => {
		const invocation = run(["-p", "first", "@a.md", "second", "@b.md"]);
		if (invocation.mode !== "print") throw new Error("expected print");
		expect(invocation.options.prompts).toEqual(["first", "second"]);
		expect(invocation.options.fileArgs).toEqual(["a.md", "b.md"]);
	});

	it("defaults --output to text and takes json", () => {
		expect(forMode("print", ["go"]).mode).toBe("print");
		const text = run(["-p", "go"]);
		if (text.mode !== "print") throw new Error("expected print");
		expect(text.options.output).toBe("text");
		const json = run(["-p", "go", "--output", "json"]);
		if (json.mode !== "print") throw new Error("expected print");
		expect(json.options.output).toBe("json");
	});

	it("refuses an unknown --output format", () => {
		expect(usageError(["-p", "go", "--output", "yaml"])).toContain("--output expects");
	});

	it("takes millisecond budgets", () => {
		const invocation = run(["-p", "go", "--deadline", "60000", "--quiet-ms", "0"]);
		if (invocation.mode !== "print") throw new Error("expected print");
		expect(invocation.options.deadlineMs).toBe(60_000);
		expect(invocation.options.quietMs).toBe(0);
	});

	it("refuses a non-positive deadline and a negative quiet window", () => {
		expect(usageError(["-p", "go", "--deadline", "0"])).toContain("positive whole number");
		expect(usageError(["-p", "go", "--quiet-ms", "-1"])).toContain("whole number");
		expect(usageError(["-p", "go", "--deadline", "1.5"])).toContain("positive whole number");
	});

	it("needs something to do", () => {
		expect(usageError(["-p"])).toContain("Print mode needs");
		expect(usageError(["--mode", "print"])).toContain("Print mode needs");
	});

	it("treats piped stdin as something to do", () => {
		expect(run(["--mode", "print"], { ...TTY, stdinIsTty: false }).mode).toBe("print");
	});
});

describe("--emit", () => {
	it("keeps repeated events in order and passes the payload through", () => {
		const invocation = run([
			"-p",
			"--emit",
			'{"name":"bus:start","payload":{"id":1}}',
			"--emit",
			'{"name":"bus:stop"}',
		]);
		if (invocation.mode !== "print") throw new Error("expected print");
		expect(invocation.options.emit).toEqual([{ name: "bus:start", payload: { id: 1 } }, { name: "bus:stop" }]);
	});

	it("is enough on its own, with no prompt", () => {
		const invocation = run(["-p", "--emit", '{"name":"bus:start"}']);
		if (invocation.mode !== "print") throw new Error("expected print");
		expect(invocation.options.prompts).toEqual([]);
		expect(invocation.options.emit).toHaveLength(1);
	});

	it("names the offending occurrence and quotes the parser", () => {
		const message = usageError(["-p", "--emit", '{"name":"a"}', "--emit", "{oops"]);
		expect(message).toContain("--emit #2 is not valid JSON:");
		expect(message.length).toBeGreaterThan("--emit #2 is not valid JSON:".length);
	});

	it("refuses anything but an object with a non-empty event", () => {
		expect(usageError(["-p", "--emit", "[1]"])).toContain("must be a JSON object");
		expect(usageError(["-p", "--emit", '"x"'])).toContain("must be a JSON object");
		expect(usageError(["-p", "--emit", "null"])).toContain("must be a JSON object");
		expect(usageError(["-p", "--emit", "{}"])).toContain('needs a non-empty string "name"');
		expect(usageError(["-p", "--emit", '{"name":"  "}'])).toContain('needs a non-empty string "name"');
		expect(usageError(["-p", "--emit", '{"name":7}'])).toContain('needs a non-empty string "name"');
	});

	it("refuses a missing value", () => {
		expect(usageError(["-p", "go", "--emit"])).toBe("Missing value for --emit");
	});
});

describe("help and version", () => {
	it("wins over everything else on the line", () => {
		expect(parse(["--help"]).kind).toBe("help");
		expect(parse(["-h"]).kind).toBe("help");
		expect(parse(["--no-root", "-h"]).kind).toBe("help");
		expect(parse(["--version"]).kind).toBe("version");
		expect(parse(["-v"]).kind).toBe("version");
	});
});
