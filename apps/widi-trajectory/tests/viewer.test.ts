/**
 * The page, executed.
 *
 * The viewer is bundled ahead of the test and then run inside a DOM, so what is
 * exercised is the artefact the command actually writes - inlined data, inlined
 * script and all. A navigation test that stubbed the bundle would prove nothing
 * about the file someone opens.
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { beforeAll, describe, expect, it } from "vitest";
import { discoverSession } from "../src/load/discover.ts";
import { buildBundle } from "../src/model/bundle.ts";
import type { TrajectoryBundle } from "../src/model/types.ts";
import { DATA_ELEMENT_ID, renderHtml } from "../src/render/html.ts";
import { CHILD_DIR, delegationScenario, PARENT_DIR } from "./helpers/scenario.ts";
import { makeTempDir, writeSessionTree } from "./helpers/session-fixture.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

async function viewerAssets(): Promise<{ script: string; style: string }> {
	execFileSync("npm", ["run", "build:viewer"], { cwd: appRoot, stdio: "pipe" });
	const [script, style] = await Promise.all([
		readFile(`${appRoot}dist/viewer/bundle.js`, "utf8"),
		readFile(`${appRoot}dist/viewer/bundle.css`, "utf8"),
	]);
	return { script, style };
}

let html = "";
let bundle: TrajectoryBundle;

beforeAll(async () => {
	const root = await makeTempDir();
	const dirPath = await writeSessionTree(root, delegationScenario());
	bundle = await buildBundle({ session: await discoverSession(dirPath) });
	html = renderHtml(bundle, await viewerAssets());
}, 120_000);

function open(): { window: Window; document: Document } {
	const window = new Window({
		url: "https://widi.test/trajectory.html",
		width: 1400,
		height: 900,
		settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
	});
	window.document.write(html);
	return { window, document: window.document as unknown as Document };
}

/** A page narrowed to one agent, which is what the scope toggle turns off. */
function openOneAgent(): { window: Window; document: Document } {
	const opened = open();
	(opened.document.querySelector(".filter-scope") as HTMLElement).click();
	return opened;
}

function rowKinds(document: Document): (string | null)[] {
	return [...document.querySelectorAll(".row .row-kind")].map((node) => node.textContent);
}

describe("renderHtml", () => {
	it("embeds the bundle as JSON that cannot close the script tag", () => {
		expect(html).not.toContain("</script>\n<script>\nvar");
		const start = html.indexOf(`id="${DATA_ELEMENT_ID}">`) + `id="${DATA_ELEMENT_ID}">`.length;
		const json = html.slice(start, html.indexOf("</script>", start));
		expect(json).not.toContain("<");
		expect((JSON.parse(json) as TrajectoryBundle).agents).toHaveLength(2);
	});

	it("is one file with no external references", () => {
		expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/);
	});
});

