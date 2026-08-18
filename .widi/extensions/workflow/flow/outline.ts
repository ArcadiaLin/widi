import type { Flow, FlowStep } from "./document.ts";

/**
 * The flow's shape, flattened, as a run reports it to whoever is drawing it.
 *
 * It goes over the bus with `workflow:started` rather than being read back off
 * disk, and that is the point: a flow is a file somebody is editing, and a view
 * that re-parsed it would draw a shape the run is not executing. The one that
 * started the run is the one that is true for it.
 *
 * Every field is a number or a string with a zero value, never an optional:
 * these cross a JSON bus, and a reader that has to distinguish absent from
 * zero is a reader that will one day get it wrong.
 */
export type WorkflowOutlineNode = {
	/** `rounds/probe/answer` - a run's own path with its `#n` qualifiers removed. */
	readonly path: string;
	readonly id: string;
	readonly kind: string;
	readonly depth: number;
	/** agent only. */
	readonly maxAttempts: number;
	/** loop only. */
	readonly maxIterations: number;
	/** fan-out only. */
	readonly maxItems: number;
	readonly maxConcurrency: number;
	/** The state slot a fan-out runs over; "" elsewhere. */
	readonly over: string;
	/** The role label an agent step spawns under; "" elsewhere. */
	readonly role: string;
};

export function buildOutline(flow: Flow): readonly WorkflowOutlineNode[] {
	const nodes: WorkflowOutlineNode[] = [];
	walk(flow.steps, "", 0, nodes);
	return nodes;
}

function walk(steps: readonly FlowStep[], prefix: string, depth: number, nodes: WorkflowOutlineNode[]): void {
	for (const step of steps) {
		const path = prefix === "" ? step.id : `${prefix}/${step.id}`;
		nodes.push({
			path,
			id: step.id,
			kind: step.kind,
			depth,
			maxAttempts: step.kind === "agent" ? step.maxAttempts : 0,
			maxIterations: step.kind === "loop" ? step.maxIterations : 0,
			maxItems: step.kind === "fanout" ? step.maxItems : 0,
			maxConcurrency: step.kind === "fanout" ? step.maxConcurrency : 0,
			over: step.kind === "fanout" ? step.over : "",
			role: step.kind === "agent" ? step.role.label : "",
		});
		if (step.kind === "fanout" || step.kind === "loop") walk(step.body, path, depth + 1, nodes);
	}
}
