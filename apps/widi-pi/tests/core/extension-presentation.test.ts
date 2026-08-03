/**
 * The presentation protocol an extension publishes against (stage 1, batch C):
 * the structured message kinds and the placement fields on a status.
 *
 * Core never renders any of this - what it owes a client is a shape the client
 * can trust and a copy the publishing extension can no longer reach.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionMessage, ExtensionStatus } from "../../src/core/extension/presentation.ts";
import {
	cloneExtensionStatus,
	MAX_EXTENSION_MESSAGE_TABLE_ROWS,
	validateExtensionMessage,
	validateExtensionStatus,
} from "../../src/core/extension/presentation.ts";
import { EXTENSION_MESSAGE_CUSTOM_TYPE } from "../../src/core/session-manager.ts";
import { createOrchestrator, MemoryExecutionEnv, requireAgentRecord } from "../helpers/orchestrator.ts";

describe("validateExtensionMessage", () => {
	it("keeps the shape of every kind it admits", () => {
		const messages: ExtensionMessage[] = [
			{ kind: "text", content: "plain" },
			{ kind: "markdown", title: "Report", content: "# Heading" },
			{ kind: "code", content: "const x = 1;", language: "typescript" },
			{
				kind: "table",
				title: "Files",
				columns: [{ label: "Path" }, { label: "Lines", align: "right" }],
				rows: [
					["src/a.ts", "12"],
					["src/b.ts", "340"],
				],
			},
			{
				kind: "fields",
				fields: [
					{ label: "Indexed", value: "672" },
					{ label: "Failed", value: "3", tone: "danger" },
				],
			},
			{ kind: "diff", path: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+b" },
			{ kind: "banner", severity: "warning", content: "Index is stale." },
		];

		for (const message of messages) {
			expect(validateExtensionMessage(message)).toEqual(message);
		}
	});

	// Rebuilding the top-level object was enough while every kind was flat.
	// The arrays are the part an extension can still reach afterwards.
	it("returns a copy detached down to the cells and fields", () => {
		const table = { kind: "table" as const, columns: [{ label: "Path" }], rows: [["src/a.ts"]] };
		const fields = { kind: "fields" as const, fields: [{ label: "Indexed", value: "672" }] };

		const validatedTable = validateExtensionMessage(table);
		const validatedFields = validateExtensionMessage(fields);
		if (validatedTable.kind !== "table" || validatedFields.kind !== "fields") {
			throw new Error("Expected structured message variants.");
		}
		table.rows[0][0] = "mutated";
		table.rows.push(["appended"]);
		table.columns[0].label = "mutated";
		fields.fields[0].value = "mutated";

		expect(validatedTable).toEqual({
			kind: "table",
			title: undefined,
			columns: [{ label: "Path", align: undefined }],
			rows: [["src/a.ts"]],
		});
		expect(validatedFields).toEqual({
			kind: "fields",
			title: undefined,
			fields: [{ label: "Indexed", value: "672", tone: undefined }],
		});
		expect(Object.isFrozen(validatedTable)).toBe(true);
		expect(Object.isFrozen(validatedTable.columns)).toBe(true);
		expect(Object.isFrozen(validatedTable.rows[0])).toBe(true);
		expect(Object.isFrozen(validatedFields.fields[0])).toBe(true);
	});

	it("keeps the persisted message and event immutable for consumers", async () => {
		const orchestrator = await createOrchestrator(new MemoryExecutionEnv());
		orchestrator.registerExtension("sample", () => {});
		const agentId = await orchestrator.spawnAgent();
		let nestedMutationSucceeded = false;
		let envelopeMutationSucceeded = false;
		let eventWasFrozen = false;
		let downstreamMessage: ExtensionMessage | undefined;
		orchestrator.subscribe((event) => {
			if (event.type !== "extension_message_published" || event.message.kind !== "table") {
				return;
			}
			eventWasFrozen = Object.isFrozen(event);
			try {
				const firstRow = event.message.rows[0] as unknown as string[];
				firstRow[0] = "forged";
				nestedMutationSucceeded = true;
			} catch {
				// Runtime immutability is the behavior under test.
			}
			try {
				(event as unknown as { message: ExtensionMessage }).message = { kind: "text", content: "forged" };
				envelopeMutationSucceeded = true;
			} catch {
				// Runtime immutability is the behavior under test.
			}
		});
		orchestrator.subscribe((event) => {
			if (event.type === "extension_message_published") {
				downstreamMessage = event.message;
			}
		});
		const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
		if (!runner) throw new Error("Expected extension runner.");

		await runner
			.createContext("sample")
			.actions.publishMessage({ kind: "table", columns: [{ label: "Path" }], rows: [["original"]] });

		const tree = await orchestrator.getAgentSessionTree(agentId);
		const entry = tree.entries.find(
			(candidate) => candidate.type === "custom" && candidate.customType === EXTENSION_MESSAGE_CUSTOM_TYPE,
		);
		expect(eventWasFrozen).toBe(true);
		expect(nestedMutationSucceeded).toBe(false);
		expect(envelopeMutationSucceeded).toBe(false);
		expect(Object.isFrozen(downstreamMessage)).toBe(true);
		expect(entry?.type === "custom" && Object.isFrozen(entry.data)).toBe(true);
		expect(downstreamMessage).toMatchObject({ kind: "table", rows: [["original"]] });
		expect(JSON.stringify(tree)).toContain(EXTENSION_MESSAGE_CUSTOM_TYPE);
		expect(JSON.stringify(tree)).toContain("original");
		expect(JSON.stringify(tree)).not.toContain("forged");
	});

	it("rejects sparse structured arrays before they can be persisted", () => {
		const sparseColumns = new Array<{ label: string }>(1);
		const sparseRows = new Array<readonly string[]>(1);
		const sparseCells = new Array<string>(1);
		const sparseFields = new Array<{ label: string; value: string }>(1);
		const messages: ExtensionMessage[] = [
			{ kind: "table", columns: sparseColumns, rows: [] },
			{ kind: "table", columns: [{ label: "Path" }], rows: sparseRows },
			{ kind: "table", columns: [{ label: "Path" }], rows: [sparseCells] },
			{ kind: "fields", fields: sparseFields },
		];

		for (const message of messages) {
			expect(() => validateExtensionMessage(message)).toThrow("must not contain empty slots");
		}
	});

	it("admits an empty cell but not an empty column set", () => {
		expect(
			validateExtensionMessage({
				kind: "table",
				columns: [{ label: "Path" }, { label: "Note" }],
				rows: [["src/a.ts", ""]],
			}),
		).toMatchObject({ rows: [["src/a.ts", ""]] });
		expect(() => validateExtensionMessage({ kind: "table", columns: [], rows: [] })).toThrow(TypeError);
	});

	// A ragged row leaves the renderer guessing which column a cell belongs to,
	// which is the guess the table kind exists to remove.
	it("refuses a row whose width does not match the columns", () => {
		expect(() =>
			validateExtensionMessage({
				kind: "table",
				columns: [{ label: "Path" }, { label: "Lines" }],
				rows: [["src/a.ts"]],
			}),
		).toThrow(TypeError);
	});

	it("bounds columns, rows, cells and fields", () => {
		const wideColumns = Array.from({ length: 13 }, (_, index) => ({ label: `c${index}` }));
		expect(() => validateExtensionMessage({ kind: "table", columns: wideColumns, rows: [] })).toThrow(RangeError);
		expect(() =>
			validateExtensionMessage({
				kind: "table",
				columns: [{ label: "Path" }],
				rows: Array.from({ length: MAX_EXTENSION_MESSAGE_TABLE_ROWS + 1 }, () => ["src/a.ts"]),
			}),
		).toThrow(RangeError);
		expect(() =>
			validateExtensionMessage({ kind: "table", columns: [{ label: "Path" }], rows: [["é".repeat(513)]] }),
		).toThrow(RangeError);
		expect(() =>
			validateExtensionMessage({
				kind: "fields",
				fields: Array.from({ length: 65 }, (_, index) => ({ label: `f${index}`, value: "v" })),
			}),
		).toThrow(RangeError);
	});

	// Each cell may be legal on its own and the table still be far too large to
	// persist or ship, so the whole message is measured after validation.
	it("bounds the serialized message as a whole", () => {
		expect(() =>
			validateExtensionMessage({
				kind: "table",
				columns: [{ label: "Path" }],
				rows: Array.from({ length: MAX_EXTENSION_MESSAGE_TABLE_ROWS }, () => ["x".repeat(1_000)]),
			}),
		).toThrow(RangeError);
	});

	it("rejects the malformed variants of each kind", () => {
		const invalid: ExtensionMessage[] = [
			{ kind: "html", content: "x" } as unknown as ExtensionMessage,
			{ kind: "code", content: "x", language: "type script" },
			{ kind: "diff", patch: "" },
			{ kind: "diff", path: "   ", patch: "@@" },
			{ kind: "banner", severity: "critical", content: "x" } as unknown as ExtensionMessage,
			{ kind: "fields", fields: [] },
			{ kind: "fields", fields: [{ label: "  ", value: "v" }] },
		];

		for (const message of invalid) {
			expect(() => validateExtensionMessage(message)).toThrow();
		}
	});
});

describe("validateExtensionStatus", () => {
	it("keeps region, icon and tone alongside the existing text and progress", () => {
		const status: ExtensionStatus = {
			text: "Indexing",
			progress: { completed: 3, total: 10 },
			region: "footer",
			icon: "◈",
			tone: "info",
		};

		expect(validateExtensionStatus(status)).toEqual(status);
	});

	it("defaults the placement fields to absent", () => {
		expect(validateExtensionStatus({ text: "Indexing" })).toEqual({ text: "Indexing" });
	});

	// One user-perceived character, which is not one code point: a flag or a
	// skin-toned emoji is a single icon.
	it("admits a multi-code-point grapheme as one icon", () => {
		expect(validateExtensionStatus({ text: "Busy", icon: "👍🏽" })).toMatchObject({ icon: "👍🏽" });
	});

	it("rejects an unusable region, icon or tone", () => {
		const invalid: ExtensionStatus[] = [
			{ text: "Busy", region: "header" } as unknown as ExtensionStatus,
			{ text: "Busy", tone: "critical" } as unknown as ExtensionStatus,
			{ text: "Busy", icon: "ab" },
			{ text: "Busy", icon: "" },
			{ text: "Busy", icon: "\u0007" },
		];

		for (const status of invalid) {
			expect(() => validateExtensionStatus(status)).toThrow();
		}
	});

	it("carries the placement fields through a clone", () => {
		expect(cloneExtensionStatus({ text: "Indexing", region: "agent-strip", icon: "◈", tone: "success" })).toMatchObject(
			{ region: "agent-strip", icon: "◈", tone: "success" },
		);
	});
});
