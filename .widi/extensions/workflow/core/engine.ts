import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionActions, RuntimeModel } from "../../../../apps/widi/src/core/extension/api.ts";
import type { Flow, FlowAgentStep, FlowFanoutStep, FlowLoopStep, FlowStep } from "../flow/document.ts";
import { checkAgainstSchema, describeSchema, type FlowValue, readJsonAnswer } from "../flow/schema.ts";
import { type EvaluationScope, evaluate, FlowState, renderTemplate } from "../flow/values.ts";
import type { RunJournal } from "./journal.ts";

/**
 * The executor. It owns the control flow - how many passes, how many items, how
 * many at a time - and the model owns the contents of one JSON answer.
 * Every bound it enforces was declared in the flow before the run started.
 */

export interface WorkflowSpend {
	readonly modelCalls: number;
	readonly agentSpawns: number;
	readonly totalTokens: number;
	readonly cost: number;
}

/**
 * What a step reports as it runs. `progress` is the phase for a change inside a
 * step - a fan-out learning how wide it is, an agent starting an attempt - which
 * is where most of what a person wants to watch actually happens.
 */
export interface WorkflowProgress {
	/** Unique per execution: `rounds#0/probe#2/answer`. */
	readonly path: string;
	readonly step: string;
	readonly kind: string;
	readonly phase: "started" | "progress" | "finished";
	readonly iteration: number;
	readonly item: string;
	readonly attempt: number;
	readonly childAgentId: string;
	readonly total: number;
	readonly items: readonly string[];
	readonly ok: boolean;
	readonly detail: string;
	readonly ms: number;
	readonly spend: WorkflowSpend;
	readonly state: { readonly [key: string]: number };
}

/** The fields a phase adds to what the step itself already says. */
interface ProgressDetail {
	readonly attempt?: number;
	readonly childAgentId?: string;
	readonly total?: number;
	readonly items?: readonly string[];
	readonly ok?: boolean;
	readonly detail?: string;
	readonly ms?: number;
}

export interface WorkflowStepRecord {
	readonly step: string;
	readonly kind: string;
	readonly iteration: number;
	readonly item: string;
	readonly detail: string;
	readonly ms: number;
}

export interface WorkflowRunResult {
	readonly status: "completed" | "failed" | "cancelled";
	readonly headline: string;
	readonly body: string;
	readonly spend: WorkflowSpend;
	readonly elapsedMs: number;
	readonly steps: readonly WorkflowStepRecord[];
	readonly state: { readonly [key: string]: FlowValue };
}

export interface WorkflowRunOptions {
	readonly actions: ExtensionActions;
	readonly signal: AbortSignal;
	readonly runId: string;
	readonly journal?: RunJournal;
	onProgress(progress: WorkflowProgress): Promise<void>;
}

export async function runFlow(flow: Flow, input: string, options: WorkflowRunOptions): Promise<WorkflowRunResult> {
	// The wall-clock budget is the one bound that cannot be checked against the
	// declaration, so it is enforced the only way it can be: as a deadline.
	const controller = new AbortController();
	const cancel = (): void => controller.abort();
	options.signal.addEventListener("abort", cancel, { once: true });
	let expired = false;
	const deadline = setTimeout(() => {
		expired = true;
		controller.abort();
	}, flow.budget.wallClockMs);

	const execution = new Execution(flow, options, controller.signal);
	const startedAt = Date.now();
	try {
		await execution.run(flow.steps, { input, iteration: 0, state: execution.state });
		return execution.result("completed", startedAt);
	} catch (error) {
		// A run that stopped early still found what it found, so its state is
		// reported rather than thrown away.
		const stopped = controller.signal.aborted;
		const headline = stopped
			? expired
				? `stopped: the ${flow.budget.wallClockMs} ms wall-clock budget ran out`
				: "stopped on request"
			: describe(error);
		return execution.result(stopped ? "cancelled" : "failed", startedAt, headline);
	} finally {
		clearTimeout(deadline);
		options.signal.removeEventListener("abort", cancel);
	}
}

class Execution {
	readonly state: FlowState;
	private readonly _flow: Flow;
	private readonly _options: WorkflowRunOptions;
	private readonly _signal: AbortSignal;
	private readonly _records: WorkflowStepRecord[] = [];
	private _modelCalls = 0;
	private _agentSpawns = 0;
	private _totalTokens = 0;
	private _cost = 0;

	constructor(flow: Flow, options: WorkflowRunOptions, signal: AbortSignal) {
		this._flow = flow;
		this._options = options;
		this._signal = signal;
		this.state = new FlowState(flow.state);
	}

