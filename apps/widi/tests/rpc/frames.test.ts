import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseInbound } from "../../src/rpc/frames.ts";
import {
	buildRpcInboundJsonSchema,
	RPC_SCHEMA_FILENAME,
	serializeRpcInboundJsonSchema,
} from "../../src/rpc/json-schema.ts";
import { RPC_COMMAND_SCHEMAS } from "../../src/rpc/schema.ts";

/** The message for a frame that should not have been accepted. */
function rejection(line: string): string {
	const parsed = parseInbound(line);
	if (parsed.kind !== "invalid") throw new Error(`Expected a rejection, got ${parsed.kind}: ${line}`);
	return parsed.message;
}

function accept(line: string): void {
	const parsed = parseInbound(line);
	if (parsed.kind === "invalid") throw new Error(`Expected acceptance, got: ${parsed.message}`);
}

describe("inbound validation", () => {
	it("refuses a mode that is not one, and says which are", () => {
		// The reason this file exists. `decideMessageDelivery` has no case for an
		// unknown mode, so before validation a typo here reached an idle agent as an
		// ordinary delivery and started a whole turn - silently, and only sometimes.
		expect(rejection('{"cmd":"send","agentId":"a","body":"x","mode":"preced"}')).toBe(
			'Invalid send frame at /mode: must be one of "next_turn", "interrupt", "precede".',
		);
	});

	it("refuses a misspelled optional field rather than ignoring it", () => {
		// A dropped `deadlineMs` is a sample that waits forever, and nothing about
		// the frame or the answer would have said so.
		expect(rejection('{"cmd":"prompt","agentId":"a","body":"x","deadlinems":5000}')).toBe(
			"Invalid prompt frame: unknown property: deadlinems.",
		);
	});

	it("names the path inside a nested value", () => {
		expect(rejection('{"cmd":"spawn","origin":{"kind":"neww"}}')).toBe(
			'Invalid spawn frame at /origin/kind: must be one of "new", "resume", "fork".',
		);
		expect(rejection('{"cmd":"prompt","agentId":"a","body":"x","images":[{"type":"image","data":"z"}]}')).toContain(
			"/images/0",
		);
	});

	it("checks the constrained scalars", () => {
		expect(rejection('{"cmd":"prompt","agentId":"a","body":"x","deadlineMs":0}')).toContain("/deadlineMs");
		expect(rejection('{"cmd":"prompt","agentId":"","body":"x"}')).toContain("/agentId");
		expect(rejection('{"cmd":"set_model","agentId":"a","model":"no-slash"}')).toContain("/model");
		expect(rejection('{"cmd":"set_thinking_level","agentId":"a","level":"ultra"}')).toContain("/level");
		expect(rejection('{"cmd":"list_agents","id":1}')).toContain("/id");
	});

	it("carries the id and cmd back out of a refusal", () => {
		// A refusal that cannot be correlated tells a client with several commands
		// in flight only that one of them was wrong.
		const parsed = parseInbound('{"id":"7","cmd":"prompt","agentId":"a"}');
		if (parsed.kind !== "invalid") throw new Error("expected a rejection");
		expect(parsed.id).toBe("7");
		expect(parsed.cmd).toBe("prompt");

		// Nothing usable to echo: not JSON at all, and no command it could answer under.
		const unusable = parseInbound("{oops");
		if (unusable.kind !== "invalid") throw new Error("expected a rejection");
		expect(unusable.id).toBeUndefined();
		expect(unusable.cmd).toBeUndefined();
	});

	it("names an unknown command instead of validating it against nothing", () => {
		expect(rejection('{"cmd":"bogus"}')).toBe("Unknown command: bogus");
		expect(rejection('{"id":"1"}')).toContain("must carry a string `cmd`");
		expect(rejection("not json")).toContain("Malformed JSON");
		expect(rejection("[]")).toBe("A frame must be a JSON object.");
	});

	it("accepts the shapes a client actually sends", () => {
		accept('{"cmd":"list_agents"}');
		accept('{"id":"1","cmd":"spawn","origin":{"kind":"new"}}');
		accept('{"cmd":"spawn","origin":{"kind":"fork","sourceAgentId":"a","entryId":"e"},"parent":"b"}');
		accept('{"cmd":"send","agentId":"a","body":"x","mode":"precede"}');
		accept('{"cmd":"wait_tree_idle","agentId":"a","quietMs":0}');
		accept('{"cmd":"prompt","agentId":"a","body":"x","images":[{"type":"image","data":"z","mimeType":"image/png"}]}');
	});

	it("lets a human answer with no choice at all", () => {
		// Core spells this `value: string | undefined` on a required property, which
		// JSON cannot send. The absent property is that answer on the wire; getting
		// this wrong makes "the user picked nothing" unrepresentable.
		accept('{"type":"human_response","requestId":"r","response":{"kind":"select"}}');
		accept('{"type":"human_response","requestId":"r","response":{"kind":"multi-select"}}');
		accept('{"type":"human_response","requestId":"r","response":{"kind":"questions","answers":[{"kind":"select"}]}}');
		accept('{"type":"human_response","requestId":"r","cancelled":true}');
	});

	it("refuses a human response that answers and withdraws at once", () => {
		expect(
			rejection('{"type":"human_response","requestId":"r","cancelled":true,"response":{"kind":"confirm"}}'),
		).toContain("unknown");
		expect(rejection('{"type":"human_response","requestId":"r","response":{"kind":"confirm"}}')).toContain("confirmed");
		expect(rejection('{"type":"human_response","requestId":"r"}')).toContain("human_response");
	});
});

describe("published JSON Schema", () => {
	const path = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs", RPC_SCHEMA_FILENAME);

	it("matches the schemas the runtime validates against", async () => {
		if (process.env.UPDATE_RPC_SCHEMA === "1") {
			await writeFile(path, serializeRpcInboundJsonSchema());
			return;
		}
		// Content, not text: the file lives under `docs/`, so the repository
		// formatter owns its layout and comparing bytes would fail on whitespace
		// the generator has no say in.
		//
		// Regenerate rather than edit:
		//   UPDATE_RPC_SCHEMA=1 npm --workspace apps/widi run test -- tests/rpc/frames.test.ts
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(buildRpcInboundJsonSchema());
	});

	it("offers every command as a definition, and every definition as a branch", () => {
		const published = buildRpcInboundJsonSchema() as {
			$defs: Record<string, unknown>;
			oneOf: readonly { $ref: string }[];
		};
		const defs = Object.keys(published.$defs).sort();
		expect(published.oneOf.map((branch) => branch.$ref.replace("#/$defs/", "")).sort()).toEqual(defs);
		expect(defs.filter((name) => name !== "human_response")).toEqual(Object.keys(RPC_COMMAND_SCHEMAS).sort());
	});
});
