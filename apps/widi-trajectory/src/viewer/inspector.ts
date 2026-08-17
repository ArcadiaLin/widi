/**
 * Everything about one record.
 *
 * Content is shown whole. The ledger is where a run is skimmed; this is where it
 * is read, and a truncated tool result here would send the reader back to the
 * raw JSONL, which is the one outcome that would make this tool pointless.
 * Thinking is kept apart from the reply, and the arguments of a call apart from
 * its result, because conflating them is how a trajectory stops being evidence.
 */

import type { ContentBlock } from "../model/types.ts";
import { el, replace } from "./dom.ts";
import { formatCost, formatCount, formatDateTime, formatDuration } from "./format.ts";
import { anchorRecordId, type ViewerIndex } from "./model.ts";
import type { Store } from "./state.ts";
import { KIND_LABEL } from "./timeline.ts";

export interface InspectorHost {
	goTo(agentKey: string, recordId?: string): void;
}

function fact(name: string, value: string): HTMLElement {
	return el("div", { class: "fact" }, [
		el("span", { class: "fact-name", text: name }),
		el("span", { class: "fact-value", text: value }),
	]);
}

function blockNode(block: ContentBlock): HTMLElement {
	if (block.type === "image") {
		if (block.data === undefined) {
			return el("div", { class: "block block-note", text: block.note ?? "image not included" });
		}
		return el("div", { class: "block block-image" }, [
			el("img", { attrs: { src: `data:${block.mimeType};base64,${block.data}`, alt: "recorded image" } }),
		]);
	}
	const className =
		block.type === "thinking"
			? "block block-thinking"
			: block.type === "json"
				? "block block-json"
				: "block block-text";
	return el("div", { class: className }, [
		block.type === "text" ? null : el("div", { class: "block-kind", text: block.type }),
		el("pre", { text: block.text }),
	]);
}

function section(title: string, children: readonly HTMLElement[], open = true): HTMLElement | null {
	if (children.length === 0) return null;
	return el("details", { class: "section", attrs: { open } }, [
		el("summary", { text: title }),
		el("div", { class: "section-body" }, children),
	]);
}

export function renderInspector(container: HTMLElement, index: ViewerIndex, store: Store, host: InspectorHost): void {
	const state = store.state;
	const agent = index.agentByKey.get(state.agentKey);
	const record =
		agent === undefined || state.recordId === null
			? undefined
			: index.recordsByAgent.get(agent.key)?.get(state.recordId);
	if (record === undefined) {
		replace(container, [
			el("div", { class: "empty" }, [
				el("p", { text: "Select a record to inspect it." }),
				el("p", {
					class: "dim",
					text: "↑ ↓ walk the ledger · [ ] switch agent · / searches · f follows the selected link",
				}),
			]),
		]);
		return;
	}

	const branchStart =
		agent === undefined ? 0 : (agent.branches.find((branch) => branch.id === state.branchId)?.stats.firstAt ?? 0);

	const facts: HTMLElement[] = [
		fact("started", formatDateTime(record.startedAt)),
		fact("duration", formatDuration(record.endedAt - record.startedAt)),
		fact("offset", `+${formatDuration(record.startedAt - branchStart)}`),
		fact("entry", record.entryId),
	];
	if (record.model !== undefined) {
		facts.push(fact("model", `${record.model.provider}/${record.model.model}`));
		if (record.model.api !== undefined) facts.push(fact("api", record.model.api));
	}
	if (record.stopReason !== undefined) facts.push(fact("stop", record.stopReason));
	if (record.source !== undefined) {
		facts.push(
			fact(
				"source",
				record.source.label === undefined ? record.source.kind : `${record.source.kind} · ${record.source.label}`,
			),
		);
	}
	if (record.link?.status !== undefined) facts.push(fact("status", record.link.status));
	if (record.link?.reason !== undefined) facts.push(fact("reason", record.link.reason));
	if (record.toolCall !== undefined) {
		facts.push(fact("call id", record.toolCall.id));
		if (!record.toolCall.settled) facts.push(fact("result", "never recorded"));
	}
	for (const extra of record.facts ?? []) facts.push(fact(extra.name, extra.value));

	const usage = record.usage;
	const usageFacts: HTMLElement[] =
		usage === undefined
			? []
			: [
					fact("input", formatCount(usage.input)),
					fact("output", formatCount(usage.output)),
					fact("cache read", formatCount(usage.cacheRead)),
					fact("cache write", formatCount(usage.cacheWrite)),
					...(usage.reasoning === undefined ? [] : [fact("reasoning", formatCount(usage.reasoning))]),
					fact("total", formatCount(usage.total)),
					fact("cost", formatCost(usage.cost)),
				];

	const linkNodes: HTMLElement[] = [];
	const link = record.link;
	if (link !== undefined) {
		for (const target of link.targets) {
			if (target.agentKey === null) {
				linkNodes.push(
					el("div", { class: "link-row" }, [
						el("span", { class: "chip chip-dead", text: target.agentId }),
						el("span", { class: "dim", text: target.note ?? "not in this session tree" }),
					]),
				);
				continue;
			}
			const targetKey = target.agentKey;
			const targetAgent = index.agentByKey.get(targetKey);
			linkNodes.push(
				el("div", { class: "link-row" }, [
					el("button", {
						class: `chip chip-${link.kind}`,
						text: link.direction === "in" ? `${link.kind} ← ${target.agentId}` : `${link.kind} → ${target.agentId}`,
						attrs: { type: "button" },
						on: {
							click: () =>
								host.goTo(targetKey, anchorRecordId(index, targetKey, link.kind, link.direction, record.startedAt)),
						},
					}),
					el("span", {
						class: "dim",
						text: [target.note, targetAgent === undefined ? "" : `${targetAgent.stats.records} records`]
							.filter((part) => part !== undefined && part !== "")
							.join(" · "),
					}),
				]),
			);
		}
	}

	replace(container, [
		el("div", { class: "inspector-head" }, [
			el("span", { class: `row-kind kind-${record.kind}`, text: KIND_LABEL[record.kind] }),
			el("span", { class: "inspector-title", text: record.title }),
			record.isError !== true ? null : el("span", { class: "chip chip-error", text: "error" }),
			record.label === undefined ? null : el("span", { class: "row-label", text: record.label }),
		]),
		linkNodes.length === 0 ? null : el("div", { class: "link-list" }, linkNodes),
		el("div", { class: "facts" }, facts),
		usageFacts.length === 0 ? null : el("div", { class: "facts facts-usage" }, usageFacts),
		record.errorMessage === undefined
			? null
			: el("div", { class: "block block-error" }, [el("pre", { text: record.errorMessage })]),
		section(
			record.kind === "tool" ? "arguments" : record.kind === "notice" ? "body" : "content",
			(record.blocks ?? []).map(blockNode),
		),
		section(record.kind === "notice" ? "as delivered" : "result", (record.output ?? []).map(blockNode)),
		record.details === undefined
			? null
			: section("details", [el("div", { class: "block block-json" }, [el("pre", { text: record.details })])], false),
	]);
}