	async run(steps: readonly FlowStep[], scope: EvaluationScope, prefix = ""): Promise<void> {
		for (const step of steps) {
			this._signal.throwIfAborted();
			const path = prefix === "" ? step.id : `${prefix}/${step.id}`;
			const startedAt = Date.now();
			await this._progress(step, scope, path, "started");
			let detail: string;
			try {
				detail = await this._runStep(step, scope, path);
			} catch (error) {
				// The step that failed is the one worth pointing at, and only this
				// frame knows which it was; the throw carries on unchanged.
				await this._progress(step, scope, path, "finished", {
					ok: false,
					detail: describe(error),
					ms: Date.now() - startedAt,
				});
				throw error;
			}
			const record: WorkflowStepRecord = {
				step: step.id,
				kind: step.kind,
				iteration: scope.iteration,
				item: label(scope.item),
				detail,
				ms: Date.now() - startedAt,
			};
			this._records.push(record);
			await this._options.journal?.write("step", { runId: this._options.runId, ...record });
			await this._progress(step, scope, path, "finished", { ok: true, detail, ms: record.ms });
		}
	}

	result(status: WorkflowRunResult["status"], startedAt: number, headline?: string): WorkflowRunResult {
		const snapshot = this.state.snapshot();
		const items = this._flow.report.items === undefined ? undefined : snapshot[this._flow.report.items];
		const counted = Array.isArray(items) ? `${items.length} items, ` : "";
		return {
			status,
			headline: headline ?? `${counted}${this._modelCalls} model calls`,
			body: this._body(snapshot),
			spend: {
				modelCalls: this._modelCalls,
				agentSpawns: this._agentSpawns,
				totalTokens: this._totalTokens,
				cost: this._cost,
			},
			elapsedMs: Date.now() - startedAt,
			steps: this._records,
			state: snapshot,
		};
	}

	private _body(snapshot: { readonly [key: string]: FlowValue }): string {
		const summary = this._flow.report.summary === undefined ? undefined : snapshot[this._flow.report.summary];
		const items = this._flow.report.items === undefined ? undefined : snapshot[this._flow.report.items];
		const lines: string[] = [];
		if (typeof summary === "string" && summary.length > 0) lines.push(summary, "");
		if (Array.isArray(items)) lines.push(...items.map((item) => `- ${render(item)}`));
		return lines.length === 0 ? "_The run recorded nothing to report._" : lines.join("\n");
	}

	private async _runStep(step: FlowStep, scope: EvaluationScope, path: string): Promise<string> {
		switch (step.kind) {
			case "agent":
				return await this._runAgent(step, scope, path);
			case "transform":
				for (const operation of step.ops) this.state.run(operation);
				return step.ops.length === 1 ? "1 operation" : `${step.ops.length} operations`;
			case "fanout":
				return await this._runFanout(step, scope, path);
			case "loop":
				return await this._runLoop(step, scope, path);
		}
	}

	private async _runLoop(step: FlowLoopStep, scope: EvaluationScope, path: string): Promise<string> {
		let passes = 0;
		for (let iteration = 0; iteration < step.maxIterations; iteration += 1) {
			if (step.until !== undefined && this.state.size(step.until.empty) === 0) break;
			await this.run(step.body, { ...scope, iteration }, `${path}#${iteration}`);
			passes += 1;
		}
		return `${passes} of at most ${step.maxIterations} passes`;
	}

	private async _runFanout(step: FlowFanoutStep, scope: EvaluationScope, path: string): Promise<string> {
		// Truncated here, which is why a flow whose state grew past its own bound
		// overruns nothing: the declaration wins over what the state happens to hold.
		const source = this.state.read(step.over);
		const items = (Array.isArray(source) ? source : []).slice(0, step.maxItems);
		const lanes = Math.min(step.maxConcurrency, items.length);
		// How wide it turned out to be is only knowable here, and it is what a view
		// needs to lay out the lanes before any of them has said anything.
		await this._progress(step, scope, path, "progress", { total: items.length, items: items.map(label) });
		let cursor = 0;
		let failure: unknown;
		const lane = async (): Promise<void> => {
			while (failure === undefined) {
				const index = cursor;
				cursor += 1;
				if (index >= items.length) return;
				try {
					await this.run(step.body, { ...scope, item: items[index] }, `${path}#${index}`);
				} catch (error) {
					failure ??= error;
					return;
				}
			}
		};
		await Promise.all(Array.from({ length: lanes }, () => lane()));
		if (failure !== undefined) throw failure;
		return `${items.length} of at most ${step.maxItems} items, ${lanes} at a time`;
	}

