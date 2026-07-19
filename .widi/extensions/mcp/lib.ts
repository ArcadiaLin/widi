import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	getDefaultEnvironment,
	StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TSchema } from "typebox";
import type {
	ExtensionActivationApi,
	ToolDefinition,
} from "../../../apps/widi-pi/src/core/extension/api.ts";

export interface McpStdioServerConfig {
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
}

export interface McpHttpServerConfig {
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpConfig {
	readonly servers: Readonly<Record<string, McpServerConfig>>;
}

export type McpConfigLoadResult =
	| { readonly kind: "ok"; readonly config: McpConfig }
	| { readonly kind: "missing" }
	| { readonly kind: "invalid"; readonly message: string };

export async function loadMcpConfig(
	configPath: string,
): Promise<McpConfigLoadResult> {
	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch {
		return { kind: "missing" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: "invalid", message: `${configPath} is not valid JSON.` };
	}
	try {
		return { kind: "ok", config: parseMcpConfig(parsed) };
	} catch (error) {
		return { kind: "invalid", message: errorMessage(error) };
	}
}

function parseMcpConfig(value: unknown): McpConfig {
	if (!isRecord(value) || !isRecord(value.mcpServers)) {
		throw new Error("Config must be an object with an 'mcpServers' object.");
	}
	const servers: Record<string, McpServerConfig> = {};
	for (const [name, entry] of Object.entries(value.mcpServers)) {
		servers[name] = parseServerConfig(name, entry);
	}
	return { servers };
}

function parseServerConfig(name: string, entry: unknown): McpServerConfig {
	if (!isRecord(entry)) {
		throw new Error(`Server '${name}' must be an object.`);
	}
	const hasCommand = typeof entry.command === "string";
	const hasUrl = typeof entry.url === "string";
	if (hasCommand === hasUrl) {
		throw new Error(
			`Server '${name}' must set exactly one of 'command' (stdio) or 'url' (http).`,
		);
	}
	if (hasCommand) {
		const args = entry.args === undefined
			? undefined
			: parseStringArray(entry.args, `Server '${name}' args`);
		const env = parseOptionalStringRecord(entry.env, `Server '${name}' env`);
		return {
			command: entry.command as string,
			args,
			env: env ? expandEnvRecord(env, name) : undefined,
		};
	}
	const headers = parseOptionalStringRecord(
		entry.headers,
		`Server '${name}' headers`,
	);
	return {
		url: entry.url as string,
		headers: headers ? expandEnvRecord(headers, name) : undefined,
	};
}

function expandEnvRecord(
	record: Readonly<Record<string, string>>,
	serverName: string,
): Record<string, string> {
	const expanded: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		expanded[key] = expandEnvValue(value, serverName);
	}
	return expanded;
}

function expandEnvValue(value: string, serverName: string): string {
	return value.replace(
		/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
		(_match, name: string) => {
			const envValue = process.env[name];
			if (envValue === undefined) {
				throw new Error(
					`Server '${serverName}' references unset environment variable ${name}.`,
				);
			}
			return envValue;
		},
	);
}

function parseStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`${label} must be an array of strings.`);
	}
	return value as string[];
}

function parseOptionalStringRecord(
	value: unknown,
	label: string,
): Record<string, string> | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error(`${label} must be an object of strings.`);
	}
	const record: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") {
			throw new Error(`${label}.${key} must be a string.`);
		}
		record[key] = item;
	}
	return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface McpToolInfo {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema: Record<string, unknown>;
}

export interface McpContentBlock {
	readonly type: string;
	readonly text?: string;
	readonly data?: string;
	readonly mimeType?: string;
	readonly resource?: { readonly uri?: string; readonly text?: string };
}

export interface McpCallToolResult {
	readonly content?: readonly McpContentBlock[];
	readonly isError?: boolean;
}

export interface McpClientHandle {
	listTools(): Promise<readonly McpToolInfo[]>;
	callTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<McpCallToolResult>;
	close(): Promise<void>;
}

export type McpClientFactory = (
	serverName: string,
	config: McpServerConfig,
) => Promise<McpClientHandle>;

export function createSdkClientFactory(
	connectTimeoutMs: number,
): McpClientFactory {
	return async (serverName, config) => {
		const client = new Client({ name: "widi-mcp", version: "0.1.0" });
		const transport = "command" in config
			? new StdioClientTransport({
					command: config.command,
					args: [...(config.args ?? [])],
					env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
				})
			: new StreamableHTTPClientTransport(new URL(config.url), {
					requestInit: { headers: { ...(config.headers ?? {}) } },
				});
		await withTimeout(
			client.connect(transport),
			connectTimeoutMs,
			`Timed out connecting to MCP server '${serverName}' after ${connectTimeoutMs}ms.`,
		);
		return {
			listTools: async () =>
				(await client.listTools()).tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema as Record<string, unknown>,
				})),
			callTool: (name, args) =>
				client.callTool({ name, arguments: args }) as Promise<McpCallToolResult>,
			close: () => client.close(),
		};
	};
}

export class McpServerConnection {
	readonly serverName: string;
	private readonly _config: McpServerConfig;
	private readonly _factory: McpClientFactory;
	private _client: McpClientHandle | null = null;

