/**
 * Shared diagnostic contract for core modules.
 *
 * A diagnostic is a plain reported fact: who it concerns (agentId/extensionId),
 * a stable code, and human-readable text. There is no domain/disposition/phase
 * metadata - severity plus code is the whole model.
 */

export type DiagnosticSeverity = "warning" | "error";

export interface CoreDiagnostic {
	readonly severity: DiagnosticSeverity;
	readonly code: string;
	readonly message: string;
	readonly agentId?: string;
	readonly extensionId?: string;
}

export type OrchestratorDiagnostic = CoreDiagnostic;

export class OrchestratorError extends Error {
	readonly code: CoreDiagnostic["code"];
	readonly diagnostic: OrchestratorDiagnostic;

	constructor(diagnostic: OrchestratorDiagnostic) {
		super(diagnostic.message);
		this.name = "OrchestratorError";
		this.code = diagnostic.code;
		this.diagnostic = diagnostic;
	}
}

/** Unwrap an OrchestratorError's diagnostic, or build one from the fallback. */
export function toDiagnostic(
	error: unknown,
	fallback: { readonly code: string; readonly message: string; readonly agentId?: string },
): OrchestratorDiagnostic {
	if (error instanceof OrchestratorError) return error.diagnostic;
	return { severity: "error", ...fallback };
}
