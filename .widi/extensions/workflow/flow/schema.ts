import type { FlowSchema } from "./document.ts";

/**
 * The flow's declared output shape, used twice: once to tell the model what to
 * answer, once to check that it did. The same declaration bounds the answer's
 * size, so a step cannot quietly grow the next step's context.
 */

export type FlowValue = string | number | boolean | null | FlowValue[] | { [key: string]: FlowValue };

/** JSON Schema again, for the prompt. Only what the model needs to see. */
export function describeSchema(schema: FlowSchema): FlowValue {
	switch (schema.type) {
		case "string":
			return {
				type: "string",
				...(schema.maxLength === undefined ? {} : { maxLength: schema.maxLength }),
				...(schema.enum === undefined ? {} : { enum: [...schema.enum] }),
			};
		case "number":
		case "integer":
		case "boolean":
			return { type: schema.type };
		case "array":
			return { type: "array", maxItems: schema.maxItems, items: describeSchema(schema.items) };
		case "object": {
			const properties: { [key: string]: FlowValue } = {};
			for (const property of schema.properties) properties[property.name] = describeSchema(property.schema);
			return { type: "object", properties, required: [...schema.required] };
		}
	}
}

/**
 * Every problem with one answer, phrased for the model: a failed check is fed
 * back as the next attempt's correction, so the text is the repair instruction.
 */
export function checkAgainstSchema(value: unknown, schema: FlowSchema, at = "the answer"): string[] {
	switch (schema.type) {
		case "string": {
			if (typeof value !== "string") return [`${at} must be a string.`];
			const problems: string[] = [];
			if (schema.maxLength !== undefined && value.length > schema.maxLength) {
				problems.push(`${at} must be at most ${schema.maxLength} characters, and was ${value.length}.`);
			}
			if (schema.enum !== undefined && !schema.enum.includes(value)) {
				problems.push(`${at} must be one of: ${schema.enum.join(", ")}.`);
			}
			return problems;
		}
		case "number":
			return typeof value === "number" && Number.isFinite(value) ? [] : [`${at} must be a number.`];
		case "integer":
			return typeof value === "number" && Number.isInteger(value) ? [] : [`${at} must be an integer.`];
		case "boolean":
			return typeof value === "boolean" ? [] : [`${at} must be true or false.`];
		case "array": {
			if (!Array.isArray(value)) return [`${at} must be an array.`];
			const problems: string[] = [];
			if (value.length > schema.maxItems) {
				problems.push(`${at} must have at most ${schema.maxItems} items, and had ${value.length}.`);
			}
			for (const [index, entry] of value.entries()) {
				problems.push(...checkAgainstSchema(entry, schema.items, `${at}[${index}]`));
			}
			return problems;
		}
		case "object": {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${at} must be an object.`];
			const fields = value as { readonly [key: string]: unknown };
			const problems: string[] = [];
			for (const name of schema.required) {
				if (fields[name] === undefined) problems.push(`${at} is missing the required field '${name}'.`);
			}
			for (const property of schema.properties) {
				const field = fields[property.name];
				if (field === undefined) continue;
				problems.push(...checkAgainstSchema(field, property.schema, `${at}.${property.name}`));
			}
			return problems;
		}
	}
}

/**
 * The JSON object out of a model's reply. Fences are tolerated because most
 * models add them whatever the instruction says; anything else is a failed
 * attempt, which is a retry rather than a crash.
 */
export function readJsonAnswer(text: string): { value?: FlowValue; error?: string } {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	const body = (fenced?.[1] ?? text).trim();
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start < 0 || end <= start) return { error: "The answer contained no JSON object." };
	try {
		return { value: JSON.parse(body.slice(start, end + 1)) as FlowValue };
	} catch (error) {
		return { error: `The answer was not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
}
