import { describe, expect, it } from "vitest";
import type { AgentOrchestrator } from "../../src/core/agent-orchestrator.ts";
import {
	type AgentProfile,
	AgentProfileRegistry,
	InMemoryProfileStorageBackend,
} from "../../src/core/agent-profile.ts";
import {
	EXTENSION_API_VERSION,
	type ExtensionModule,
	MIN_SUPPORTED_EXTENSION_API_VERSION,
} from "../../src/core/extension/index.ts";
import type { OrchestratorEvent } from "../../src/core/types.ts";
import { createThirdPartyExtension } from "../extensions/third-party-extension.ts";
import {
	createOrchestrator,
	defaultProfile,
	MemoryExecutionEnv,
} from "../helpers/orchestrator.ts";

async function createThirdPartyOrchestrator(module: ExtensionModule): Promise<{
	orchestrator: AgentOrchestrator;
	events: OrchestratorEvent[];
}> {
	const profile: AgentProfile = {
		...defaultProfile,
		id: "third-party-profile",
		label: "Third Party Profile",
		persist: false,
		extensions: ["third-party"],
	};
	const env = new MemoryExecutionEnv();
	const orchestrator = await createOrchestrator(env, {
		defaultProfileId: profile.id,
		profileRegistry: new AgentProfileRegistry(
			InMemoryProfileStorageBackend.fromProfiles([{ profile }]),
		),
	});
	orchestrator.registerExtension("third-party", module);
	const events: OrchestratorEvent[] = [];
	orchestrator.subscribe((event) => {
		events.push(event);
	});
	return { orchestrator, events };
}

async function createThirdPartyHarness(module: ExtensionModule): Promise<{
	orchestrator: AgentOrchestrator;
	agentId: string;
	events: OrchestratorEvent[];
}> {
	const { orchestrator, events } = await createThirdPartyOrchestrator(module);
	const agentId = await orchestrator.spawnAgent();
	return { orchestrator, agentId, events };
}

describe("third-party extension consumer", () => {
	it("combines tool and command registrations through the public contract only", async () => {
		const { definition } = createThirdPartyExtension({
			tdd: "test-driven development",
		});
		const { orchestrator, agentId } = await createThirdPartyHarness(definition);

		expect(orchestrator.getAgentTools(agentId).toolNames).toContain("tp_echo");
		expect(
			orchestrator.inspectAgent(agentId).extensionSnapshot.commands,
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					command: expect.objectContaining({
						name: "tp-note",
						placement: "line",
					}),
				}),
				expect.objectContaining({
					command: expect.objectContaining({
						name: "tp-term",
						placement: "inline",
					}),
				}),
			]),
		);
	});

	it("refuses to spawn an agent whose profile requires an incompatible extension", async () => {
		let activated = false;
		const { orchestrator, events } = await createThirdPartyOrchestrator({
			apiVersion: EXTENSION_API_VERSION + 1,
			activate: () => {
				activated = true;
			},
		});

		// A blocked extension diagnostic fails the spawn, the same family as
		// activation_failed: the profile's extension dependency cannot be met.
		await expect(orchestrator.spawnAgent()).rejects.toThrow(
			/targets extension API version/,
		);
		expect(activated).toBe(false);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.version_incompatible",
					extensionId: "third-party",
					severity: "error",
					details: expect.objectContaining({
						declaredApiVersion: EXTENSION_API_VERSION + 1,
						supportedApiVersions: {
							min: MIN_SUPPORTED_EXTENSION_API_VERSION,
							max: EXTENSION_API_VERSION,
						},
					}),
				}),
			}),
		);
		// The refusal names the real reason - not a missing factory.
		expect(events).not.toContainEqual(
			expect.objectContaining({
				type: "diagnostic",
				diagnostic: expect.objectContaining({
					code: "extension.factory_missing",
				}),
			}),
		);
	});

	it("accepts a bare factory as targeting the current api version", async () => {
		const { orchestrator, agentId } = await createThirdPartyHarness((api) => {
			api.registerCommand({
				name: "tp-bare",
				handler: () => {},
			});
		});

		expect(
			orchestrator.inspectAgent(agentId).extensionSnapshot.commands,
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					command: expect.objectContaining({ name: "tp-bare" }),
				}),
			]),
		);
		expect(
			orchestrator.inspectAgent(agentId).extensionDiagnostics,
		).not.toContainEqual(
			expect.objectContaining({ code: "extension.version_incompatible" }),
		);
	});
});
