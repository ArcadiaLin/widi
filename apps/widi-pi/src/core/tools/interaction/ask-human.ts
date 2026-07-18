import { type Static, Type } from "typebox";
import type { HumanResponse } from "../../human-request.ts";
import type { ToolDefinition } from "../types.ts";

const askHumanSchema = Type.Object({
	kind: Type.Union(
		[Type.Literal("confirm"), Type.Literal("select"), Type.Literal("input")],
		{
			description:
				"confirm: yes/no decision. select: pick one of the options. input: free-form text.",
		},
	),
	title: Type.String({
		description: "Short question shown to the human.",
	}),
	message: Type.Optional(
		Type.String({
			description: "Optional longer context shown below the title.",
		}),
	),
	options: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Choices for kind=select, in display order. Required for select; invalid for other kinds.",
		}),
	),
	placeholder: Type.Optional(
		Type.String({
			description: "Optional input placeholder for kind=input.",
		}),
	),
	allowFreeInput: Type.Optional(
		Type.Boolean({
			description:
				"For kind=select: also offer a free-form answer besides the options.",
		}),
	),
});

export type AskHumanToolInput = Static<typeof askHumanSchema>;

export interface AskHumanToolDetails {
	kind: AskHumanToolInput["kind"];
	response: HumanResponse;
}

/**
 * Agent-initiated human request. The tool is a thin adapter over the
 * orchestrator human-request broker: routing, events, cancellation, and
 * profile capability gating all live in core, not here.
 */
export function createAskHumanToolDefinition(): ToolDefinition<
	typeof askHumanSchema,
	AskHumanToolDetails
> {
	return {
		name: "ask_human",
		label: "ask human",
		description:
			"Ask the human operator a question and wait for the answer. Use confirm for yes/no decisions, select to choose between options, and input for free-form text. Blocks until the human answers or dismisses the request; a dismissal is reported as no answer, not an error.",
		promptSnippet: "Ask the human operator a question and wait for the answer",
		promptGuidelines: [
			"Work autonomously by default; use ask_human only when a decision genuinely needs the human, such as destructive actions or ambiguous requirements.",
			"Prefer ask_human with kind=select and concrete options over open-ended input.",
		],
		parameters: askHumanSchema,
		// A pending question is modal for the human; never run it concurrently
		// with other tool calls.
		executionMode: "sequential",
		execute: async (_toolCallId, input, context) => {
			validateAskHumanInput(input);
			if (!context.human) {
				throw new Error("Human requests are not available in this runtime.");
			}
			const response = await context.human.request({
				kind: input.kind,
				title: input.title.trim(),
				message: input.message,
				options: input.options,
				placeholder: input.placeholder,
				allowFreeInput: input.allowFreeInput,
				signal: context.signal,
			});
			return {
				content: [{ type: "text", text: formatHumanResponse(response) }],
				details: { kind: input.kind, response },
			};
		},
	};
}

function validateAskHumanInput(input: AskHumanToolInput): void {
	if (!input.title.trim()) {
		throw new Error(
			"Ask human tool input is invalid. title must not be empty.",
		);
	}
	if (input.kind === "select") {
		if (!input.options || input.options.length === 0) {
			throw new Error(
				"Ask human tool input is invalid. kind=select requires a non-empty options list.",
			);
		}
		if (input.options.some((option) => !option.trim())) {
			throw new Error(
				"Ask human tool input is invalid. options must not contain empty entries.",
			);
		}
	} else if (input.options !== undefined) {
		throw new Error(
			`Ask human tool input is invalid. options is only valid for kind=select, not kind=${input.kind}.`,
		);
	}
	if (input.allowFreeInput !== undefined && input.kind !== "select") {
		throw new Error(
			"Ask human tool input is invalid. allowFreeInput is only valid for kind=select.",
		);
	}
}

function formatHumanResponse(response: HumanResponse): string {
	switch (response.kind) {
		case "confirm":
			return response.confirmed
				? "The human confirmed."
				: "The human declined.";
		case "select":
			return response.value === undefined
				? "The human dismissed the request without selecting an option."
				: `The human selected: ${response.value}`;
		case "input":
			return response.value === undefined
				? "The human dismissed the request without providing input."
				: `The human answered: ${response.value}`;
		case "custom":
			return `The human responded: ${JSON.stringify(response.value)}`;
	}
}
