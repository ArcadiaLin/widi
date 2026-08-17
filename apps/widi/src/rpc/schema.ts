/**
 * The inbound half of the protocol, as schemas rather than as types.
 *
 * One definition per command, and the TypeScript union is derived from them
 * (`RpcCommand` below) rather than written beside them. Before this, `frames.ts`
 * checked the envelope and cast the rest, which let a typo change behaviour
 * instead of being refused: `mode: "preced"` falls through `decideMessageDelivery`
 * to a plain delivery, so a message meant only to be recorded starts a whole
 * turn on an idle agent. That class of bug is why validation is here at all.
 *
 * Only inbound. A client reading `response` and `event` frames does not need to
 * validate what this runtime sent it, and those payloads wrap core types that
 * core owns; modelling them here would be a second copy to keep in step.
 *
 * Unknown properties are refused. Inbound strictness and outbound tolerance are
 * deliberately asymmetric: a field a client did not mean to send is a typo
 * ("deadlinems" silently means no deadline, and the sample hangs), while a field
 * a client does not recognise on the way out is a newer runtime being polite.
 * A newer client against an older runtime is what `protocolVersion` is for.
 *
 * Where a value belongs to core - a profile override, an agent id's meaning -
 * the schema stays loose on purpose. Core is the source of truth for those
 * shapes, and restating them here would cost a conflict every time core moves.
 */

import { type Static, type TSchema, Type } from "typebox";
import type { AgentProfileOverride } from "../core/agent-profile.ts";
import type { HumanQuestionAnswer, HumanResponse } from "../core/human-request.ts";
import type { JsonValue } from "../utils/json.ts";

const AgentIdSchema = Type.String({ minLength: 1, description: "Id of an agent in this runtime." });

const CommandIdSchema = Type.Optional(
	Type.String({ description: "Echoed on the response, and the only handle `cancel` has on this command." }),
);

const DeadlineSchema = Type.Optional(
	Type.Number({ exclusiveMinimum: 0, description: "Milliseconds this command may wait before it is given up on." }),
);

/**
 * Literal sets core owns. They are restated here because getting one wrong is
 * exactly the failure this file exists to stop, and each is small enough that
 * restating it is cheaper than the alternative.
 *
 * Only one direction of drift can go unnoticed. An extra literal here fails to
 * compile where `server.ts` hands the value to core; a literal core adds and
 * this file misses is refused on the wire, which is loud rather than silent.
 */
const DeliveryModeSchema = Type.Union([Type.Literal("next_turn"), Type.Literal("interrupt"), Type.Literal("precede")]);

const ThinkingLevelSchema = Type.Union([
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

const DisposeScopeSchema = Type.Union([Type.Literal("agent"), Type.Literal("subtree")]);

/** Modelled rather than bridged: a malformed image fails inside the provider call otherwise. */
const ImageContentSchema = Type.Object(
	{
		type: Type.Literal("image"),
		data: Type.String({ description: "Base64 image data." }),
		mimeType: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

/** Opaque to this layer and to core: bounded and frozen, never interpreted. */
const PayloadSchema = Type.Unsafe<JsonValue>(
	Type.Unknown({ description: "Any JSON value. Core bounds its size and reads nothing in it." }),
);

const ProfileOverrideSchema = Type.Unsafe<AgentProfileOverride>(
	Type.Object({}, { additionalProperties: true, description: "Profile fields to override; core defines the shape." }),
);

const SpawnOriginSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("new"),
			profileId: Type.Optional(Type.String({ minLength: 1 })),
			profileOverride: Type.Optional(ProfileOverrideSchema),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("resume"), reference: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("fork"), sourceAgentId: AgentIdSchema, entryId: Type.Optional(Type.String({ minLength: 1 })) },
		{ additionalProperties: false },
	),
]);

function command<Properties extends Parameters<typeof Type.Object>[0]>(cmd: string, properties: Properties) {
	return Type.Object({ ...properties, id: CommandIdSchema }, { additionalProperties: false, title: cmd });
}

/**
 * Every command, keyed by its own name. A map rather than one union: `cmd` is
 * classified before validation, so a bad payload is checked against the schema
 * the client asked for and the error names the field rather than reporting that
 * the frame matched none of seventeen shapes.
 */
