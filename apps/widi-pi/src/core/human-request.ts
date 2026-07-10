import {
	createOrchestratorDiagnostic,
	type OrchestratorDiagnostic,
	OrchestratorError,
	toDiagnostic,
} from "./diagnostics.ts";
import {
	agentIdFromOperationSource,
	type OperationSource,
} from "./operation-source.ts";
import type { AgentId } from "./types.ts";

export type HumanRequestKind =
	| "confirm"
	| "select"
	| "input"
	| "custom"
	| "argumentsCompletion";

export interface HumanRequest {
	source: OperationSource;
	kind: HumanRequestKind;
	title: string;
	message?: string;
	options?: readonly string[];
	placeholder?: string;
	// Whether the client should offer free-form input alongside options.
	// Absent means the kind's inherent form (input: always, confirm/select:
	// never). Free input is a literal value: never parsed as a command.
	allowFreeInput?: boolean;
	payload?: unknown;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export type HumanRequestDraft = Omit<HumanRequest, "source">;

export interface HumanRequestEnvelope extends Omit<HumanRequest, "signal"> {
	id: string;
	createdAt: string;
}

export type HumanResponse =
	| { kind: "confirm"; confirmed: boolean }
	| { kind: "select"; value: string | undefined }
	| { kind: "input"; value: string | undefined }
	| { kind: "custom"; value: unknown };

export interface ToolHumanHost {
	request(request: HumanRequestDraft): Promise<HumanResponse>;
}

export type HumanRequestEvent =
	| {
			readonly type: "human_request_pending";
			agentId?: AgentId;
			request: HumanRequestEnvelope;
	  }
	| {
			readonly type: "human_request_resolved";
			agentId?: AgentId;
			requestId: string;
			response: HumanResponse;
			completedAt: string;
	  }
	| {
			readonly type: "human_request_timeout";
			agentId?: AgentId;
			requestId: string;
			completedAt: string;
	  }
	| {
			readonly type: "human_request_cancelled";
			agentId?: AgentId;
			requestId: string;
			reason?: string;
			completedAt: string;
	  };

export type HumanRequestHandler = (
	request: HumanRequestEnvelope,
	signal?: AbortSignal,
) => Promise<HumanResponse>;

export interface HumanRequestBrokerHost {
	findHumanRequestHandler(): HumanRequestHandler | undefined;
	emit(event: HumanRequestEvent): Promise<void>;
	publishDiagnostic(diagnostic: OrchestratorDiagnostic): Promise<void>;
	recordAgentLifecycleFailure(
		agentId: AgentId,
		code: string,
		message: string,
		error: unknown,
	): Promise<void>;
}

interface PendingHumanRequest {
	agentId?: AgentId;
	cancel(reason?: string): Promise<void>;
}

export class HumanRequestBroker {
	private readonly host: HumanRequestBrokerHost;
	private readonly pendingRequests: Map<string, PendingHumanRequest> =
		new Map();
	private nextRequestId = 1;

	constructor(host: HumanRequestBrokerHost) {
		this.host = host;
	}

