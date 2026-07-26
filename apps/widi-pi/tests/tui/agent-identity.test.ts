import { describe, expect, it } from "vitest";
import type { AgentRecordSnapshot } from "../../src/core/agent-record.ts";
import {
	agentIdentityLabel,
	forkSourceAgentId,
	shortAgentId,
} from "../../src/tui/agent-identity.ts";
import {
	createTuiApplicationState,
	ensureAgentProjection,
} from "../../src/tui/state.ts";

describe("agent identity", () => {
	it("keeps a single agent label compact", () => {
		const state = createTuiApplicationState();
		const source = ensureAgentProjection(state, "widi-dev", "idle");
		source.snapshot = snapshot("widi-dev", "/sessions/source.jsonl");

		expect(agentIdentityLabel(state, source)).toBe("WIDI Dev");
	});

	it("shows source and fork identities when multiple agents are visible", () => {
		const state = createTuiApplicationState();
		const source = ensureAgentProjection(state, "widi-dev", "idle");
		source.snapshot = snapshot("widi-dev", "/sessions/source.jsonl");
		const fork = ensureAgentProjection(
			state,
			"019f784f-4342-781c-8472-93e6547da47e",
			"idle",
		);
		fork.snapshot = snapshot(
			fork.agentId,
			"/sessions/fork.jsonl",
			"/sessions/source.jsonl",
		);
		fork.display.forkedFromAgentId = source.agentId;

		expect(agentIdentityLabel(state, source)).toBe("WIDI Dev [widi-dev]");
		expect(agentIdentityLabel(state, fork)).toBe(
			"WIDI Dev [fork from widi-dev · 547da47e]",
		);
	});

	it("recovers the fork source from live session paths without a fork event", () => {
		const state = createTuiApplicationState();
		const source = ensureAgentProjection(state, "widi-dev", "idle");
		source.snapshot = snapshot("widi-dev", "/sessions/source.jsonl");
		const fork = ensureAgentProjection(
			state,
			"019f784f-4342-781c-8472-93e6547da47e",
			"idle",
		);
		fork.snapshot = snapshot(
			fork.agentId,
			"/sessions/fork.jsonl",
			"/sessions/source.jsonl",
		);

		expect(fork.display.forkedFromAgentId).toBeUndefined();
		expect(forkSourceAgentId(state, fork)).toBe("widi-dev");
		expect(agentIdentityLabel(state, fork)).toBe(
			"WIDI Dev [fork from widi-dev · 547da47e]",
		);
	});

	it("shows the direct source token for a nested fork", () => {
		const state = createTuiApplicationState();
		const source = ensureAgentProjection(state, "widi-dev", "idle");
		source.snapshot = snapshot("widi-dev", "/sessions/source.jsonl");
		const fork = ensureAgentProjection(
			state,
			"019f784f-4342-781c-8472-93e6547da47e",
			"idle",
		);
		fork.snapshot = snapshot(
			fork.agentId,
			"/sessions/fork.jsonl",
			"/sessions/source.jsonl",
		);
		fork.display.forkedFromAgentId = source.agentId;
		const nested = ensureAgentProjection(
			state,
			"019f784f-4342-781c-8472-93e612345678",
			"idle",
		);
		nested.snapshot = snapshot(
			nested.agentId,
			"/sessions/nested.jsonl",
			"/sessions/fork.jsonl",
		);
		nested.display.forkedFromAgentId = fork.agentId;

		expect(forkSourceAgentId(state, nested)).toBe(fork.agentId);
		expect(agentIdentityLabel(state, nested)).toBe(
			"WIDI Dev [fork from 547da47e · 12345678]",
		);
	});

	it("falls back to fork plus the target token when the source is absent", () => {
		const state = createTuiApplicationState();
		const existing = ensureAgentProjection(state, "other", "idle");
		existing.snapshot = snapshot("other", "/sessions/other.jsonl");
		const fork = ensureAgentProjection(
			state,
			"019f784f-4342-781c-8472-93e6547da47e",
			"idle",
		);
		fork.snapshot = snapshot(
			fork.agentId,
			"/sessions/fork.jsonl",
			"/sessions/missing.jsonl",
		);

		expect(agentIdentityLabel(state, fork)).toBe("WIDI Dev [fork · 547da47e]");
		expect(shortAgentId(fork.agentId)).toBe("547da47e");
	});

	it("sanitizes a source session name before rendering fork identity", () => {
		const state = createTuiApplicationState();
		const source = ensureAgentProjection(state, "widi-dev", "idle");
		source.snapshot = snapshot("widi-dev", "/sessions/source.jsonl");
		source.display.sessionName = "\u001b]0;owned\u0007Source\nName\u001b[2J";
		const fork = ensureAgentProjection(
			state,
			"019f784f-4342-781c-8472-93e6547da47e",
			"idle",
		);
		fork.snapshot = snapshot(fork.agentId, "/sessions/fork.jsonl");
		fork.display.forkedFromAgentId = source.agentId;

		expect(agentIdentityLabel(state, fork)).toBe(
			"WIDI Dev [fork from Source Name · 547da47e]",
		);
	});

	it("falls back to the source token when its sanitized session name is empty", () => {
		const state = createTuiApplicationState();
		const source = ensureAgentProjection(state, "widi-dev", "idle");
		source.snapshot = snapshot("widi-dev", "/sessions/source.jsonl");
		source.display.sessionName = "\u001b]0;owned\u0007\u001b[31m\u001b[0m";
		const fork = ensureAgentProjection(
			state,
			"019f784f-4342-781c-8472-93e6547da47e",
			"idle",
		);
		fork.snapshot = snapshot(fork.agentId, "/sessions/fork.jsonl");
		fork.display.forkedFromAgentId = source.agentId;

		expect(agentIdentityLabel(state, fork)).toBe(
			"WIDI Dev [fork from widi-dev · 547da47e]",
		);
	});

	it("sanitizes a long agent id before taking its real suffix", () => {
		const sanitizedAgentId = `${"a".repeat(260)}tail-123`;

		expect(
			shortAgentId(`\u001b]0;owned\u0007${sanitizedAgentId}\u001b[2J`),
		).toBe("tail-123");
	});
});

function snapshot(
	agentId: string,
	path: string,
	parentSessionPath?: string,
): AgentRecordSnapshot {
	return {
		agentId,
		status: "idle",
		profile: { reference: { id: "widi-dev", label: "WIDI Dev" } },
		sessionMetadata: {
			id: agentId,
			createdAt: new Date(0).toISOString(),
			cwd: "/workspace",
			path,
			parentSessionPath,
		},
		model: {
			id: "test-model",
			name: "Test Model",
			api: "anthropic-messages",
			provider: "test",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		},
		hasHarness: true,
		extensionIds: [],
		extensions: [],
		extensionSnapshot: {
			extensionIds: [],
			extensions: [],
			hooks: [],
			toolContributions: [],
			providerContributions: [],
			stale: { stale: false },
		},
		resourceDiagnostics: [],
		extensionDiagnostics: [],
		diagnostics: [],
	};
}