export const RPC_COMMAND_SCHEMAS = {
	spawn: command("spawn", {
		cmd: Type.Literal("spawn"),
		origin: SpawnOriginSchema,
		parent: Type.Optional(AgentIdSchema),
		cwd: Type.Optional(Type.String({ minLength: 1 })),
		model: Type.Optional(Type.String({ pattern: "^[^/]+/.+$", description: "Model reference, `provider/id`." })),
		thinkingLevel: Type.Optional(ThinkingLevelSchema),
	}),
	send: command("send", {
		cmd: Type.Literal("send"),
		agentId: AgentIdSchema,
		body: Type.String(),
		mode: DeliveryModeSchema,
		images: Type.Optional(Type.Array(ImageContentSchema)),
	}),
	prompt: command("prompt", {
		cmd: Type.Literal("prompt"),
		agentId: AgentIdSchema,
		body: Type.String(),
		images: Type.Optional(Type.Array(ImageContentSchema)),
		deadlineMs: DeadlineSchema,
	}),
	abort: command("abort", { cmd: Type.Literal("abort"), agentId: AgentIdSchema }),
	dispose: command("dispose", {
		cmd: Type.Literal("dispose"),
		agentId: AgentIdSchema,
		scope: Type.Optional(DisposeScopeSchema),
		reason: Type.Optional(Type.String()),
	}),
	compact: command("compact", {
		cmd: Type.Literal("compact"),
		agentId: AgentIdSchema,
		customInstructions: Type.Optional(Type.String()),
	}),
	wait_idle: command("wait_idle", {
		cmd: Type.Literal("wait_idle"),
		agentId: AgentIdSchema,
		deadlineMs: DeadlineSchema,
	}),
	wait_stop: command("wait_stop", {
		cmd: Type.Literal("wait_stop"),
		agentId: AgentIdSchema,
		deadlineMs: DeadlineSchema,
	}),
	wait_tree_idle: command("wait_tree_idle", {
		cmd: Type.Literal("wait_tree_idle"),
		agentId: AgentIdSchema,
		quietMs: Type.Optional(Type.Number({ minimum: 0, description: "How long the tree must stay idle. Default 250." })),
		deadlineMs: DeadlineSchema,
	}),
	read_report: command("read_report", { cmd: Type.Literal("read_report"), agentId: AgentIdSchema }),
	/**
	 * The one command that is not an orchestrator method. It reads the RPC
	 * layer's own accounting of the events it has already sent, so there is
	 * nothing in core for it to project - see `run-summary.ts`.
	 */
	run_summary: command("run_summary", { cmd: Type.Literal("run_summary") }),
	list_agents: command("list_agents", { cmd: Type.Literal("list_agents") }),
	inspect: command("inspect", { cmd: Type.Literal("inspect"), agentId: AgentIdSchema }),
	set_model: command("set_model", {
		cmd: Type.Literal("set_model"),
		agentId: AgentIdSchema,
		model: Type.String({ pattern: "^[^/]+/.+$", description: "Model reference, `provider/id`." }),
	}),
	set_thinking_level: command("set_thinking_level", {
		cmd: Type.Literal("set_thinking_level"),
		agentId: AgentIdSchema,
		level: ThinkingLevelSchema,
	}),
	/**
	 * Emit onto the extension bus in an extension's name. A client stands where
	 * the TUI host stands, so it declares which extension it speaks for and which
	 * agent the action is about; core stamps both onto the envelope.
	 */
	emit_extension_event: command("emit_extension_event", {
		cmd: Type.Literal("emit_extension_event"),
		agentId: AgentIdSchema,
		extensionId: Type.String({ minLength: 1, description: "The extension this client speaks for." }),
		name: Type.String({ minLength: 1, description: "Event name; `owner:event` by convention." }),
		payload: Type.Optional(PayloadSchema),
	}),
	cancel_human_request: command("cancel_human_request", {
		cmd: Type.Literal("cancel_human_request"),
		requestId: Type.String({ minLength: 1 }),
		reason: Type.Optional(Type.String()),
	}),
	cancel: command("cancel", {
		cmd: Type.Literal("cancel"),
		commandId: Type.String({ minLength: 1, description: "The `id` of a command still in flight." }),
	}),
	shutdown: command("shutdown", { cmd: Type.Literal("shutdown"), reason: Type.Optional(Type.String()) }),
} as const;

export type RpcCommandName = keyof typeof RPC_COMMAND_SCHEMAS;

export type RpcCommand = {
	[Name in RpcCommandName]: Static<(typeof RPC_COMMAND_SCHEMAS)[Name]>;
}[RpcCommandName];

/**
 * Core writes "the human chose nothing" as `value: string | undefined` on a
 * required property. JSON has no way to send that - `undefined` is not a value
 * and `{"type":"undefined"}` is not a schema - so on the wire it is the absent
 * property, and `Unsafe` keeps core's type over a schema that says so. `null` is
 * deliberately not accepted: it would reach core as a third state that none of
 * these unions has a case for.
 */
const noChoice = <Schema extends TSchema>(schema: Schema) => Type.Optional(schema);

const HumanQuestionAnswerSchema = Type.Unsafe<HumanQuestionAnswer>(
	Type.Union([
		Type.Object(
			{ kind: Type.Literal("select"), value: noChoice(Type.String()) },
			{ additionalProperties: false, title: "select" },
		),
		Type.Object(
			{ kind: Type.Literal("multi-select"), values: noChoice(Type.Array(Type.String())) },
			{ additionalProperties: false, title: "multi-select" },
		),
	]),
);

const HumanResponseSchema = Type.Unsafe<HumanResponse>(
	Type.Union([
		Type.Object({ kind: Type.Literal("confirm"), confirmed: Type.Boolean() }, { additionalProperties: false }),
		Type.Object({ kind: Type.Literal("select"), value: noChoice(Type.String()) }, { additionalProperties: false }),
		Type.Object(
			{ kind: Type.Literal("multi-select"), values: noChoice(Type.Array(Type.String())) },
			{ additionalProperties: false },
		),
		Type.Object(
			{ kind: Type.Literal("questions"), answers: Type.Array(HumanQuestionAnswerSchema) },
			{ additionalProperties: false },
		),
		Type.Object({ kind: Type.Literal("input"), value: noChoice(Type.String()) }, { additionalProperties: false }),
		Type.Object({ kind: Type.Literal("custom"), value: Type.Unknown() }, { additionalProperties: false }),
	]),
);

/**
 * Answering a request, or withdrawing from it. The two are exclusive: a frame
 * carrying both says two things about one request and neither can be trusted.
 */
export const RPC_HUMAN_RESPONSE_SCHEMA = Type.Union([
	Type.Object(
		{ type: Type.Literal("human_response"), requestId: Type.String({ minLength: 1 }), response: HumanResponseSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("human_response"), requestId: Type.String({ minLength: 1 }), cancelled: Type.Literal(true) },
		{ additionalProperties: false },
	),
]);

export type RpcHumanResponseFrame = Static<typeof RPC_HUMAN_RESPONSE_SCHEMA>;

export type RpcInbound = RpcCommand | RpcHumanResponseFrame;