	async request(
		request: HumanRequest,
		options: { agentId?: AgentId } = {},
	): Promise<HumanResponse> {
		const requestHuman = this.host.findHumanRequestHandler();
		const requestId = this.createRequestId();
		const agentId =
			options.agentId ?? agentIdFromOperationSource(request.source);
		const envelope: HumanRequestEnvelope = {
			...request,
			id: requestId,
			createdAt: now(),
		};

		if (!requestHuman) {
			const diagnostic = createOrchestratorDiagnostic({
				severity: "error",
				code: "orchestrator.human_request_unhandled",
				message: "No orchestrator client can handle human requests.",
				operationSource: request.source,
				agentId,
				requestId,
				recoverable: true,
			});
			await this.host.publishDiagnostic(diagnostic);
			throw new OrchestratorError(diagnostic);
		}

		const controller = new AbortController();
		const abortFromCaller = () => controller.abort();

		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		let cancelPending: (reason?: string) => Promise<void> = async () => {};
		try {
			if (request.signal?.aborted) {
				throw new OrchestratorError(
					createOrchestratorDiagnostic({
						severity: "error",
						code: "orchestrator.human_request_aborted",
						message: "Human request was aborted.",
						operationSource: request.source,
						agentId,
						requestId,
						recoverable: true,
					}),
				);
			}
			const responsePromise = new Promise<HumanResponse>((resolve, reject) => {
				let settled = false;
				let abortHandler: (() => void) | undefined;
				let callerAbortRegistered = false;
				const cleanup = () => {
					if (timeoutId) clearTimeout(timeoutId);
					if (callerAbortRegistered) {
						request.signal?.removeEventListener("abort", abortFromCaller);
					}
					if (abortHandler) {
						controller.signal.removeEventListener("abort", abortHandler);
					}
				};
				const rejectWithDiagnostic = (
					diagnostic: OrchestratorDiagnostic,
					beforeReject?: () => void,
				) => {
					if (settled) return;
					settled = true;
					cleanup();
					beforeReject?.();
					reject(new OrchestratorError(diagnostic));
				};
				abortHandler = () => {
					rejectWithDiagnostic(
						createOrchestratorDiagnostic({
							severity: "error",
							code: "orchestrator.human_request_aborted",
							message: "Human request was aborted.",
							operationSource: request.source,
							agentId,
							requestId,
							recoverable: true,
						}),
					);
				};
				controller.signal.addEventListener("abort", abortHandler, {
					once: true,
				});
				if (request.signal?.aborted) {
					controller.abort();
				} else {
					request.signal?.addEventListener("abort", abortFromCaller, {
						once: true,
					});
					callerAbortRegistered = request.signal !== undefined;
				}
				cancelPending = async (reason) => {
					if (settled) return;
					await this.host.emit({
						type: "human_request_cancelled",
						agentId,
						requestId,
						reason,
						completedAt: now(),
					});
					rejectWithDiagnostic(
						createOrchestratorDiagnostic({
							severity: "error",
							code: "orchestrator.human_request_cancelled",
							message: reason
								? `Human request was cancelled: ${reason}`
								: "Human request was cancelled.",
							operationSource: request.source,
							agentId,
							requestId,
							recoverable: true,
						}),
						() => controller.abort(),
					);
				};
				if (request.timeoutMs !== undefined) {
					timeoutId = setTimeout(() => {
						void this.host.emit({
							type: "human_request_timeout",
							agentId,
							requestId,
							completedAt: now(),
						});
						rejectWithDiagnostic(
							createOrchestratorDiagnostic({
								severity: "error",
								code: "orchestrator.human_request_timeout",
								message: "Human request timed out.",
								operationSource: request.source,
								agentId,
								requestId,
								recoverable: true,
							}),
							() => controller.abort(),
						);
					}, request.timeoutMs);
				}
				requestHuman(envelope, controller.signal).then(
					(value) => {
						if (settled) return;
						settled = true;
						cleanup();
						resolve(value);
					},
					(error) => {
						if (settled) return;
						settled = true;
						cleanup();
						reject(error);
					},
				);
			});
			this.pendingRequests.set(requestId, {
				agentId,
				cancel: (reason) => cancelPending(reason),
			});
			await this.host.emit({
				type: "human_request_pending",
				agentId,
				request: envelope,
			});
			const response = await responsePromise;
			this.pendingRequests.delete(requestId);
			await this.host.emit({
				type: "human_request_resolved",
				agentId,
				requestId,
				response,
				completedAt: now(),
			});
			return response;
		} catch (error) {
			this.pendingRequests.delete(requestId);
			const diagnostic = toDiagnostic(error, {
				code: "orchestrator.command_failed",
				message: error instanceof Error ? error.message : String(error),
				operationSource: request.source,
				agentId,
				requestId,
				recoverable: true,
			});
			await this.host.publishDiagnostic(diagnostic);
			throw new OrchestratorError(diagnostic);
		}
	}

	async cancel(requestId: string, reason?: string): Promise<boolean> {
		const pending = this.pendingRequests.get(requestId);
		if (!pending) return false;
		await pending.cancel(reason);
		return true;
	}

	async cancelForAgent(agentId: AgentId, reason: string): Promise<void> {
		for (const [requestId, pending] of [...this.pendingRequests]) {
			if (pending.agentId !== agentId) continue;
			try {
				await pending.cancel(reason);
			} catch (error) {
				await this.host.recordAgentLifecycleFailure(
					agentId,
					"orchestrator.agent_dispose_failed",
					`Failed to cancel human request ${requestId} for agent ${agentId}: ${formatError(error)}`,
					error,
				);
			}
			this.pendingRequests.delete(requestId);
		}
	}

	async cancelAll(reason: string): Promise<void> {
		for (const [requestId, pending] of [...this.pendingRequests]) {
			try {
				await pending.cancel(reason);
			} catch (error) {
				await this.host.publishDiagnostic(
					createOrchestratorDiagnostic({
						severity: "warning",
						disposition: "reported",
						code: "orchestrator.dispose_all_failed",
						message: `Failed to cancel human request ${requestId}: ${formatError(error)}`,
						requestId,
						phase: "runtime",
						recoverable: true,
					}),
				);
			}
			this.pendingRequests.delete(requestId);
		}
	}

	private createRequestId(): string {
		const id = `human-request-${this.nextRequestId}`;
		this.nextRequestId += 1;
		return id;
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function now(): string {
	return new Date().toISOString();
}