describe("the viewer", () => {
	it("lists every agent in the rail and opens the root agent", () => {
		const { document } = open();
		const rail = [...document.querySelectorAll(".rail-item .rail-name")].map((node) => node.textContent);
		expect(rail).toEqual(["root-1", "plan-1"]);
		expect(document.querySelector(".agent-name")?.textContent).toBe("root-1");
	});

	it("lays the branch out as turns, steps and folded tool calls", () => {
		const { document } = openOneAgent();
		expect([...document.querySelectorAll(".turn-head .turn-number")].map((node) => node.textContent)).toEqual([
			"turn 1",
			"turn 2",
		]);
		expect(rowKinds(document)).toEqual([
			"user",
			"thinking",
			"assistant",
			"tool",
			"assistant",
			"notice",
			"assistant",
			"tool",
			"assistant",
		]);
	});

	it("gives reasoning its own row, carrying neither the reply nor its tokens", () => {
		const { document } = openOneAgent();
		const rows = [...document.querySelectorAll(".row")];
		const thinking = rows.find((row) => row.querySelector(".row-kind")?.textContent === "thinking");
		expect(thinking?.querySelector(".row-summary")?.textContent).toBe("this is big enough to delegate");
		const reply = rows[rows.indexOf(thinking as Element) + 1];
		expect(reply.querySelector(".row-kind")?.textContent).toBe("assistant");
		expect(reply.querySelector(".row-summary")?.textContent).toBe("delegating");
		expect(reply.querySelector(".row-tokens")?.textContent).not.toBe("");
		expect(thinking?.querySelector(".row-tokens")?.textContent).toBe("");
	});

	it("interleaves every agent by default, heading each run with its agent", () => {
		const { document } = open();
		const heads = [...document.querySelectorAll(".turn-head")].map((node) => ({
			agent: node.querySelector(".turn-agent")?.textContent,
			turn: node.querySelector(".turn-number")?.textContent,
		}));
		// Rows are interleaved by when they started, not grouped per agent: the
		// parent's "waiting" step really did happen between the child's two
		// records, and a per-agent grouping would hide that they overlapped.
		expect(heads).toEqual([
			{ agent: "root-1", turn: "turn 1" },
			{ agent: "plan-1", turn: "turn 1" },
			{ agent: "root-1", turn: "turn 1" },
			{ agent: "plan-1", turn: "turn 1" },
			{ agent: "root-1", turn: "turn 2" },
		]);
		const agents = [...document.querySelectorAll(".row")].map((node) => node.getAttribute("data-agent"));
		expect(new Set(agents).size).toBe(2);
	});

	it("keeps record numbering per agent when the scopes are combined", () => {
		const { document } = open();
		const child = [...document.querySelectorAll(".row")].filter(
			(row) => row.getAttribute("data-agent") !== `${PARENT_DIR}`,
		);
		expect(child[0].querySelector(".row-index")?.textContent).toBe("#1");
	});

	it("selects across agents from the combined ledger", () => {
		const { document } = open();
		const childRow = [...document.querySelectorAll(".row")].find(
			(row) => row.getAttribute("data-agent") === `${PARENT_DIR}/${CHILD_DIR}`,
		) as HTMLElement;
		childRow.click();
		expect(document.querySelector(".agent-name")?.textContent).toBe("plan-1");
		expect(document.querySelector(".row.is-selected")?.getAttribute("data-agent")).toBe(`${PARENT_DIR}/${CHILD_DIR}`);
	});

	it("gives every record the same width under the default projection", () => {
		const { document } = open();
		const widths = [...document.querySelectorAll(".tl-span")].map((node) =>
			Math.round(Number(node.getAttribute("width"))),
		);
		expect(new Set(widths).size).toBe(1);
		expect(widths[0]).toBeGreaterThan(0);
	});

	it("switches the timeline to recorded durations on demand", () => {
		const { document } = open();
		const clock = [...document.querySelectorAll(".mode")].find((node) => node.textContent === "clock") as HTMLElement;
		clock.click();
		const widths = [...document.querySelectorAll(".tl-span")].map((node) =>
			Math.round(Number(node.getAttribute("width"))),
		);
		// Real time: a 28s reply and a 1s one cannot be the same width.
		expect(new Set(widths).size).toBeGreaterThan(1);
	});

	it("follows a spawn chip into the child agent", () => {
		const { window, document } = openOneAgent();
		const chip = [...document.querySelectorAll(".row .chip")].find((node) => node.textContent?.includes("plan-1")) as
			| HTMLElement
			| undefined;
		expect(chip).toBeDefined();
		chip?.click();
		expect(document.querySelector(".agent-name")?.textContent).toBe("plan-1");
		expect(window.location.hash).toContain(encodeURIComponent(`${PARENT_DIR}/${CHILD_DIR}`));
	});

	it("anchors a report back to the record the child produced before it", () => {
		const { document } = openOneAgent();
		const notice = [...document.querySelectorAll(".row")].find(
			(row) => row.querySelector(".row-kind")?.textContent === "notice",
		) as HTMLElement | undefined;
		const chip = notice?.querySelector(".chip") as HTMLElement | undefined;
		chip?.click();
		expect(document.querySelector(".agent-name")?.textContent).toBe("plan-1");
		// The child's last record before the parent was told is its reply, not its task.
		expect(document.querySelector(".row.is-selected .row-kind")?.textContent).toBe("assistant");
	});

	it("shows the child where it was spawned from, and goes back there", () => {
		const { document } = openOneAgent();
		const child = [...document.querySelectorAll(".rail-item")].find((node) => node.textContent?.includes("plan-1")) as
			| HTMLElement
			| undefined;
		child?.click();
		const back = [...document.querySelectorAll(".agent-links .chip")].map((node) => node.textContent);
		expect(back.some((text) => text?.includes("spawned here by root-1"))).toBe(true);
		(document.querySelector(".agent-links .chip") as HTMLElement).click();
		expect(document.querySelector(".agent-name")?.textContent).toBe("root-1");
	});

	it("draws one timeline lane per agent when the scope is all agents", () => {
		const { document } = open();
		const labels = [...document.querySelectorAll(".tl-lane-label")].map((node) => node.textContent?.trim());
		expect(labels).toEqual(["root-1", "plan-1"]);
		expect(document.querySelectorAll(".tl-span").length).toBe(
			bundle.agents[0].stats.records + bundle.agents[1].stats.records,
		);
	});

	it("narrows the ledger to what a search matches, keeping record numbering", () => {
		const { window, document } = openOneAgent();
		const search = document.querySelector(".search") as HTMLInputElement;
		search.value = "releasing";
		// happy-dom builds the event; its Event is structurally narrower than the DOM one.
		search.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
		const rows = [...document.querySelectorAll(".row .row-index")].map((node) => node.textContent);
		expect(rows).toEqual(["#7"]);
	});

	it("opens the inspector on the selected record with its whole content", () => {
		const { document } = openOneAgent();
		const row = document.querySelectorAll(".row")[2] as HTMLElement;
		row.click();
		expect(document.querySelector(".inspector-title")?.textContent).toBe("assistant");
		expect(document.querySelector(".inspector")?.textContent).toContain("delegating");
		expect(document.querySelector(".inspector")?.textContent).toContain("test/test-model");
	});
});
