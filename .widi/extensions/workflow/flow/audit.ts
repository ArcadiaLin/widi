import type { Flow, FlowAgentStep, FlowExpression, FlowSchema, FlowStateKind, FlowStep } from "./document.ts";
import { templateReferences } from "./values.ts";

/**
 * Everything that can be known about a flow without running it: what it may
 * cost at its worst, and every way its declarations do not hold together.
 *
 * This is the whole argument for the format. A flow that cannot prove it fits
 * its budget, or that writes to a slot nobody declared, is refused before an
 * agent is spawned rather than discovered eight minutes in.
 */

export interface FlowCost {
	readonly modelCalls: number;
	readonly agentSpawns: number;
}

export interface FlowAudit {
	readonly ok: boolean;
	readonly cost: FlowCost;
	readonly problems: readonly string[];
}

export function auditFlow(flow: Flow): FlowAudit {
	const problems: string[] = [];
	const cost = { modelCalls: 0, agentSpawns: 0 };
	const ids = new Set<string>();

	if (flow.steps.length === 0) problems.push("The flow declares no steps.");
	walk(flow, flow.steps, { factor: 1, inFanout: false }, ids, cost, problems);

	for (const [label, key] of [
		["report.summary", flow.report.summary],
		["report.items", flow.report.items],
	] as const) {
		if (key !== undefined && flow.state.every((slot) => slot.key !== key)) {
			problems.push(`${label} names state.${key}, which is not declared.`);
		}
	}

	if (cost.modelCalls > flow.budget.modelCalls) {
		problems.push(
			`Worst case is ${cost.modelCalls} model calls, over the declared budget of ${flow.budget.modelCalls}.`,
		);
	}
	if (cost.agentSpawns > flow.budget.agentSpawns) {
		problems.push(
			`Worst case is ${cost.agentSpawns} agent spawns, over the declared budget of ${flow.budget.agentSpawns}.`,
		);
	}
	return { ok: problems.length === 0, cost, problems };
}

interface Position {
	readonly factor: number;
	readonly inFanout: boolean;
}

function walk(
	flow: Flow,
	steps: readonly FlowStep[],
	position: Position,
	ids: Set<string>,
	cost: { modelCalls: number; agentSpawns: number },
	problems: string[],
): void {
	for (const step of steps) {
		if (ids.has(step.id)) problems.push(`Duplicate step id '${step.id}'.`);
		ids.add(step.id);
		switch (step.kind) {
			case "agent": {
				const perAttempt = step.role.tools.length > 0 ? (step.maxModelCalls ?? 1) : 1;
				if (step.role.tools.length > 0 && step.maxModelCalls === undefined) {
					problems.push(`Step '${step.id}' gives its role tools, so it must declare maxModelCalls.`);
				}
				if (step.role.tools.length === 0 && step.maxModelCalls !== undefined) {
					problems.push(`Step '${step.id}' declares maxModelCalls but has no tools, so one attempt is one call.`);
				}
				cost.modelCalls += position.factor * step.maxAttempts * perAttempt;
				cost.agentSpawns += position.factor;
				auditAgent(flow, step, position, problems);
				break;
			}
			case "transform":
				for (const operation of step.ops) {
					switch (operation.kind) {
						case "take":
							requireSlot(flow, operation.target, ["list"], `step '${step.id}' take`, problems);
							break;
						case "clear":
							requireSlot(flow, operation.target, ["list", "set", "text"], `step '${step.id}' clear`, problems);
							break;
						case "move":
							requireSlot(flow, operation.from, ["list", "set"], `step '${step.id}' move`, problems);
							requireSlot(flow, operation.into, ["list", "set"], `step '${step.id}' move into`, problems);
							if (operation.against !== undefined) {
								requireSlot(flow, operation.against, ["set"], `step '${step.id}' move against`, problems);
							}
							break;
					}
				}
				break;
			case "fanout":
				requireSlot(flow, step.over, ["list", "set"], `step '${step.id}' over`, problems);
				walk(flow, step.body, { factor: position.factor * step.maxItems, inFanout: true }, ids, cost, problems);
				break;
			case "loop":
				if (step.until !== undefined) {
					requireSlot(flow, step.until.empty, ["list", "set", "text"], `step '${step.id}' until`, problems);
				}
				walk(
					flow,
					step.body,
					{ factor: position.factor * step.maxIterations, inFanout: position.inFanout },
					ids,
					cost,
					problems,
				);
				break;
		}
	}
}

function auditAgent(flow: Flow, step: FlowAgentStep, position: Position, problems: string[]): void {
	for (const reference of templateReferences(step.task)) {
		if (reference.head === "item" && !position.inFanout) {
			problems.push(`Step '${step.id}' reads $item in its task but is not inside a fan-out.`);
		}
		if (reference.head === "output") {
			problems.push(`Step '${step.id}' reads $output in its task, which is only available after the answer.`);
		}
		if (reference.head === "state") {
			requireSlot(flow, reference.path[0] ?? "", ["list", "set", "text"], `step '${step.id}' task`, problems);
		}
	}
	for (const assignment of step.assign) {
		const target = flow.state.find((slot) => slot.key === assignment.into);
		if (target === undefined) {
			problems.push(`Step '${step.id}' assigns to state.${assignment.into}, which is not declared.`);
		} else if (target.kind === "text" && assignment.operation === "append") {
			problems.push(`Step '${step.id}' appends to state.${assignment.into}, which is text; use set.`);
		}
		if (assignment.against !== undefined) {
			requireSlot(flow, assignment.against, ["set"], `step '${step.id}' against`, problems);
		}
		auditExpression(flow, step, assignment.value, position, problems);
	}
}

function auditExpression(
	flow: Flow,
	step: FlowAgentStep,
	expression: FlowExpression,
	position: Position,
	problems: string[],
): void {
	switch (expression.kind) {
		case "item":
			if (!position.inFanout) problems.push(`Step '${step.id}' reads $item but is not inside a fan-out.`);
			return;
		case "state":
			requireSlot(flow, expression.key, ["list", "set", "text"], `step '${step.id}'`, problems);
			return;
		case "output": {
			const name = expression.path[0];
			if (name === undefined) return;
			if (!propertyNames(step.output).includes(name)) {
				problems.push(`Step '${step.id}' reads $output.${name}, which its output schema does not declare.`);
			}
			return;
		}
		case "object":
			for (const field of expression.fields) auditExpression(flow, step, field.value, position, problems);
			return;
		default:
			return;
	}
}

function propertyNames(schema: FlowSchema): readonly string[] {
	return schema.type === "object" ? schema.properties.map((property) => property.name) : [];
}

function requireSlot(flow: Flow, key: string, kinds: readonly FlowStateKind[], at: string, problems: string[]): void {
	const slot = flow.state.find((declared) => declared.key === key);
	if (slot === undefined) {
		problems.push(`${at} names state.${key}, which is not declared.`);
		return;
	}
	if (!kinds.includes(slot.kind)) {
		problems.push(`${at} names state.${key}, which is ${slot.kind}; it must be one of ${kinds.join(", ")}.`);
	}
}
