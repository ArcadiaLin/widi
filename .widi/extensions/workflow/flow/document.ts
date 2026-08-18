/**
 * A flow as it exists after parsing: data all the way down, no functions.
 *
 * That is the difference from a workflow written in code. Everything the engine
 * needs - the bounds it enforces, the paths it reads and writes, the shape it
 * holds a model to - is a value the audit can walk before anything runs.
 */

/** Where a value comes from: `$input`, `$item`, `$iteration`, `$output.x`, `$state.y`. */
export type FlowExpression =
	| { readonly kind: "input" }
	| { readonly kind: "item" }
	| { readonly kind: "iteration" }
	| { readonly kind: "output"; readonly path: readonly string[] }
	| { readonly kind: "state"; readonly key: string; readonly path: readonly string[] }
	| { readonly kind: "literal"; readonly value: string }
	/** An object built field by field, each value an expression of its own. */
	| { readonly kind: "object"; readonly fields: readonly { readonly name: string; readonly value: FlowExpression }[] };

/** A declared slot of the flow's state. Sets hold strings; lists hold anything. */
export type FlowStateKind = "list" | "set" | "text";

export interface FlowStateDeclaration {
	readonly key: string;
	readonly kind: FlowStateKind;
}

/** The subset of JSON Schema a flow may declare. Deliberately small. */
export type FlowSchema =
	| { readonly type: "string"; readonly maxLength?: number; readonly enum?: readonly string[] }
	| { readonly type: "number" | "integer" | "boolean" }
	| { readonly type: "array"; readonly items: FlowSchema; readonly maxItems: number }
	| {
			readonly type: "object";
			readonly properties: readonly { readonly name: string; readonly schema: FlowSchema }[];
			readonly required: readonly string[];
	  };

export interface FlowAssignment {
	readonly into: string;
	readonly operation: "set" | "append";
	readonly value: FlowExpression;
	readonly dedupe: boolean;
	/** A state set the value must not already be in. */
	readonly against?: string;
	readonly limit?: number;
	/** Skip the assignment when the value is absent or empty, rather than writing "". */
	readonly whenPresent: boolean;
}

export interface FlowRole {
	readonly label: string;
	readonly systemPrompt: string;
	/** `provider/id`; the host agent's own model when absent. */
	readonly model?: string;
	readonly tools: readonly string[];
}

export interface FlowAgentStep {
	readonly kind: "agent";
	readonly id: string;
	readonly role: FlowRole;
	readonly task: string;
	readonly output: FlowSchema;
	readonly assign: readonly FlowAssignment[];
	/**
	 * How many times the model may be asked before the step fails. A retry is a
	 * model call like any other, so the budget prices every attempt.
	 */
	readonly maxAttempts: number;
	/** Only a role with tools may run more than one call per attempt. */
	readonly maxModelCalls?: number;
}

export type FlowOperation =
	| { readonly kind: "take"; readonly target: string; readonly count: number }
	| { readonly kind: "clear"; readonly target: string }
	| {
			readonly kind: "move";
			readonly from: string;
			readonly into: string;
			readonly dedupe: boolean;
			readonly against?: string;
			readonly limit?: number;
	  };

export interface FlowTransformStep {
	readonly kind: "transform";
	readonly id: string;
	readonly ops: readonly FlowOperation[];
}

export interface FlowFanoutStep {
	readonly kind: "fanout";
	readonly id: string;
	readonly over: string;
	readonly maxItems: number;
	readonly maxConcurrency: number;
	readonly body: readonly FlowStep[];
}

export interface FlowLoopStep {
	readonly kind: "loop";
	readonly id: string;
	readonly maxIterations: number;
	/** Early exit; it can only shorten a run, never extend one. */
	readonly until?: { readonly empty: string };
	readonly body: readonly FlowStep[];
}

export type FlowStep = FlowAgentStep | FlowTransformStep | FlowFanoutStep | FlowLoopStep;

export interface FlowBudget {
	readonly modelCalls: number;
	readonly agentSpawns: number;
	readonly wallClockMs: number;
}

export type FlowJournalRecord = "run" | "step" | "output" | "result";

/** Where a run writes its own record. Nothing is written unless a flow asks. */
export interface FlowJournal {
	readonly path: string;
	readonly records: readonly FlowJournalRecord[];
}

export interface FlowReport {
	readonly summary?: string;
	readonly items?: string;
}

export interface Flow {
	readonly name: string;
	readonly version: number;
	readonly description?: string;
	readonly budget: FlowBudget;
	readonly state: readonly FlowStateDeclaration[];
	readonly steps: readonly FlowStep[];
	readonly journal?: FlowJournal;
	readonly report: FlowReport;
	/** Absolute path of the file this came from; the journal resolves against it. */
	readonly source: string;
}
