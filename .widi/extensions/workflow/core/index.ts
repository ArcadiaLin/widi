import type { ExtensionActivationApi } from "../../../../apps/widi/src/core/extension/api.ts";
import { installWorkflowRunner } from "./runner.ts";

/**
 * The core half: one runtime per agent, and the only half that can run a
 * workflow at all. An extension cannot call a model directly - it spawns an
 * agent and prompts it - and both of those need an agent to be bound to.
 */
export function activateWorkflowCore(api: ExtensionActivationApi): void {
	installWorkflowRunner(api);
}
