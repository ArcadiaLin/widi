import type { ExtensionDefinition } from "../../../apps/widi/src/core/extension/api.ts";
import { activatePlanExtension } from "./lib.ts";

const extension: ExtensionDefinition = {
	apiVersion: 1,
	activate: (api) => activatePlanExtension(api),
};

export default extension;
