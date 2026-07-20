import { fileURLToPath } from "node:url";
import type { ExtensionDefinition } from "../../../apps/widi-pi/src/core/extension/api.ts";
import { activateMcpExtension } from "./lib.ts";

const configPath = fileURLToPath(new URL("../../mcp.json", import.meta.url));

const extension: ExtensionDefinition = {
	apiVersion: 1,
	activate: (api) => activateMcpExtension(api, { configPath }),
};

export default extension;
