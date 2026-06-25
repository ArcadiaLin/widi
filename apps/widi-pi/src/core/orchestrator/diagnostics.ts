import type { OperationSource } from "./commands.ts";

export type OrchestratorDiagnosticSeverity = "warning" | "error";

export interface OrchestratorDiagnostic {
	severity: OrchestratorDiagnosticSeverity;
	code:
		| "orchestrator_command_failed"
		| "orchestrator_client_failed"
		| "agent_profile_resolution_failed"
		| "agent_profile_disabled"
		| "agent_profile_override_not_persistable"
		| "human_request_unhandled"
		| "human_request_timeout"
		| "human_request_aborted"
		| "human_request_cancelled";
	message: string;
	source?: OperationSource;
	agentId?: string;
	requestId?: string;
	commandId?: string;
	recoverable: boolean;
}

export class OrchestratorError extends Error {
	readonly code: OrchestratorDiagnostic["code"];
	readonly diagnostic: OrchestratorDiagnostic;

	constructor(diagnostic: OrchestratorDiagnostic) {
		super(diagnostic.message);
		this.name = "OrchestratorError";
		this.code = diagnostic.code;
		this.diagnostic = diagnostic;
	}
}
