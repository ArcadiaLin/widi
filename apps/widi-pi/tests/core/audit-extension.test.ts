import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import {
	type AgentProfile,
	AgentProfileRegistry,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
import type {
	ExtensionCustomEntry,
	ExtensionFactory,
} from "../../src/core/extension/index.ts";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import {
	AUDIT_EVENT_ENTRY_TYPE,
	AUDIT_VERDICT_ENTRY_TYPE,
	type AuditEventEntry,
	type AuditPolicy,
	type AuditVerdictEntry,
	createAuditExtension,
} from "../extensions/audit-extension.ts";
import {
	createOrchestrator,
	MemoryExecutionEnv,
	requireAgentHarness,
	requireAgentRecord,
} from "../helpers/orchestrator.ts";

interface AuditHarnessOptions {
	readonly capabilities?: AgentProfile["capabilities"];
	readonly beforeAudit?: readonly {
		readonly id: string;
		readonly factory: ExtensionFactory;
	}[];
}

async function createAuditHarness(
	policy: AuditPolicy,
	options: AuditHarnessOptions = {},
): Promise<{
	orchestrator: AgentOrchestrator;
	agentId: string;
	events: OrchestratorEvent[];
}> {
	const extensionProfile: AgentProfile = {
		id: "audit-profile",
		label: "Audit Profile",
		systemPrompt: "Audit test prompt",
		persist: false,
		extensions: [...(options.beforeAudit ?? []).map(({ id }) => id), "audit"],
		capabilities: options.capabilities,
	};
	const env = new MemoryExecutionEnv();
	const orchestrator = await createOrchestrator(env, {
		defaultProfileId: extensionProfile.id,
		profileRegistry: new AgentProfileRegistry(
			InMemoryProfileStorageBackend.fromProfiles([
				{ profile: extensionProfile },
			]),
		),
	});
	for (const extension of options.beforeAudit ?? []) {
		orchestrator.registerExtensionFactory(extension.id, extension.factory);
	}
	orchestrator.registerExtensionFactory("audit", createAuditExtension(policy));
	const events: OrchestratorEvent[] = [];
	orchestrator.subscribe((event) => {
		events.push(event);
	});
	const agentId = await orchestrator.spawnAgent();
	return { orchestrator, agentId, events };
}

async function runToolCall(
	orchestrator: AgentOrchestrator,
	agentId: string,
	toolCallId: string,
	toolName: string,
): Promise<unknown> {
	const harness = requireAgentHarness(orchestrator, agentId);
	const handlers = (
		harness as unknown as {
			handlers: Map<string, Set<(event: unknown) => Promise<unknown>>>;
		}
	).handlers;
	const handler = Array.from(handlers.get("tool_call") ?? [])[0];
	if (!handler) throw new Error("Missing tool_call harness hook.");
	return await handler({
		type: "tool_call",
		toolCallId,
		toolName,
		input: {},
	});
}

async function emitHarnessEvent(
	orchestrator: AgentOrchestrator,
	agentId: string,
	event: AgentHarnessEvent,
): Promise<void> {
	const handler = (
		orchestrator as unknown as {
			_handleAgentHarnessEvent(
				agentId: string,
				event: AgentHarnessEvent,
			): Promise<void>;
		}
	)._handleAgentHarnessEvent.bind(orchestrator);
	await handler(agentId, event);
}

async function readAuditEntries<T>(
	orchestrator: AgentOrchestrator,
	agentId: string,
	type: string,
): Promise<ExtensionCustomEntry<T>[]> {
	const runner = requireAgentRecord(orchestrator, agentId).extensionRunner;
	if (!runner) throw new Error("Missing audit extension runner.");
	return await runner.createContext("audit").session.findEntries<T>(type);
}

describe("audit extension consumer", () => {
	it("records selected harness events and default-allow verdicts", async () => {
		const { orchestrator, agentId } = await createAuditHarness({
			recordEvents: ["turn_start"],
		});

		await emitHarnessEvent(orchestrator, agentId, { type: "turn_start" });
		await expect(
			runToolCall(orchestrator, agentId, "call-1", "read"),
		).resolves.toBeUndefined();

		await expect(
			readAuditEntries<AuditEventEntry>(
				orchestrator,
				agentId,
				AUDIT_EVENT_ENTRY_TYPE,
			),
		).resolves.toMatchObject([{ data: { eventType: "turn_start" } }]);
		await expect(
			readAuditEntries<AuditVerdictEntry>(
				orchestrator,
				agentId,
				AUDIT_VERDICT_ENTRY_TYPE,
			),
		).resolves.toMatchObject([
			{
				data: {
					toolCallId: "call-1",
					toolName: "read",
					outcome: "allowed",
					decidedBy: "default",
				},
			},
		]);
	});

	it("blocks explicit deny rules and records the reason", async () => {
		const { orchestrator, agentId } = await createAuditHarness({
			deny: [{ tool: "write", reason: "Repository is read-only." }],
		});

		await expect(
			runToolCall(orchestrator, agentId, "call-2", "write"),
		).resolves.toEqual({
			block: true,
			reason: "Repository is read-only.",
		});
		await expect(
			readAuditEntries<AuditVerdictEntry>(
				orchestrator,
				agentId,
				AUDIT_VERDICT_ENTRY_TYPE,
			),
		).resolves.toMatchObject([
			{
				data: {
					toolCallId: "call-2",
					outcome: "blocked",
					decidedBy: "deny_rule",
					reason: "Repository is read-only.",
				},
			},
		]);
	});

	it("asks the human with an injected extension source", async () => {
		const { orchestrator, agentId } = await createAuditHarness({
			ask: [{ tool: "write", prompt: "Allow this write?" }],
		});
		const responses = ["allow", "deny"];
		const requests: unknown[] = [];
		orchestrator.registerClient({
			id: "human",
			requestHuman: async (request) => {
				requests.push(request);
				return { kind: "select", value: responses.shift() };
			},
		});

		await expect(
			runToolCall(orchestrator, agentId, "call-3", "write"),
		).resolves.toBeUndefined();
		await expect(
			runToolCall(orchestrator, agentId, "call-4", "write"),
		).resolves.toEqual({
			block: true,
			reason: "Human approval was denied.",
		});
		expect(requests).toEqual([
			expect.objectContaining({
				source: { kind: "extension", extensionId: "audit" },
				kind: "select",
				title: "Approve tool write",
				options: ["allow", "deny"],
			}),
			expect.objectContaining({
				source: { kind: "extension", extensionId: "audit" },
			}),
		]);
		await expect(
			readAuditEntries<AuditVerdictEntry>(
				orchestrator,
				agentId,
				AUDIT_VERDICT_ENTRY_TYPE,
			),
		).resolves.toMatchObject([
			{
				data: { toolCallId: "call-3", outcome: "allowed", decidedBy: "human" },
			},
			{
				data: { toolCallId: "call-4", outcome: "blocked", decidedBy: "human" },
			},
		]);
	});

	it("fails closed when the profile denies human requests", async () => {
		const { orchestrator, agentId, events } = await createAuditHarness(
			{ ask: [{ tool: "write", prompt: "Allow this write?" }] },
			{ capabilities: { canRequestUser: false } },
		);

		await expect(
			runToolCall(orchestrator, agentId, "call-5", "write"),
		).resolves.toMatchObject({
			block: true,
			reason: expect.stringContaining("Human approval unavailable"),
		});
		await expect(
			readAuditEntries<AuditVerdictEntry>(
				orchestrator,
				agentId,
				AUDIT_VERDICT_ENTRY_TYPE,
			),
		).resolves.toMatchObject([
			{
				data: {
					toolCallId: "call-5",
					outcome: "blocked",
					decidedBy: "human_unavailable",
				},
			},
		]);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "diagnostic",
					diagnostic: expect.objectContaining({
						code: "extension.action_failed",
						extensionId: "audit",
						details: expect.objectContaining({ action: "requestHuman" }),
					}),
				}),
			]),
		);
	});

	it("keeps auditing when another observer fails", async () => {
		const broken: ExtensionFactory = (api) => {
			api.observe("agent_harness_event", () => {
				throw new Error("observer exploded");
			});
		};
		const { orchestrator, agentId, events } = await createAuditHarness(
			{ recordEvents: ["turn_start"] },
			{ beforeAudit: [{ id: "broken", factory: broken }] },
		);

		await emitHarnessEvent(orchestrator, agentId, { type: "turn_start" });

		await expect(
			readAuditEntries<AuditEventEntry>(
				orchestrator,
				agentId,
				AUDIT_EVENT_ENTRY_TYPE,
			),
		).resolves.toMatchObject([{ data: { eventType: "turn_start" } }]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.handler_failed",
					extensionId: "broken",
					details: { eventName: "agent_harness_event" },
				}),
			}),
		);
	});

	it("fails closed on another tool interceptor error without disabling audit", async () => {
		let firstCall = true;
		const broken: ExtensionFactory = (api) => {
			api.intercept("tool_call", () => {
				if (!firstCall) return undefined;
				firstCall = false;
				throw new Error("tool policy exploded");
			});
		};
		const { orchestrator, agentId, events } = await createAuditHarness(
			{},
			{ beforeAudit: [{ id: "broken", factory: broken }] },
		);

		await expect(
			runToolCall(orchestrator, agentId, "call-6", "read"),
		).resolves.toEqual({ block: true });
		await expect(
			runToolCall(orchestrator, agentId, "call-7", "read"),
		).resolves.toBeUndefined();
		await expect(
			readAuditEntries<AuditVerdictEntry>(
				orchestrator,
				agentId,
				AUDIT_VERDICT_ENTRY_TYPE,
			),
		).resolves.toMatchObject([
			{ data: { toolCallId: "call-7", outcome: "allowed" } },
		]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.handler_failed",
					extensionId: "broken",
					details: { eventName: "tool_call" },
				}),
			}),
		);
	});
});
