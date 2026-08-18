import { parse as parseYaml } from "yaml";
import type {
	Flow,
	FlowAssignment,
	FlowBudget,
	FlowExpression,
	FlowJournalRecord,
	FlowOperation,
	FlowReport,
	FlowRole,
	FlowSchema,
	FlowStateDeclaration,
	FlowStateKind,
	FlowStep,
} from "./document.ts";

/**
 * YAML to a flow document, collecting every problem instead of throwing on the
 * first. A flow is configuration, and the person who wrote it wants the whole
 * list, not a bisection.
 *
 * Unknown keys are errors. In a format nobody type-checks, a silently ignored
 * `maxItem:` is the difference between a bound and no bound at all.
 */

export interface ParsedFlow {
	readonly flow?: Flow;
	readonly errors: readonly string[];
}

const STATE_KINDS: readonly FlowStateKind[] = ["list", "set", "text"];
const JOURNAL_RECORDS: readonly FlowJournalRecord[] = ["run", "step", "output", "result"];

export function parseFlow(text: string, source: string): ParsedFlow {
	const errors: string[] = [];
	let document: unknown;
	try {
		document = parseYaml(text);
	} catch (error) {
		return { errors: [`YAML is not parseable: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const parser = new Parser(errors);
	const root = parser.record(document, "flow");
	if (root === undefined) return { errors };
	parser.only(root, ["name", "version", "description", "budget", "state", "steps", "persist", "report"], "flow");

	const name = parser.text(root.name, "name");
	const version = parser.count(root.version, "version", 1) ?? 1;
	const budget = parser.budget(root.budget);
	const state = parser.state(root.state);
	const steps = parser.steps(root.steps, "steps");
	const journal = parser.journal(root.persist);
	const report = parser.report(root.report);
	const description = root.description === undefined ? undefined : parser.text(root.description, "description");

	if (name === undefined || budget === undefined) return { errors };
	const flow: Flow = {
		name,
		version,
		budget,
		state,
		steps,
		report,
		source,
		...(description === undefined ? undefined : { description }),
		...(journal === undefined ? undefined : { journal }),
	};
	return errors.length > 0 ? { errors } : { flow, errors };
}

type UnknownRecord = { readonly [key: string]: unknown };

class Parser {
	private readonly _errors: string[];

	constructor(errors: string[]) {
		this._errors = errors;
	}

	fail(at: string, message: string): undefined {
		this._errors.push(`${at}: ${message}`);
		return undefined;
	}

	record(value: unknown, at: string): UnknownRecord | undefined {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return this.fail(at, "must be a mapping.");
		}
		return value as UnknownRecord;
	}

	only(fields: UnknownRecord, allowed: readonly string[], at: string): void {
		for (const key of Object.keys(fields)) {
			if (!allowed.includes(key)) this.fail(at, `unknown key '${key}'. Allowed: ${allowed.join(", ")}.`);
		}
	}

	text(value: unknown, at: string): string | undefined {
		if (typeof value !== "string" || value.trim().length === 0) return this.fail(at, "must be a non-empty string.");
		return value;
	}

	count(value: unknown, at: string, min: number): number | undefined {
		if (value === undefined) return undefined;
		if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
			return this.fail(at, `must be an integer of at least ${min}.`);
		}
		return value;
	}

	flag(value: unknown, at: string): boolean {
		if (value === undefined) return false;
		if (typeof value !== "boolean") {
			this.fail(at, "must be true or false.");
			return false;
		}
		return value;
	}

	array(value: unknown, at: string): readonly unknown[] {
		if (!Array.isArray(value)) {
			this.fail(at, "must be a list.");
			return [];
		}
		return value;
	}

	budget(value: unknown): FlowBudget | undefined {
		const fields = this.record(value, "budget");
		if (fields === undefined) return undefined;
		this.only(fields, ["modelCalls", "agentSpawns", "wallClockMs"], "budget");
		const modelCalls = this.count(fields.modelCalls, "budget.modelCalls", 1);
		const agentSpawns = this.count(fields.agentSpawns, "budget.agentSpawns", 1);
		const wallClockMs = this.count(fields.wallClockMs, "budget.wallClockMs", 1000);
		if (modelCalls === undefined || agentSpawns === undefined || wallClockMs === undefined) {
			return this.fail("budget", "must declare modelCalls, agentSpawns and wallClockMs.");
		}
		return { modelCalls, agentSpawns, wallClockMs };
	}

	state(value: unknown): readonly FlowStateDeclaration[] {
		if (value === undefined) return [];
		const fields = this.record(value, "state");
		if (fields === undefined) return [];
		const declarations: FlowStateDeclaration[] = [];
		for (const [key, declared] of Object.entries(fields)) {
			const slot = this.record(declared, `state.${key}`);
			if (slot === undefined) continue;
			this.only(slot, ["type"], `state.${key}`);
			const kind = STATE_KINDS.find((candidate) => candidate === slot.type);
			if (kind === undefined) {
				this.fail(`state.${key}.type`, `must be one of ${STATE_KINDS.join(", ")}.`);
				continue;
			}
			declarations.push({ key, kind });
		}
		return declarations;
	}

	journal(value: unknown): Flow["journal"] {
		if (value === undefined) return undefined;
		const fields = this.record(value, "persist");
		if (fields === undefined) return undefined;
		this.only(fields, ["path", "records"], "persist");
		const path = this.text(fields.path, "persist.path");
		const records: FlowJournalRecord[] = [];
		for (const [index, entry] of this.array(fields.records ?? JOURNAL_RECORDS, "persist.records").entries()) {
			const record = JOURNAL_RECORDS.find((candidate) => candidate === entry);
			if (record === undefined) {
				this.fail(`persist.records[${index}]`, `must be one of ${JOURNAL_RECORDS.join(", ")}.`);
				continue;
			}
			records.push(record);
		}
		if (path === undefined || records.length === 0) return undefined;
		return { path, records };
	}

	report(value: unknown): FlowReport {
		if (value === undefined) return {};
		const fields = this.record(value, "report");
		if (fields === undefined) return {};
		this.only(fields, ["summary", "items"], "report");
		const summary = fields.summary === undefined ? undefined : this.statePath(fields.summary, "report.summary");
		const items = fields.items === undefined ? undefined : this.statePath(fields.items, "report.items");
		return { ...(summary === undefined ? undefined : { summary }), ...(items === undefined ? undefined : { items }) };
	}

	steps(value: unknown, at: string): readonly FlowStep[] {
		const steps: FlowStep[] = [];
		for (const [index, entry] of this.array(value, at).entries()) {
			const step = this.step(entry, `${at}[${index}]`);
			if (step !== undefined) steps.push(step);
		}
		return steps;
	}

	step(value: unknown, at: string): FlowStep | undefined {
		const fields = this.record(value, at);
		if (fields === undefined) return undefined;
		const id = this.text(fields.id, `${at}.id`);
		if (id === undefined) return undefined;
		const where = `${at}(${id})`;
		switch (fields.kind) {
			case "agent":
				return this.agentStep(fields, id, where);
			case "transform":
				return this.transformStep(fields, id, where);
			case "fanout":
				return this.fanoutStep(fields, id, where);
			case "loop":
				return this.loopStep(fields, id, where);
			default:
				return this.fail(`${where}.kind`, "must be one of agent, transform, fanout, loop.");
		}
	}

	agentStep(fields: UnknownRecord, id: string, at: string): FlowStep | undefined {
		this.only(fields, ["id", "kind", "role", "task", "output", "assign", "maxAttempts", "maxModelCalls"], at);
		const role = this.role(fields.role, `${at}.role`);
		const task = this.text(fields.task, `${at}.task`);
		const output = this.schema(fields.output, `${at}.output`);
		if (role === undefined || task === undefined || output === undefined) return undefined;
		if (output.type !== "object") return this.fail(`${at}.output`, "must be an object schema.");
		const assign: FlowAssignment[] = [];
		for (const [index, entry] of this.array(fields.assign ?? [], `${at}.assign`).entries()) {
			const assignment = this.assignment(entry, `${at}.assign[${index}]`);
			if (assignment !== undefined) assign.push(assignment);
		}
		const maxModelCalls = this.count(fields.maxModelCalls, `${at}.maxModelCalls`, 1);
		return {
			kind: "agent",
			id,
			role,
			task,
			output,
			assign,
			maxAttempts: this.count(fields.maxAttempts, `${at}.maxAttempts`, 1) ?? 1,
			...(maxModelCalls === undefined ? undefined : { maxModelCalls }),
		};
	}

	transformStep(fields: UnknownRecord, id: string, at: string): FlowStep | undefined {
		this.only(fields, ["id", "kind", "ops"], at);
		const ops: FlowOperation[] = [];
		for (const [index, entry] of this.array(fields.ops, `${at}.ops`).entries()) {
			const operation = this.operation(entry, `${at}.ops[${index}]`);
			if (operation !== undefined) ops.push(operation);
		}
		if (ops.length === 0) return this.fail(`${at}.ops`, "must declare at least one operation.");
		return { kind: "transform", id, ops };
	}

	fanoutStep(fields: UnknownRecord, id: string, at: string): FlowStep | undefined {
		this.only(fields, ["id", "kind", "over", "maxItems", "maxConcurrency", "body"], at);
		const over = this.statePath(fields.over, `${at}.over`);
		const maxItems = this.count(fields.maxItems, `${at}.maxItems`, 1);
		const maxConcurrency = this.count(fields.maxConcurrency, `${at}.maxConcurrency`, 1);
		const body = this.steps(fields.body, `${at}.body`);
		if (over === undefined || maxItems === undefined || maxConcurrency === undefined) return undefined;
		if (body.length === 0) return this.fail(`${at}.body`, "must declare at least one step.");
		return { kind: "fanout", id, over, maxItems, maxConcurrency, body };
	}

	loopStep(fields: UnknownRecord, id: string, at: string): FlowStep | undefined {
		this.only(fields, ["id", "kind", "maxIterations", "until", "body"], at);
		const maxIterations = this.count(fields.maxIterations, `${at}.maxIterations`, 1);
		const body = this.steps(fields.body, `${at}.body`);
		if (maxIterations === undefined) return undefined;
		if (body.length === 0) return this.fail(`${at}.body`, "must declare at least one step.");
		let until: { readonly empty: string } | undefined;
		if (fields.until !== undefined) {
			const predicate = this.record(fields.until, `${at}.until`);
			if (predicate === undefined) return undefined;
			this.only(predicate, ["empty"], `${at}.until`);
			const empty = this.statePath(predicate.empty, `${at}.until.empty`);
			if (empty === undefined) return undefined;
			until = { empty };
		}
		return { kind: "loop", id, maxIterations, body, ...(until === undefined ? undefined : { until }) };
	}

	role(value: unknown, at: string): FlowRole | undefined {
		const fields = this.record(value, at);
		if (fields === undefined) return undefined;
		this.only(fields, ["label", "systemPrompt", "model", "tools"], at);
		const label = this.text(fields.label, `${at}.label`);
		const systemPrompt = this.text(fields.systemPrompt, `${at}.systemPrompt`);
		if (label === undefined || systemPrompt === undefined) return undefined;
		const tools: string[] = [];
		for (const [index, entry] of this.array(fields.tools ?? [], `${at}.tools`).entries()) {
			const tool = this.text(entry, `${at}.tools[${index}]`);
			if (tool !== undefined) tools.push(tool);
		}
		const model = fields.model === undefined ? undefined : this.text(fields.model, `${at}.model`);
		return { label, systemPrompt, tools, ...(model === undefined ? undefined : { model }) };
	}

	assignment(value: unknown, at: string): FlowAssignment | undefined {
		const fields = this.record(value, at);
		if (fields === undefined) return undefined;
		this.only(fields, ["into", "set", "append", "dedupe", "against", "limit", "when"], at);
		const into = this.statePath(fields.into, `${at}.into`);
		const hasSet = fields.set !== undefined;
		const hasAppend = fields.append !== undefined;
		if (hasSet === hasAppend) return this.fail(at, "must declare exactly one of set or append.");
		const expression = this.expression(hasSet ? fields.set : fields.append, `${at}.${hasSet ? "set" : "append"}`);
		if (into === undefined || expression === undefined) return undefined;
		if (fields.when !== undefined && fields.when !== "present") {
			return this.fail(`${at}.when`, "the only supported value is 'present'.");
		}
		const against = fields.against === undefined ? undefined : this.statePath(fields.against, `${at}.against`);
		const limit = this.count(fields.limit, `${at}.limit`, 1);
		return {
			into,
			operation: hasSet ? "set" : "append",
			value: expression,
			dedupe: this.flag(fields.dedupe, `${at}.dedupe`),
			whenPresent: fields.when === "present",
			...(against === undefined ? undefined : { against }),
			...(limit === undefined ? undefined : { limit }),
		};
	}

	operation(value: unknown, at: string): FlowOperation | undefined {
		const fields = this.record(value, at);
		if (fields === undefined) return undefined;
		if (fields.take !== undefined) {
			this.only(fields, ["take", "count"], at);
			const target = this.statePath(fields.take, `${at}.take`);
			const count = this.count(fields.count, `${at}.count`, 0);
			if (target === undefined || count === undefined) return undefined;
			return { kind: "take", target, count };
		}
		if (fields.clear !== undefined) {
			this.only(fields, ["clear"], at);
			const target = this.statePath(fields.clear, `${at}.clear`);
			return target === undefined ? undefined : { kind: "clear", target };
		}
		if (fields.move !== undefined) {
			this.only(fields, ["move", "into", "dedupe", "against", "limit"], at);
			const from = this.statePath(fields.move, `${at}.move`);
			const into = this.statePath(fields.into, `${at}.into`);
			if (from === undefined || into === undefined) return undefined;
			const against = fields.against === undefined ? undefined : this.statePath(fields.against, `${at}.against`);
			const limit = this.count(fields.limit, `${at}.limit`, 1);
			return {
				kind: "move",
				from,
				into,
				dedupe: this.flag(fields.dedupe, `${at}.dedupe`),
				...(against === undefined ? undefined : { against }),
				...(limit === undefined ? undefined : { limit }),
			};
		}
		return this.fail(at, "must declare one of take, clear, move.");
	}

	/** `state.<key>` and nothing else: a write target is never an expression. */
	statePath(value: unknown, at: string): string | undefined {
		const path = this.text(value, at);
		if (path === undefined) return undefined;
		const parts = path.split(".");
		if (parts.length !== 2 || parts[0] !== "state" || parts[1].length === 0) {
			return this.fail(at, "must name a state slot as 'state.<key>'.");
		}
		return parts[1];
	}

	expression(value: unknown, at: string): FlowExpression | undefined {
		if (typeof value === "string") return this.reference(value, at);
		const fields = this.record(value, at);
		if (fields === undefined) return undefined;
		const built: { name: string; value: FlowExpression }[] = [];
		for (const [name, entry] of Object.entries(fields)) {
			const field = this.expression(entry, `${at}.${name}`);
			if (field !== undefined) built.push({ name, value: field });
		}
		return { kind: "object", fields: built };
	}

	reference(value: string, at: string): FlowExpression | undefined {
		if (!value.startsWith("$")) return { kind: "literal", value };
		const [head, ...rest] = value.slice(1).split(".");
		switch (head) {
			case "input":
				return { kind: "input" };
			case "item":
				return { kind: "item" };
			case "iteration":
				return { kind: "iteration" };
			case "output":
				return { kind: "output", path: rest };
			case "state": {
				const key = rest[0];
				if (key === undefined) return this.fail(at, "must name a state slot as '$state.<key>'.");
				return { kind: "state", key, path: rest.slice(1) };
			}
			default:
				return this.fail(at, `unknown reference '${value}'. Use $input, $item, $iteration, $output.* or $state.*.`);
		}
	}

	schema(value: unknown, at: string): FlowSchema | undefined {
		const fields = this.record(value, at);
		if (fields === undefined) return undefined;
		switch (fields.type) {
			case "string": {
				this.only(fields, ["type", "maxLength", "enum"], at);
				const maxLength = this.count(fields.maxLength, `${at}.maxLength`, 1);
				const choices: string[] = [];
				for (const [index, entry] of this.array(fields.enum ?? [], `${at}.enum`).entries()) {
					const choice = this.text(entry, `${at}.enum[${index}]`);
					if (choice !== undefined) choices.push(choice);
				}
				return {
					type: "string",
					...(maxLength === undefined ? undefined : { maxLength }),
					...(choices.length === 0 ? undefined : { enum: choices }),
				};
			}
			case "number":
			case "integer":
			case "boolean":
				this.only(fields, ["type"], at);
				return { type: fields.type };
			case "array": {
				this.only(fields, ["type", "items", "maxItems"], at);
				const items = this.schema(fields.items, `${at}.items`);
				const maxItems = this.count(fields.maxItems, `${at}.maxItems`, 1);
				if (items === undefined) return undefined;
				if (maxItems === undefined) return this.fail(`${at}.maxItems`, "an array must declare its own bound.");
				return { type: "array", items, maxItems };
			}
			case "object": {
				this.only(fields, ["type", "properties", "required"], at);
				const declared = this.record(fields.properties, `${at}.properties`);
				if (declared === undefined) return undefined;
				const properties: { name: string; schema: FlowSchema }[] = [];
				for (const [name, entry] of Object.entries(declared)) {
					const schema = this.schema(entry, `${at}.properties.${name}`);
					if (schema !== undefined) properties.push({ name, schema });
				}
				const required: string[] = [];
				for (const [index, entry] of this.array(fields.required ?? [], `${at}.required`).entries()) {
					const name = this.text(entry, `${at}.required[${index}]`);
					if (name === undefined) continue;
					if (!properties.some((property) => property.name === name)) {
						this.fail(`${at}.required[${index}]`, `'${name}' is not one of the declared properties.`);
						continue;
					}
					required.push(name);
				}
				return { type: "object", properties, required };
			}
			default:
				return this.fail(`${at}.type`, "must be one of string, number, integer, boolean, array, object.");
		}
	}
}
