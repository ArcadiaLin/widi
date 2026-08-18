import { EXTENSION_API_VERSION, type ExtensionDefinition } from "../../../apps/widi/src/core/extension/api.ts";
import type { TuiExtensionModule } from "../../../apps/widi/src/tui/extension-host/index.ts";
import { activateWorkflowCore } from "./core/index.ts";
import { activateWorkflowTui } from "./tui/index.ts";

/**
 * workflow: an executor for flows whose cost can be read off their declaration.
 *
 * It ships no flow of its own. A flow is a YAML file in the workflow directory
 * beside this extension; the engine browses that directory, prices what it
 * finds, and refuses anything that cannot prove it fits its own budget.
 *
 *   protocol.ts   what crosses the bus, and nothing else
 *   flow/         the format: parse, audit, price, discover, and the values
 *   core/         the half inside an agent: the trigger, the engine, the journal
 *   tui/          the half in the terminal: three commands and a wait
 *
 * `core/` and `tui/` never import each other; both read `flow/` and
 * `protocol.ts`, which import no WIDI runtime API at all.
 */
const extension: ExtensionDefinition = {
	apiVersion: EXTENSION_API_VERSION,
	activate: (api) => activateWorkflowCore(api),
};

export const tui: TuiExtensionModule = { apiVersion: 1, activate: (api) => activateWorkflowTui(api) };

export default extension;
