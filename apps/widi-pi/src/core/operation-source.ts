export type OperationSource =
	| { readonly kind: "human"; readonly adapterId?: string }
	| { readonly kind: "agent"; readonly agentId: string }
	| { readonly kind: "extension"; readonly extensionId: string }
	| {
			readonly kind: "tool";
			readonly agentId: string;
			readonly toolCallId: string;
			readonly toolName: string;
	  }
	| { readonly kind: "system" }
	| { readonly kind: "external"; readonly id: string };
