import { describe, expect, it } from "vitest";
import { ResourceLoader } from "../../src/core/resource-loader.ts";
import { MemoryExecutionEnv } from "../helpers/orchestrator.ts";

const CWD = "/workspace";

function loader(files: Record<string, string>) {
	const env = new MemoryExecutionEnv();
	for (const [path, content] of Object.entries(files)) {
		env.files.set(path, content);
		// Register every ancestor so listDir and fileInfo resolve the tree.
		let dir = path.slice(0, path.lastIndexOf("/"));
		while (dir.length > 0) {
			env.dirs.add(dir);
			dir = dir.slice(0, dir.lastIndexOf("/"));
		}
	}
	return new ResourceLoader({
		executionEnv: env,
		cwd: CWD,
		agentDir: `${CWD}/.widi`,
	});
}

const template = ["---", "description: Run the self-check.", "---", "Go."].join(
	"\n",
);

describe("ResourceLoader prompt templates", () => {
	it("loads a named template from the prompts directory", async () => {
		const result = await loader({
			[`${CWD}/.widi/prompts/self-check.md`]: template,
		}).loadPromptTemplates(["self-check"]);

		expect(
			result.promptTemplates.map(({ promptTemplate }) => promptTemplate),
		).toMatchObject([{ name: "self-check", content: "Go." }]);
		expect(result.diagnostics).toEqual([]);
	});

	it("reports a named template that no root produced", async () => {
		const result = await loader({
			[`${CWD}/.widi/prompts/self-check.md`]: template,
		}).loadPromptTemplates(["self-check", "typo"]);

		expect(
			result.promptTemplates.map(({ promptTemplate }) => promptTemplate.name),
		).toEqual(["self-check"]);
		// The failure a missing directory used to hide: the profile named it, so
		// silence is wrong even though the path is legitimately absent.
		expect(result.diagnostics).toMatchObject([
			{
				type: "warning",
				code: "not_found",
				message: expect.stringContaining('"typo" was not found'),
				path: `${CWD}/.widi/prompts/typo.md`,
			},
		]);
	});

	it("stays silent when no names are given and the root is absent", async () => {
		const result = await loader({}).loadPromptTemplates([]);

		expect(result.promptTemplates).toEqual([]);
		expect(result.diagnostics).toEqual([]);
	});
});

describe("ResourceLoader skills", () => {
	it("reports a named skill that no root produced", async () => {
		const result = await loader({
			[`${CWD}/.widi/skills/self-check/SKILL.md`]: [
				"---",
				"name: self-check",
				"description: Exercise every tool.",
				"---",
				"Steps.",
			].join("\n"),
		}).loadSkills(["self-check", "gone"]);

		expect(result.skills.map(({ skill }) => skill.name)).toEqual([
			"self-check",
		]);
		expect(result.diagnostics).toMatchObject([
			{ code: "not_found", path: `${CWD}/.widi/skills/gone` },
		]);
	});
});
