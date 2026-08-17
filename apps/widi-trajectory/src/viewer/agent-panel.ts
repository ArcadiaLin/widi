/**
 * The agent rail, and the header of the agent being read.
 *
 * The rail is the spawn tree exactly as the directory tree recorded it. The
 * header is where the tree stops being a shape and becomes navigation: the
 * record on the parent that created this agent, and the records on the parent
 * that its reports woke, are links back out - so a subtree can be entered and
 * left from either end.
 */

import type { AgentTrajectory } from "../model/types.ts";
import { el, replace } from "./dom.ts";
import { formatCost, formatCount, formatDuration } from "./format.ts";
import { agentLabel, type ViewerIndex } from "./model.ts";
import type { Store } from "./state.ts";

export interface Navigator {
	goTo(agentKey: string, recordId?: string): void;
}

function agentSubtitle(agent: AgentTrajectory): string {
	const parts: string[] = [];
	if (agent.profile !== undefined) parts.push(agent.profile.label ?? agent.profile.id);
	if (agent.name !== undefined) parts.push(agent.agentId);
	return parts.join(" · ");
}

export function renderAgentRail(container: HTMLElement, index: ViewerIndex, store: Store, nav: Navigator): void {
	const items: HTMLElement[] = [];
	const visit = (agent: AgentTrajectory, depth: number): void => {
		const selected = agent.key === store.state.agentKey;
		const subtitle = agentSubtitle(agent);
		items.push(
			el(
				"button",
				{
					class: `rail-item${selected ? " is-selected" : ""}`,
					attrs: { type: "button", "data-depth": depth, "aria-current": selected },
					style: { "--depth": String(depth) },
					on: { click: () => nav.goTo(agent.key) },
				},
				[
					el("span", { class: "rail-name", text: agentLabel(agent) }),
					subtitle === "" ? null : el("span", { class: "rail-sub", text: subtitle }),
					el("span", { class: "rail-meta" }, [
						el("span", { text: `${agent.stats.records} rec` }),
						el("span", { text: formatDuration(agent.stats.spanMs) }),
						agent.stats.errors === 0 ? null : el("span", { class: "rail-errors", text: `${agent.stats.errors} err` }),
					]),
				],
			),
		);
		for (const child of index.childrenOf.get(agent.key) ?? []) visit(child, depth + 1);
	};
	for (const root of index.roots) visit(root, 0);
	replace(container, [el("div", { class: "rail-title", text: "agents" }), ...items]);
}

function statTile(label: string, value: string, hint?: string): HTMLElement {
	return el("div", { class: "stat", ...(hint === undefined ? undefined : { title: hint }) }, [
		el("span", { class: "stat-label", text: label }),
		el("span", { class: "stat-value", text: value }),
	]);
}

export function renderAgentHeader(container: HTMLElement, index: ViewerIndex, store: Store, nav: Navigator): void {
	const agent = index.agentByKey.get(store.state.agentKey);
	if (agent === undefined) {
		replace(container, [el("div", { class: "empty", text: "No agent selected" })]);
		return;
	}
	const branch = agent.branches.find((candidate) => candidate.id === store.state.branchId) ?? agent.branches[0];
	const stats = branch?.stats ?? agent.stats;

	const crumbs: HTMLElement[] = [];
	let ancestor = agent.parentKey === null ? undefined : index.agentByKey.get(agent.parentKey);
	const chain: AgentTrajectory[] = [];
	while (ancestor !== undefined) {
		chain.unshift(ancestor);
		ancestor = ancestor.parentKey === null ? undefined : index.agentByKey.get(ancestor.parentKey);
	}
	for (const parent of chain) {
		crumbs.push(
			el("button", {
				class: "crumb",
				text: agentLabel(parent),
				attrs: { type: "button" },
				on: { click: () => nav.goTo(parent.key) },
			}),
		);
		crumbs.push(el("span", { class: "crumb-sep", text: "›" }));
	}

	const links: HTMLElement[] = [];
	for (const ref of index.incoming.get(agent.key) ?? []) {
		const from = index.agentByKey.get(ref.fromAgentKey);
		if (from === undefined) continue;
		const verb =
			ref.kind === "spawn"
				? "spawned here by"
				: ref.kind === "notice"
					? `${ref.status ?? "report"} reported to`
					: ref.kind === "dispose"
						? "disposed by"
						: ref.kind === "watch"
							? "watched by"
							: "messaged by";
		links.push(
			el("button", {
				class: `chip chip-${ref.kind}`,
				text: `↰ ${verb} ${agentLabel(from)}`,
				attrs: { type: "button" },
				on: { click: () => nav.goTo(ref.fromAgentKey, ref.recordId) },
			}),
		);
	}

	const branchSelect = el(
		"select",
		{
			class: "branch-select",
			attrs: { "aria-label": "branch" },
			on: {
				change: (event) => {
					const value = (event.target as HTMLSelectElement).value;
					store.patch({ branchId: value, recordId: null });
				},
			},
		},
		agent.branches.map((candidate) =>
			el("option", {
				text: `${candidate.current ? "current · " : "abandoned · "}${candidate.label}`,
				attrs: { value: candidate.id, selected: candidate.id === (branch?.id ?? "") },
			}),
		),
	);

	replace(container, [
		el("div", { class: "agent-crumbs" }, [...crumbs, el("span", { class: "agent-name", text: agentLabel(agent) })]),
		el("div", { class: "agent-sub" }, [
			el("span", { class: "mono", text: agent.agentId }),
			agent.profile === undefined ? null : el("span", { class: "tag", text: agent.profile.label ?? agent.profile.id }),
			agent.origin?.forkedFrom === undefined
				? null
				: el("span", { class: "tag", text: `forked from ${agent.origin.forkedFrom}` }),
			el("span", { class: "mono dim", text: agent.cwd }),
		]),
		links.length === 0 ? null : el("div", { class: "agent-links" }, links),
		el("div", { class: "stats" }, [
			statTile("records", String(stats.records)),
			statTile("turns", String(stats.turns)),
			statTile("requests", String(stats.requests)),
			statTile("tools", String(stats.toolCalls)),
			statTile("errors", String(stats.errors)),
			statTile("wall", formatDuration(stats.spanMs), "first record start to last record end"),
			statTile("busy", formatDuration(stats.busyMs), "union of the intervals something was running"),
			statTile("tokens", formatCount(stats.tokens.total)),
			statTile("cost", formatCost(stats.tokens.cost)),
		]),
		agent.branches.length <= 1
			? null
			: el("div", { class: "branch-row" }, [el("span", { class: "branch-label", text: "branch" }), branchSelect]),
	]);
}
