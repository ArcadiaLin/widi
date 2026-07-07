import { describe, expect, it } from "vitest";
import { isCommandName, parseLineCommand } from "../../src/core/command.ts";

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

	it("does not parse a trigger-prefixed name as a valid line command", () => {
		expect(parseLineCommand("//mark:value", ["/"])).toBeUndefined();
		expect(parseLineCommand("/mark:value", ["/"])).toEqual({
			trigger: "/",
			name: "mark",
			argument: "value",
		});
	});
});
