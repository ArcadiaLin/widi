/**
 * Shared diagnostics contract for core modules.
 *
 * This file is not a stateful runtime service and does not decide policy or UI
 * presentation. It defines the canonical diagnostic shape plus small helpers and
 * compatibility adapters so WIDI-owned modules can emit structured diagnostics
 * directly, while upstream shapes can be normalized at the boundary.
 */

import type {
	PromptTemplateDiagnostic,
	SkillDiagnostic,
} from "@earendil-works/pi-agent-core";
import type { OperationSource } from "./operation-source.ts";

export type DiagnosticSeverity = "info" | "warning" | "error";

export type DiagnosticDisposition = "reported" | "degraded" | "blocked";

export type DiagnosticDomain =
	| "orchestrator"
	| "profile"
	| "resource"
	| "tool"
	| "model"
	| "auth"
	| "settings"
	| "extension";

export type DiagnosticMessageParam = string | number | boolean | null;

export type DiagnosticSource =
	| { readonly kind: "path"; readonly path: string; readonly label?: string }
	| { readonly kind: "profile"; readonly id: string; readonly label?: string }
	| {
			readonly kind: "resource";
			readonly id?: string;
			readonly resourceType?: string;
			readonly path?: string;
			readonly label?: string;
	  }
	| { readonly kind: "tool"; readonly name: string }
	| {
			readonly kind: "extension";
			readonly id: string;
			readonly label?: string;
			readonly version?: string;
			readonly path?: string;
	  }
	| { readonly kind: "settings"; readonly scope: "global" | "project" }
	| { readonly kind: "operation"; readonly source: OperationSource }
	| { readonly kind: "registry"; readonly name: string; readonly key?: string };

export interface DiagnosticRelated {
	readonly source?: DiagnosticSource;
	readonly message?: string;
	readonly details?: Record<string, unknown>;
}

export interface CoreDiagnostic {
	readonly id?: string;
	readonly domain: DiagnosticDomain;
	readonly code: string;
	readonly severity: DiagnosticSeverity;
	readonly disposition: DiagnosticDisposition;
	readonly recoverable: boolean;
	readonly message: string;
	readonly messageTemplate?: string;
	readonly messageParams?: Record<string, DiagnosticMessageParam>;
	readonly source?: DiagnosticSource;
	readonly targetSource?: DiagnosticSource;
	readonly requestedBy?: DiagnosticSource;
	readonly related?: readonly DiagnosticRelated[];
	readonly phase?: "load" | "resolve" | "create" | "resume" | "runtime";
	readonly agentId?: string;
	readonly commandId?: string;
	readonly requestId?: string;
	readonly profileId?: string;
	readonly resourceId?: string;
	readonly toolName?: string;
	readonly extensionId?: string;
	readonly provider?: string;
	readonly modelId?: string;
	readonly details?: Record<string, unknown>;
}

export type OrchestratorDiagnostic = CoreDiagnostic;

export class DiagnosticError extends Error {
	readonly code: CoreDiagnostic["code"];
	readonly diagnostic: CoreDiagnostic;

	constructor(diagnostic: CoreDiagnostic) {
		super(diagnostic.message);
		this.name = "DiagnosticError";
		this.code = diagnostic.code;
		this.diagnostic = diagnostic;
	}
}

export class OrchestratorError extends DiagnosticError {
	declare readonly diagnostic: OrchestratorDiagnostic;

	constructor(diagnostic: OrchestratorDiagnostic) {
		super(diagnostic);
		this.name = "OrchestratorError";
	}
}

export function formatDiagnosticMessage(
	template: string,
	params: Record<string, DiagnosticMessageParam> = {},
): string {
	return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => {
		const value = params[key];
		return value === undefined || value === null ? match : String(value);
	});
}

export function createDiagnostic(
	diagnostic: Omit<CoreDiagnostic, "message"> & {
		readonly message?: string;
	},
): CoreDiagnostic {
	const message =
		diagnostic.message ??
		(diagnostic.messageTemplate
			? formatDiagnosticMessage(
					diagnostic.messageTemplate,
					diagnostic.messageParams,
				)
			: diagnostic.code);
	return { ...diagnostic, message };
}

export function dedupeDiagnostics(
	diagnostics: readonly CoreDiagnostic[],
): CoreDiagnostic[] {
	const seen = new Set<string>();
	const deduped: CoreDiagnostic[] = [];
	for (const diagnostic of diagnostics) {
		const key =
			diagnostic.id ??
			JSON.stringify({
				domain: diagnostic.domain,
				code: diagnostic.code,
				source: diagnostic.source,
				targetSource: diagnostic.targetSource,
				agentId: diagnostic.agentId,
				commandId: diagnostic.commandId,
				requestId: diagnostic.requestId,
				profileId: diagnostic.profileId,
				resourceId: diagnostic.resourceId,
				toolName: diagnostic.toolName,
				extensionId: diagnostic.extensionId,
				provider: diagnostic.provider,
				modelId: diagnostic.modelId,
			});
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(diagnostic);
	}
	return deduped;
}

