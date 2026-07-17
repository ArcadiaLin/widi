import { describe, expect, it } from "vitest";
import {
	parseLineCommand,
	scanInlineCommands,
} from "../../src/commands/parse.ts";

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

	it("rejects non-command text and invalid names", () => {
		expect(parseLineCommand("hello")).toBeUndefined();
		expect(parseLineCommand("/")).toBeUndefined();
		expect(parseLineCommand("//x")).toBeUndefined();
		expect(parseLineCommand("/bad name:arg")).toBeUndefined();
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
