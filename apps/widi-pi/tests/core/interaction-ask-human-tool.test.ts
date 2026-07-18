import { describe, expect, it } from "vitest";
import type {
	HumanRequestDraft,
	HumanResponse,
	ToolHumanHost,
} from "../../src/core/human-request.ts";
import {
	type AskHumanToolDetails,
	createAskHumanToolDefinition,
} from "../../src/core/tools/interaction/ask-human.ts";
import type { ToolExecutionContext } from "../../src/core/tools/types.ts";

function makeContext(
	overrides: Partial<ToolExecutionContext<AskHumanToolDetails>> = {},
): ToolExecutionContext<AskHumanToolDetails> {
	return {
		signal: undefined,
		onUpdate: undefined,
		extension: undefined,
		human: undefined,
		...overrides,
	};
}

function makeHumanHost(response: HumanResponse): {
	host: ToolHumanHost;
	drafts: HumanRequestDraft[];
} {
	const drafts: HumanRequestDraft[] = [];
	return {
		host: {
			request: async (draft) => {
				drafts.push(draft);
				return response;
			},
		},
		drafts,
	};
}

describe("ask_human tool", () => {
	const tool = createAskHumanToolDefinition();

	it("routes a confirm question through the human host", async () => {
		const { host, drafts } = makeHumanHost({
			kind: "confirm",
			confirmed: true,
		});
		const abortController = new AbortController();
		const result = await tool.execute(
			"call-1",
			{ kind: "confirm", title: "  Delete the branch?  " },
			makeContext({ human: host, signal: abortController.signal }),
		);
		expect(drafts).toEqual([
			{
				kind: "confirm",
				title: "Delete the branch?",
				message: undefined,
				options: undefined,
				placeholder: undefined,
				allowFreeInput: undefined,
				signal: abortController.signal,
			},
		]);
		expect(result.content).toEqual([
			{ type: "text", text: "The human confirmed." },
		]);
		expect(result.details).toEqual({
			kind: "confirm",
			response: { kind: "confirm", confirmed: true },
		});
	});

	it("passes select options and reports the selection", async () => {
		const { host, drafts } = makeHumanHost({ kind: "select", value: "green" });
		const result = await tool.execute(
			"call-1",
			{
				kind: "select",
				title: "Pick a color",
				options: ["red", "green"],
				allowFreeInput: true,
			},
			makeContext({ human: host }),
		);
		expect(drafts[0]).toMatchObject({
			kind: "select",
			options: ["red", "green"],
			allowFreeInput: true,
		});
		expect(result.content).toEqual([
			{ type: "text", text: "The human selected: green" },
		]);
	});

	it("reports a dismissed request as no answer instead of an error", async () => {
		const { host } = makeHumanHost({ kind: "input", value: undefined });
		const result = await tool.execute(
			"call-1",
			{ kind: "input", title: "Which ticket id?" },
			makeContext({ human: host }),
		);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "The human dismissed the request without providing input.",
			},
		]);
	});

	it("rejects invalid inputs before contacting the human", async () => {
		const { host, drafts } = makeHumanHost({
			kind: "confirm",
			confirmed: true,
		});
		const context = makeContext({ human: host });
		await expect(
			tool.execute("call-1", { kind: "select", title: "Pick" }, context),
		).rejects.toThrow("kind=select requires a non-empty options list");
		await expect(
			tool.execute(
				"call-1",
				{ kind: "confirm", title: "Sure?", options: ["yes"] },
				context,
			),
		).rejects.toThrow("options is only valid for kind=select");
		await expect(
			tool.execute(
				"call-1",
				{ kind: "input", title: "Name?", allowFreeInput: true },
				context,
			),
		).rejects.toThrow("allowFreeInput is only valid for kind=select");
		await expect(
			tool.execute("call-1", { kind: "confirm", title: "   " }, context),
		).rejects.toThrow("title must not be empty");
		expect(drafts).toEqual([]);
	});

	it("fails when no human host is available", async () => {
		await expect(
			tool.execute(
				"call-1",
				{ kind: "confirm", title: "Proceed?" },
				makeContext(),
			),
		).rejects.toThrow("Human requests are not available in this runtime.");
	});
});