	private async _runAgent(step: FlowAgentStep, scope: EvaluationScope, path: string): Promise<string> {
		const childId = await this._options.actions.spawnAgent({
			origin: {
				kind: "new",
				profileOverride: {
					label: step.role.label,
					systemPrompt: `${step.role.systemPrompt}\n\n${jsonInstruction(step)}`,
					tools: [...step.role.tools],
					projectContext: false,
					skillsListing: false,
					// Required, not a preference: a role assembled from a flow is not a
					// role the runtime could resolve again, so it could never be resumed.
					persist: false,
				},
			},
			model: step.role.model ?? reference(this._options.actions.getModel()),
		});
		this._agentSpawns += 1;
		// Nothing can interrupt a model call from out here, so cancellation reaches
		// the agent making it instead: disposing the child ends the run.
		const stop = (): void => {
			void this._dispose(childId);
		};
		this._signal.addEventListener("abort", stop, { once: true });
		try {
			let correction = renderTemplate(step.task, scope);
			let refused = "";
			for (let attempt = 1; attempt <= step.maxAttempts; attempt += 1) {
				// A retry costs a model call and is why a budget is spent faster than
				// the step count suggests, so it is reported rather than hidden.
				await this._progress(step, scope, path, "progress", { attempt, childAgentId: childId, detail: refused });
				const answer = await this._ask(step, childId, correction);
				const parsed = readJsonAnswer(answer);
				const problems =
					parsed.value === undefined ? [parsed.error ?? "unparseable"] : checkAgainstSchema(parsed.value, step.output);
				if (parsed.value !== undefined && problems.length === 0) {
					await this._options.journal?.write("output", {
						runId: this._options.runId,
						step: step.id,
						item: label(scope.item),
						attempt,
						output: parsed.value,
					});
					const answered: EvaluationScope = { ...scope, output: parsed.value };
					for (const assignment of step.assign) {
						this.state.apply(assignment, evaluate(assignment.value, answered));
					}
					return `attempt ${attempt} of at most ${step.maxAttempts}`;
				}
				// The failure is handed back as the next attempt's instruction: the
				// agent is still there and still holds what it answered last time.
				refused = problems.join(" ");
				correction = `${refused}\n\nAnswer again with a single JSON object and nothing else.`;
			}
			throw new Error(`Step '${step.id}' produced no valid answer in ${step.maxAttempts} attempts.`);
		} finally {
			this._signal.removeEventListener("abort", stop);
			await this._dispose(childId);
		}
	}

	private async _ask(step: FlowAgentStep, childId: string, task: string): Promise<string> {
		const outcome = await this._options.actions.prompt(task, { target: childId });
		this._signal.throwIfAborted();
		if (outcome.kind === "blocked") {
			throw new Error(`Step '${step.id}' was blocked by ${outcome.blockedBy}: ${outcome.reason ?? "no reason given"}.`);
		}
		this._modelCalls += 1;
		this._totalTokens += outcome.message.usage.totalTokens;
		this._cost += outcome.message.usage.cost.total;
		const answer = assistantText(outcome.message);
		// prompt waited for the child's own run. A role carrying tools may have
		// delegated instead of answering, and then its own later turns - not the
		// message prompt returned - are what its report holds.
		if (step.role.tools.length === 0) return answer;
		const idle = await this._options.actions.waitForTreeIdle(childId, { signal: this._signal });
		return idle.agentIds.length > 1 ? ((await this._options.actions.readReport(childId)) ?? answer) : answer;
	}

	/** Always after the answer has been read: a disposed agent has no session left. */
	private async _dispose(agentId: string): Promise<void> {
		try {
			await this._options.actions.disposeAgent(agentId, { scope: "subtree", reason: `flow ${this._flow.name}` });
		} catch {
			// The step is over either way, and a failed teardown is not its result.
		}
	}

	private async _progress(
		step: FlowStep,
		scope: EvaluationScope,
		path: string,
		phase: WorkflowProgress["phase"],
		detail: ProgressDetail = {},
	): Promise<void> {
		const sizes: { [key: string]: number } = {};
		for (const slot of this._flow.state) sizes[slot.key] = this.state.size(slot.key);
		await this._options.onProgress({
			path,
			step: step.id,
			kind: step.kind,
			phase,
			iteration: scope.iteration,
			item: label(scope.item),
			attempt: detail.attempt ?? 0,
			childAgentId: detail.childAgentId ?? "",
			total: detail.total ?? 0,
			items: detail.items ?? [],
			ok: detail.ok ?? true,
			detail: detail.detail ?? "",
			ms: detail.ms ?? 0,
			spend: {
				modelCalls: this._modelCalls,
				agentSpawns: this._agentSpawns,
				totalTokens: this._totalTokens,
				cost: this._cost,
			},
			state: sizes,
		});
	}
}

function jsonInstruction(step: FlowAgentStep): string {
	return [
		"Answer with a single JSON object and nothing else: no prose before it, no prose after it.",
		"It must match this JSON Schema:",
		JSON.stringify(describeSchema(step.output), null, 2),
	].join("\n");
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
}

function label(value: FlowValue | undefined): string {
	if (value === undefined) return "";
	return typeof value === "string" ? value : JSON.stringify(value);
}

function render(value: FlowValue): string {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
	return Object.entries(value)
		.map(([name, field]) => `**${name}**: ${typeof field === "string" ? field : JSON.stringify(field)}`)
		.join(" - ");
}

function reference(model: RuntimeModel): string {
	return `${model.provider}/${model.id}`;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
