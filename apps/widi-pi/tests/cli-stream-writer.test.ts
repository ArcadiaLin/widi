import { describe, expect, it } from "vitest";
import { CliStreamWriter } from "../src/cli-stream-writer.ts";

function createWriter(): {
	readonly output: string[];
	readonly writer: CliStreamWriter;
} {
	const output: string[] = [];
	return {
		output,
		writer: new CliStreamWriter((text) => output.push(text)),
	};
}

describe("CliStreamWriter", () => {
	it("closes thinking before text when thinking_end is delayed", () => {
		const { output, writer } = createWriter();

		writer.startThinking();
		writer.writeThinkingDelta("reasoning");
		writer.writeTextDelta("answer");
		writer.endThinking();

		expect(output.join("")).toBe("[thinking]\nreasoning\n[/thinking]\nanswer");
	});

	it("reopens balanced thinking markers when content streams interleave", () => {
		const { output, writer } = createWriter();

		writer.writeThinkingDelta("think-1");
		writer.writeTextDelta("answer-1");
		writer.writeThinkingDelta("think-2");
		writer.writeTextDelta("answer-2");
		writer.endMessage();

		expect(output.join("")).toBe(
			"[thinking]\nthink-1\n[/thinking]\nanswer-1\n[thinking]\nthink-2\n[/thinking]\nanswer-2",
		);
	});

	it("closes unfinished thinking at the message boundary", () => {
		const { output, writer } = createWriter();

		writer.writeThinkingDelta("reasoning");
		writer.endMessage();
		writer.writeLine("[turn done]");

		expect(output.join("")).toBe(
			"[thinking]\nreasoning\n[/thinking]\n[turn done]\n",
		);
	});

	it("closes thinking before non-stream output", () => {
		const { output, writer } = createWriter();

		writer.writeThinkingDelta("reasoning");
		writer.writeLine("[diagnostic] warning");

		expect(output.join("")).toBe(
			"[thinking]\nreasoning\n[/thinking]\n[diagnostic] warning\n",
		);
	});

	it("places append-only output between text deltas on separate lines", () => {
		const { output, writer } = createWriter();

		writer.writeTextDelta("answer-1");
		writer.endMessage();
		writer.writeLine("[extension:sample] working");
		writer.writeTextDelta("answer-2");
		writer.endMessage();

		expect(output.join("")).toBe(
			"answer-1\n[extension:sample] working\nanswer-2",
		);
	});
});