	constructor(
		serverName: string,
		config: McpServerConfig,
		factory: McpClientFactory,
	) {
		this.serverName = serverName;
		this._config = config;
		this._factory = factory;
	}

	async connect(): Promise<readonly McpToolInfo[]> {
		this._client = await this._factory(this.serverName, this._config);
		return this._client.listTools();
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<McpCallToolResult> {
		try {
			return await this._requireClient().callTool(name, args);
		} catch {
			await this._reconnect();
			return this._requireClient().callTool(name, args);
		}
	}

	private _requireClient(): McpClientHandle {
		if (!this._client) {
			throw new Error(`MCP server '${this.serverName}' is not connected.`);
		}
		return this._client;
	}

	private async _reconnect(): Promise<void> {
		const stale = this._client;
		this._client = null;
		if (stale) {
			await stale.close().catch(() => undefined);
		}
		this._client = await this._factory(this.serverName, this._config);
	}
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

type McpToolResultContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export function mcpToolName(serverName: string, toolName: string): string {
	const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "_");
	return `mcp_${sanitize(serverName)}_${sanitize(toolName)}`;
}

export function createMcpToolDefinitions(
	connection: McpServerConnection,
	tools: readonly McpToolInfo[],
): ToolDefinition[] {
	return tools.map((tool) => ({
		name: mcpToolName(connection.serverName, tool.name),
		label: `${connection.serverName}: ${tool.name}`,
		description: tool.description ??
			`MCP tool '${tool.name}' from server '${connection.serverName}'.`,
		parameters: tool.inputSchema as unknown as TSchema,
		strict: false,
		execute: async (_toolCallId, params) => {
			const result = await connection.callTool(tool.name, toArgsObject(params));
			const content = flattenMcpContent(result.content ?? []);
			if (result.isError) {
				const text = content
					.map((block) => block.type === "text" ? block.text : `[${block.type} content]`)
					.join("\n");
				throw new Error(
					text.length > 0
						? text
						: `MCP tool '${tool.name}' on server '${connection.serverName}' reported an error.`,
				);
			}
			return { content, details: undefined };
		},
	}));
}

function toArgsObject(params: unknown): Record<string, unknown> {
	return isRecord(params) ? params : {};
}

function flattenMcpContent(
	blocks: readonly McpContentBlock[],
): McpToolResultContent[] {
	const flattened: McpToolResultContent[] = [];
	for (const block of blocks) {
		if (block.type === "text" && block.text !== undefined) {
			flattened.push({ type: "text", text: block.text });
		} else if (
			block.type === "image" &&
			block.data !== undefined &&
			block.mimeType !== undefined
		) {
			flattened.push({
				type: "image",
				data: block.data,
				mimeType: block.mimeType,
			});
		} else if (block.type === "resource") {
			flattened.push({
				type: "text",
				text: block.resource?.text ?? block.resource?.uri ?? "[resource]",
			});
		} else {
			flattened.push({ type: "text", text: `[unsupported ${block.type} content]` });
		}
	}
	return flattened.length > 0 ? flattened : [{ type: "text", text: "(no content)" }];
}

export interface McpExtensionOptions {
	readonly configPath: string;
	readonly clientFactory?: McpClientFactory;
	readonly connectTimeoutMs?: number;
}

interface McpDeferredDiagnostic {
	readonly code: string;
	readonly message: string;
}

export async function activateMcpExtension(
	api: ExtensionActivationApi,
	options: McpExtensionOptions,
): Promise<void> {
	const loadResult = await loadMcpConfig(options.configPath);
	if (loadResult.kind === "missing") {
		return;
	}
	if (loadResult.kind === "invalid") {
		deferDiagnostics(api, [
			{
				code: "config_invalid",
				message: `MCP config is invalid: ${loadResult.message}`,
			},
		]);
		return;
	}
	const factory = options.clientFactory ??
		createSdkClientFactory(options.connectTimeoutMs ?? 15000);
	const failures: McpDeferredDiagnostic[] = [];
	await Promise.all(
		Object.entries(loadResult.config.servers).map(
			async ([serverName, serverConfig]) => {
				const connection = new McpServerConnection(serverName, serverConfig, factory);
				try {
					const tools = await connection.connect();
					for (const definition of createMcpToolDefinitions(connection, tools)) {
						api.registerTool(definition);
					}
				} catch (error) {
					failures.push({
						code: "server_connect_failed",
						message: `MCP server '${serverName}' is unavailable: ${errorMessage(error)}`,
					});
				}
			},
		),
	);
	if (failures.length > 0) {
		deferDiagnostics(api, failures);
	}
}

// The activation API has no diagnostic channel, so activation-time failures
// are reported through the agent_spawned observer, which the orchestrator
// emits right after activation completes.
function deferDiagnostics(
	api: ExtensionActivationApi,
	drafts: readonly McpDeferredDiagnostic[],
): void {
	api.observe("agent_spawned", (_event, context) => {
		for (const draft of drafts) {
			void context.actions.reportDiagnostic({
				severity: "warning",
				disposition: "degraded",
				code: draft.code,
				message: draft.message,
			});
		}
	});
}
