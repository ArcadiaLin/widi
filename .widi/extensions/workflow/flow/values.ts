import type { FlowAssignment, FlowExpression, FlowOperation, FlowStateDeclaration, FlowStateKind } from "./document.ts";
import type { FlowValue } from "./schema.ts";

/**
 * The flow's memory, and the only channel between steps. Slots are declared, so
 * a write to a name nobody declared is a parse error rather than a new variable.
 */
export class FlowState {
	private readonly _kinds: Map<string, FlowStateKind> = new Map();
	private readonly _lists: Map<string, FlowValue[]> = new Map();
	private readonly _sets: Map<string, Set<string>> = new Map();
	private readonly _texts: Map<string, string> = new Map();

	constructor(declarations: readonly FlowStateDeclaration[]) {
		for (const declaration of declarations) {
			this._kinds.set(declaration.key, declaration.kind);
			if (declaration.kind === "list") this._lists.set(declaration.key, []);
			if (declaration.kind === "set") this._sets.set(declaration.key, new Set());
			if (declaration.kind === "text") this._texts.set(declaration.key, "");
		}
	}

	kindOf(key: string): FlowStateKind | undefined {
		return this._kinds.get(key);
	}

	read(key: string): FlowValue {
		if (this._lists.has(key)) return [...(this._lists.get(key) ?? [])];
		if (this._sets.has(key)) return [...(this._sets.get(key) ?? [])];
		return this._texts.get(key) ?? "";
	}

	size(key: string): number {
		if (this._lists.has(key)) return (this._lists.get(key) ?? []).length;
		if (this._sets.has(key)) return (this._sets.get(key) ?? new Set()).size;
		return (this._texts.get(key) ?? "").length;
	}

	/** Every slot, for a journal record or a report. */
	snapshot(): { [key: string]: FlowValue } {
		const values: { [key: string]: FlowValue } = {};
		for (const key of this._kinds.keys()) values[key] = this.read(key);
		return values;
	}

	apply(assignment: FlowAssignment, value: FlowValue | undefined): void {
		if (assignment.whenPresent && isEmpty(value)) return;
		const resolved = value ?? "";
		if (assignment.operation === "set") {
			this._set(assignment, resolved);
			return;
		}
		this._append(assignment.into, resolved, assignment);
	}

	run(operation: FlowOperation): void {
		switch (operation.kind) {
			case "take": {
				const list = this._lists.get(operation.target);
				if (list !== undefined) list.splice(operation.count);
				return;
			}
			case "clear": {
				this._lists.get(operation.target)?.splice(0);
				this._sets.get(operation.target)?.clear();
				if (this._texts.has(operation.target)) this._texts.set(operation.target, "");
				return;
			}
			case "move": {
				const source = this.read(operation.from);
				this.run({ kind: "clear", target: operation.from });
				if (!Array.isArray(source)) return;
				for (const entry of source) this._append(operation.into, entry, operation);
				return;
			}
		}
	}

	private _set(assignment: FlowAssignment, value: FlowValue): void {
		if (this._texts.has(assignment.into)) {
			this._texts.set(assignment.into, typeof value === "string" ? value : JSON.stringify(value));
			return;
		}
		this.run({ kind: "clear", target: assignment.into });
		for (const entry of Array.isArray(value) ? value : [value]) this._append(assignment.into, entry, assignment);
	}

	private _append(
		key: string,
		value: FlowValue,
		limits: { readonly dedupe: boolean; readonly against?: string; readonly limit?: number },
	): void {
		const identity = identityOf(value);
		if (limits.against !== undefined && this._sets.get(limits.against)?.has(identity) === true) return;
		const set = this._sets.get(key);
		if (set !== undefined) {
			if (limits.limit !== undefined && set.size >= limits.limit) return;
			set.add(identity);
			return;
		}
		const list = this._lists.get(key);
		if (list === undefined) return;
		if (limits.limit !== undefined && list.length >= limits.limit) return;
		if (limits.dedupe && list.some((existing) => identityOf(existing) === identity)) return;
		list.push(value);
	}
}

export interface EvaluationScope {
	readonly input: string;
	/** The fan-out item this branch runs for; absent outside a fan-out. */
	readonly item?: FlowValue;
	readonly iteration: number;
	readonly output?: FlowValue;
	readonly state: FlowState;
}

export function evaluate(expression: FlowExpression, scope: EvaluationScope): FlowValue | undefined {
	switch (expression.kind) {
		case "input":
			return scope.input;
		case "item":
			return scope.item;
		case "iteration":
			return scope.iteration;
		case "literal":
			return expression.value;
		case "output":
			return walk(scope.output, expression.path);
		case "state":
			return walk(scope.state.read(expression.key), expression.path);
		case "object": {
			const built: { [key: string]: FlowValue } = {};
			for (const field of expression.fields) {
				const value = evaluate(field.value, scope);
				if (value !== undefined) built[field.name] = value;
			}
			return built;
		}
	}
}

const REFERENCE = /\$(input|item|iteration|output|state)(\.[a-zA-Z0-9_.]+)?/g;

/**
 * A task is a template, not code: references are substituted and nothing else
 * is interpreted. Anything that is not already text is rendered as JSON, which
 * is also what the model is being asked to answer in.
 */
export function renderTemplate(template: string, scope: EvaluationScope): string {
	return template.replace(REFERENCE, (match, head: string, tail: string | undefined) => {
		const path = (tail ?? "").split(".").filter((part) => part.length > 0);
		const value =
			head === "input"
				? scope.input
				: head === "item"
					? scope.item
					: head === "iteration"
						? scope.iteration
						: head === "output"
							? walk(scope.output, path)
							: path.length === 0
								? undefined
								: walk(scope.state.read(path[0]), path.slice(1));
		if (value === undefined) return match;
		return typeof value === "string" ? value : JSON.stringify(value, null, 2);
	});
}

/** The references a template makes, so the audit can check them without running it. */
export function templateReferences(template: string): readonly { head: string; path: readonly string[] }[] {
	const found: { head: string; path: readonly string[] }[] = [];
	for (const match of template.matchAll(REFERENCE)) {
		found.push({ head: match[1] ?? "", path: (match[2] ?? "").split(".").filter((part) => part.length > 0) });
	}
	return found;
}

function walk(value: FlowValue | undefined, path: readonly string[]): FlowValue | undefined {
	let current = value;
	for (const part of path) {
		if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
		current = current[part];
	}
	return current;
}

/**
 * The comparison key for dedupe and for membership of a set. Text is normalised
 * because two model answers rarely differ only in spacing on purpose; the
 * original value is what gets stored.
 */
function identityOf(value: FlowValue): string {
	return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : JSON.stringify(value);
}

function isEmpty(value: FlowValue | undefined): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value === "string") return value.trim().length === 0;
	return Array.isArray(value) && value.length === 0;
}
