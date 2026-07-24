import { describe, expect, it } from "vitest";
import {
	parseLineCommand,
	scanInlineCommands,
} from "../../../src/tui/commands/parse.ts";

describe("parseLineCommand", () => {
	it("parses a bare command without argument", () => {
		expect(parseLineCommand("/fork")).toEqual({
			name: "fork",
			argument: "",
			hasArgument: false,
		});
	});

	it("distinguishes explicit empty argument from no argument", () => {
		expect(parseLineCommand("/fork:")).toEqual({
			name: "fork",
			argument: "",
			hasArgument: true,
		});
	});

	it("parses name and argument", () => {
		expect(parseLineCommand("/model:openai/gpt-5")).toEqual({
			name: "model",
			argument: "openai/gpt-5",
			hasArgument: true,
		});
	});

	it("parses the space argument syntax", () => {
		expect(parseLineCommand("/model openai/gpt-5")).toEqual({
			name: "model",
			argument: "openai/gpt-5",
			hasArgument: true,
		});
	});

	it("skips the separating whitespace run in the space syntax", () => {
		expect(parseLineCommand("/model   openai/gpt-5")?.argument).toBe(
			"openai/gpt-5",
		);
	});

	it("keeps colon arguments verbatim, including spaces", () => {
		expect(parseLineCommand("/model:openai/gpt-5 latest")).toEqual({
			name: "model",
			argument: "openai/gpt-5 latest",
			hasArgument: true,
		});
	});

	it("uses whichever separator comes first", () => {
		expect(parseLineCommand("/name arg:withcolon")?.argument).toBe(
			"arg:withcolon",
		);
		expect(parseLineCommand("/name:arg with space")?.argument).toBe(
			"arg with space",
		);
	});

	it("parses unknown space-separated input as a command", () => {
		expect(parseLineCommand("/random words")).toEqual({
			name: "random",
			argument: "words",
			hasArgument: true,
		});
	});

	it("rejects non-command text and invalid names", () => {
		expect(parseLineCommand("hello")).toBeUndefined();
		expect(parseLineCommand("/")).toBeUndefined();
		expect(parseLineCommand("//x")).toBeUndefined();
	});

	it("ignores trailing whitespace", () => {
		expect(parseLineCommand("/status  ")?.name).toBe("status");
	});
});

describe("scanInlineCommands", () => {
	const names = ["prompt", "skill"];

	it("matches a closed inline command with argument", () => {
		expect(scanInlineCommands("use <skill:review> now", names)).toEqual([
			{ name: "skill", argument: "review", start: 4, end: 18 },
		]);
	});

	it("matches an empty inline command", () => {
		expect(scanInlineCommands("<prompt>", names)).toEqual([
			{ name: "prompt", argument: "", start: 0, end: 8 },
		]);
	});

	it("requires token boundaries and a close trigger", () => {
		expect(scanInlineCommands("x<skill:review>", names)).toEqual([]);
		expect(scanInlineCommands("<skill:review", names)).toEqual([]);
		expect(scanInlineCommands("<other:x>", names)).toEqual([]);
	});

	it("matches multiple commands left to right", () => {
		const text = "<prompt:a> and <skill:b>";
		expect(scanInlineCommands(text, names).map((match) => match.name)).toEqual([
			"prompt",
			"skill",
		]);
	});
});
