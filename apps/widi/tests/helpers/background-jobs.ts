/**
 * A background job runtime wired to nothing but memory, for tests that need
 * real job capabilities rather than a whole orchestrator.
 *
 * Everything a caller has to reach for is here: the owner's capabilities, the
 * events the runtime published, and the messages it sent through its sink.
 */

import {
	type BackgroundJobChange,
	type BackgroundJobEvent,
	type BackgroundJobExecution,
	type BackgroundJobHost,
	BackgroundJobRuntime,
	type BackgroundJobRuntimeOptions,
	type BackgroundJobSnapshot,
	type OwnerAttachment,
} from "../../src/core/background/index.ts";
import type { CoreDiagnostic } from "../../src/core/diagnostics.ts";
import type { MessageRequest, MessageSinkBinding } from "../../src/core/message.ts";

/** One message the runtime handed to its sink, with the identity it used. */
export interface RecordedJobMessage {
	readonly binding: MessageSinkBinding;
	readonly request: MessageRequest;
}

export interface JobRuntimeHarness {
	readonly runtime: BackgroundJobRuntime;
	readonly attachment: OwnerAttachment;
	readonly host: BackgroundJobHost;
	readonly agentId: string;
	readonly events: BackgroundJobEvent[];
	readonly deliveries: RecordedJobMessage[];
	readonly diagnostics: CoreDiagnostic[];
	attach(agentId: string, sessionId?: string): Promise<OwnerAttachment>;
}

export async function createJobRuntimeHarness(
	options: BackgroundJobRuntimeOptions & { readonly agentId?: string } = {},
): Promise<JobRuntimeHarness> {
	const { agentId = "owner", ...runtimeOptions } = options;
	const events: BackgroundJobEvent[] = [];
	const deliveries: RecordedJobMessage[] = [];
	const diagnostics: CoreDiagnostic[] = [];
	const runtime = new BackgroundJobRuntime(
		{
			openOwnerStore: async () => undefined,
			messageSinkFor: (binding) => ({
				send: async (request) => {
					deliveries.push({ binding, request });
					return { kind: "accepted" };
				},
			}),
			publish: async (event) => {
				events.push(event);
			},
			diagnose: async (diagnostic) => {
				diagnostics.push(diagnostic);
			},
		},
		runtimeOptions,
	);
	const attach = async (id: string, sessionId = `${id}-session`) =>
		await runtime.attachAgent({ agentId: id, sessionId });
	const attachment = await attach(agentId);
	return { runtime, attachment, host: attachment.host, agentId, events, deliveries, diagnostics, attach };
}

/**
 * Collect every observable change on this owner from now on. Only the watcher
 * sees a settlement's outcome; the published event carries the snapshot alone.
 */
export function collectJobChanges(host: BackgroundJobHost): {
	readonly changes: BackgroundJobChange[];
	readonly stop: () => void;
} {
	const changes: BackgroundJobChange[] = [];
	const stop = host.watch().start((change) => {
		changes.push(change);
	});
	return { changes, stop };
}

/** Start a local job and take it straight into the background, as a tool would. */
export function startBackgroundedJob(
	host: BackgroundJobHost,
	input: { toolCallId?: string; toolName?: string; name?: string; description?: string } = {},
): { readonly execution: BackgroundJobExecution; readonly job: BackgroundJobSnapshot } {
	const started = host.startLocal({
		toolCallId: input.toolCallId ?? "call-1",
		toolName: input.toolName ?? "bash",
		...(input.name === undefined ? undefined : { name: input.name }),
		...(input.description === undefined ? undefined : { description: input.description }),
	});
	if (!started.ok) throw new Error(`Expected a local job, got ${started.reason}.`);
	const accepted = started.execution.acceptBackground();
	if (!accepted.ok) throw new Error(`Expected the job to background, got ${accepted.reason}.`);
	return { execution: started.execution, job: accepted.job };
}
