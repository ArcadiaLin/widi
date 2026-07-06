import type { OperationSource } from "./operation-source.ts";

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