export function diagnosticToError(diagnostic: CoreDiagnostic): DiagnosticError {
	return new DiagnosticError(diagnostic);
}

type ResourceDiagnosticSource = {
	readonly kind: string;
	readonly path: string;
};

type ResourceDiagnosticContext = {
	readonly agentId?: string;
	readonly profileId?: string;
	readonly disposition?: DiagnosticDisposition;
	readonly phase?: CoreDiagnostic["phase"];
};

export function toCoreDiagnosticFromSkillDiagnostic(
	diagnostic: SkillDiagnostic & { readonly source?: ResourceDiagnosticSource },
	context: ResourceDiagnosticContext = {},
): CoreDiagnostic {
	return createResourceDiagnostic({
		diagnostic,
		resourceType: "skill",
		code: `resource.skill.${diagnostic.code}`,
		context,
	});
}

export function toCoreDiagnosticFromPromptTemplateDiagnostic(
	diagnostic: PromptTemplateDiagnostic & {
		readonly source?: ResourceDiagnosticSource;
	},
	context: ResourceDiagnosticContext = {},
): CoreDiagnostic {
	return createResourceDiagnostic({
		diagnostic,
		resourceType: "prompt_template",
		code: `resource.prompt_template.${diagnostic.code}`,
		context,
	});
}

function createResourceDiagnostic(options: {
	readonly diagnostic: {
		readonly type: "warning";
		readonly code: string;
		readonly message: string;
		readonly path: string;
		readonly source?: ResourceDiagnosticSource;
	};
	readonly resourceType: string;
	readonly code: string;
	readonly context: ResourceDiagnosticContext;
}): CoreDiagnostic {
	const { diagnostic, resourceType, code, context } = options;
	return createDiagnostic({
		domain: "resource",
		code,
		severity: diagnostic.type,
		disposition: context.disposition ?? "reported",
		recoverable: true,
		message: diagnostic.message,
		messageTemplate: "{resourceType} resource diagnostic {code}: {message}",
		messageParams: {
			resourceType,
			code: diagnostic.code,
			message: diagnostic.message,
			path: diagnostic.path,
		},
		source: {
			kind: "resource",
			resourceType,
			path: diagnostic.path,
			label: diagnostic.source?.kind,
		},
		requestedBy: context.profileId
			? { kind: "profile", id: context.profileId }
			: undefined,
		agentId: context.agentId,
		profileId: context.profileId,
		phase: context.phase,
		details: {
			path: diagnostic.path,
			source: diagnostic.source,
			upstreamCode: diagnostic.code,
		},
	});
}

/**
 * Build an orchestrator-domain diagnostic, defaulting domain from the code
 * prefix and disposition to "blocked".
 */
export function createOrchestratorDiagnostic(
	diagnostic: Omit<
		OrchestratorDiagnostic,
		"domain" | "disposition" | "source"
	> & {
		readonly domain?: OrchestratorDiagnostic["domain"];
		readonly disposition?: DiagnosticDisposition;
		readonly source?: DiagnosticSource;
		readonly operationSource?: OperationSource;
	},
): OrchestratorDiagnostic {
	const {
		domain,
		disposition,
		operationSource: inputOperationSource,
		source: inputSource,
		...rest
	} = diagnostic;
	const source = inputSource ?? operationSource(inputOperationSource);
	return {
		...rest,
		domain: domain ?? domainFromDiagnosticCode(diagnostic.code),
		disposition: disposition ?? "blocked",
		source,
	};
}

/** Unwrap an OrchestratorError's diagnostic, or build one from the fallback. */
export function toDiagnostic(
	error: unknown,
	fallback: Omit<
		OrchestratorDiagnostic,
		"domain" | "disposition" | "severity" | "source"
	> & {
		severity?: OrchestratorDiagnostic["severity"];
		disposition?: DiagnosticDisposition;
		operationSource?: OperationSource;
	},
): OrchestratorDiagnostic {
	if (error instanceof OrchestratorError) return error.diagnostic;
	return createOrchestratorDiagnostic({
		severity: fallback.severity ?? "error",
		disposition: fallback.disposition,
		code: fallback.code,
		message: fallback.message,
		operationSource: fallback.operationSource,
		agentId: fallback.agentId,
		requestId: fallback.requestId,
		commandId: fallback.commandId,
		recoverable: fallback.recoverable,
	});
}

function domainFromDiagnosticCode(
	code: string,
): OrchestratorDiagnostic["domain"] {
	const [domain] = code.split(".");
	if (
		domain === "profile" ||
		domain === "resource" ||
		domain === "tool" ||
		domain === "model" ||
		domain === "auth" ||
		domain === "settings" ||
		domain === "extension" ||
		domain === "orchestrator"
	) {
		return domain;
	}
	return "orchestrator";
}

function operationSource(
	source: OperationSource | undefined,
): DiagnosticSource | undefined {
	return source ? { kind: "operation", source } : undefined;
}
