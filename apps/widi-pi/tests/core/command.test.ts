import { describe, expect, it } from "vitest";
import { isCommandName } from "../../src/core/command.ts";

describe("Command contract", () => {
	it("accepts stable command names without embedding the trigger", () => {
		expect(isCommandName("mark")).toBe(true);
		expect(isCommandName("follow-up")).toBe(true);
		expect(isCommandName("agent.status")).toBe(true);
		expect(isCommandName("agent_status")).toBe(true);
		expect(isCommandName("2nd")).toBe(true);
	});

	it("rejects names that would blur trigger, argument, or token boundaries", () => {
		expect(isCommandName("")).toBe(false);
		expect(isCommandName("/mark")).toBe(false);
		expect(isCommandName("<mark>")).toBe(false);
		expect(isCommandName("mark:")).toBe(false);
		expect(isCommandName("agent status")).toBe(false);
	});
});
