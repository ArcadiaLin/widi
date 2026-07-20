import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
	activateMcpExtension,
	createMcpToolDefinitions,
	loadMcpConfig,
	type McpCallToolResult,
	type McpClientFactory,
	type McpClientHandle,
	McpServerConnection,
	type McpToolInfo,
	mcpToolName,
} from "../../../../.widi/extensions/mcp/lib.ts";
import type {
	ExtensionActivationApi,
	ExtensionDiagnosticDraft,
	ToolDefinition,
	ToolExecutionContext,
} from "../../src/core/extension/api.ts";

async function writeConfig(content: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "widi-mcp-test-"));
	const path = join(dir, "mcp.json");
	await writeFile(path, content, "utf8");
	return path;
}

describe("loadMcpConfig", () => {
	it("returns missing when the file does not exist", async () => {
		const result = await loadMcpConfig(
			join(tmpdir(), "widi-mcp-definitely-absent.json"),
		);
		expect(result).toEqual({ kind: "missing" });
	});

	it("returns invalid for malformed JSON", async () => {
		const result = await loadMcpConfig(await writeConfig("{ not json"));
		expect(result.kind).toBe("invalid");
	});

	it("parses stdio and http servers", async () => {
		const result = await loadMcpConfig(
			await writeConfig(
				JSON.stringify({
					mcpServers: {
						fs: {
							command: "npx",
							args: ["-y", "server-fs"],
							env: { MODE: "ro" },
						},
						remote: {
							url: "https://example.com/mcp",
							headers: { Authorization: "Bearer x" },
						},
					},
				}),
			),
		);
		expect(result).toEqual({
			kind: "ok",
			config: {
				servers: {
					fs: {
						command: "npx",
						args: ["-y", "server-fs"],
						env: { MODE: "ro" },
					},
					remote: {
						url: "https://example.com/mcp",
						headers: { Authorization: "Bearer x" },
					},
				},
			},
		});
	});

	it("expands $VAR values from process.env", async () => {
		process.env.WIDI_MCP_TEST_TOKEN = "secret-token";
		try {
			const result = await loadMcpConfig(
				await writeConfig(
					JSON.stringify({
						mcpServers: {
							remote: {
								url: "https://example.com/mcp",
								headers: { Authorization: "Bearer $WIDI_MCP_TEST_TOKEN" },
							},
						},
					}),
				),
			);
			expect(result).toEqual({
				kind: "ok",
				config: {
					servers: {
						remote: {
							url: "https://example.com/mcp",
							headers: { Authorization: "Bearer secret-token" },
						},
					},
				},
			});
		} finally {
			delete process.env.WIDI_MCP_TEST_TOKEN;
		}
	});

	it("returns invalid when a referenced env var is unset", async () => {
		const result = await loadMcpConfig(
			await writeConfig(
				JSON.stringify({
					mcpServers: {
						remote: {
							url: "https://example.com/mcp",
							headers: { Authorization: "Bearer $WIDI_MCP_UNSET_VAR" },
						},
					},
				}),
			),
		);
		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") {
			expect(result.message).toContain("WIDI_MCP_UNSET_VAR");
		}
	});

	it("returns invalid when an entry has both command and url", async () => {
		const result = await loadMcpConfig(
			await writeConfig(
				JSON.stringify({
					mcpServers: {
						bad: { command: "npx", url: "https://example.com/mcp" },
					},
				}),
			),
		);
		expect(result.kind).toBe("invalid");
	});

	it("returns invalid when an entry has neither command nor url", async () => {
		const result = await loadMcpConfig(
			await writeConfig(
				JSON.stringify({
					mcpServers: { bad: { args: [] } },
				}),
			),
		);
		expect(result.kind).toBe("invalid");
	});
});

describe("McpServerConnection", () => {
	it("connects and lists tools through the injected factory", async () => {
		const factory: McpClientFactory = async () => ({
			listTools: async () => [
				{ name: "echo", description: "Echo.", inputSchema: { type: "object" } },
			],
			callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
			close: async () => {},
		});
		const connection = new McpServerConnection(
			"fake",
			{ command: "true" },
			factory,
		);
		const tools = await connection.connect();
		expect(tools).toEqual([
			{ name: "echo", description: "Echo.", inputSchema: { type: "object" } },
		]);
	});

	it("reconnects and retries once when callTool throws", async () => {
		let factoryCalls = 0;
		const factory: McpClientFactory = async () => {
			factoryCalls += 1;
			const failFirst = factoryCalls === 1;
			return {
				listTools: async () => [],
				callTool: async (): Promise<McpCallToolResult> => {
					if (failFirst) {
						throw new Error("transport closed");
					}
					return { content: [{ type: "text", text: "recovered" }] };
				},
				close: async () => {},
			};
		};
		const connection = new McpServerConnection(
			"fake",
			{ command: "true" },
			factory,
		);
		await connection.connect();
		const result = await connection.callTool("echo", {});
		expect(result).toEqual({ content: [{ type: "text", text: "recovered" }] });
		expect(factoryCalls).toBe(2);
	});

	it("propagates the error when the retry also fails", async () => {
		const factory: McpClientFactory = async () => ({
			listTools: async () => [],
			callTool: async (): Promise<McpCallToolResult> => {
				throw new Error("still broken");
			},
			close: async () => {},
		});
		const connection = new McpServerConnection(
			"fake",
			{ command: "true" },
			factory,
		);
		await connection.connect();
		await expect(connection.callTool("echo", {})).rejects.toThrow(
			"still broken",
		);
	});

	it("works against a real MCP server over InMemoryTransport", async () => {
		const server = new Server(
			{ name: "fake", version: "0.0.1" },
			{ capabilities: { tools: {} } },
		);
		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: [
				{
					name: "echo",
					description: "Echo text.",
					inputSchema: {
						type: "object",
						properties: { text: { type: "string" } },
						required: ["text"],
					},
				},
			],
		}));
		server.setRequestHandler(CallToolRequestSchema, async (request) => ({
			content: [
				{
					type: "text",
					text: `echo: ${String((request.params.arguments as { text?: string }).text ?? "")}`,
				},
			],
		}));
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);

		const factory: McpClientFactory = async () => {
			const client = new Client({ name: "widi-test", version: "0.0.1" });
			await client.connect(clientTransport);
			return {
				listTools: async () =>
					(await client.listTools()).tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema as Record<string, unknown>,
					})),
				callTool: (name, args) =>
					client.callTool({
						name,
						arguments: args,
					}) as Promise<McpCallToolResult>,
				close: () => client.close(),
			};
		};

		const connection = new McpServerConnection(
			"fake",
			{ command: "true" },
			factory,
		);
		const tools = await connection.connect();
		expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
		const result = await connection.callTool("echo", { text: "hi" });
		expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
		await server.close();
	});
});

const idleContext: ToolExecutionContext<unknown> = {
	signal: undefined,
	onUpdate: undefined,
	extension: undefined,
	human: undefined,
};

async function connectedFake(
	callTool: McpClientHandle["callTool"],
): Promise<McpServerConnection> {
	const factory: McpClientFactory = async () => ({
		listTools: async () => [],
		callTool,
		close: async () => {},
	});
	const connection = new McpServerConnection(
		"fake",
		{ command: "true" },
		factory,
	);
	await connection.connect();
	return connection;
}

describe("mcpToolName", () => {
	it("prefixes and sanitizes names", () => {
		expect(mcpToolName("my server", "do.thing")).toBe("mcp_my_server_do_thing");
		expect(mcpToolName("plain", "tool")).toBe("mcp_plain_tool");
	});
});

describe("createMcpToolDefinitions", () => {
	const tools: McpToolInfo[] = [
		{
			name: "echo",
			description: "Echo text.",
			inputSchema: { type: "object", properties: { text: { type: "string" } } },
		},
		{ name: "no-desc", inputSchema: { type: "object" } },
	];

	it("maps MCP tools to prefixed tool definitions", async () => {
		const definitions = createMcpToolDefinitions(
			await connectedFake(async () => ({ content: [] })),
			tools,
		);
		expect(definitions.map((definition) => definition.name)).toEqual([
			"mcp_fake_echo",
			"mcp_fake_no-desc",
		]);
		expect(definitions[0].label).toBe("fake: echo");
		expect(definitions[0].description).toBe("Echo text.");
		expect(definitions[1].description).toContain("no-desc");
		expect(definitions[0].parameters).toEqual(tools[0].inputSchema);
		expect(definitions[0].strict).toBe(false);
	});

	it("flattens text, image, and resource blocks into tool result content", async () => {
		const definitions = createMcpToolDefinitions(
			await connectedFake(async () => ({
				content: [
					{ type: "text", text: "hello" },
					{ type: "image", data: "aW1n", mimeType: "image/png" },
					{
						type: "resource",
						resource: { uri: "file:///x", text: "file body" },
					},
					{ type: "audio" },
				],
			})),
			tools,
		);
		const result = await definitions[0].execute(
			"call-1",
			{ text: "hi" },
			idleContext,
		);
		expect(result.content).toEqual([
			{ type: "text", text: "hello" },
			{ type: "image", data: "aW1n", mimeType: "image/png" },
			{ type: "text", text: "file body" },
			{ type: "text", text: "[unsupported audio content]" },
		]);
	});

	it("returns a placeholder when the result has no content", async () => {
		const definitions = createMcpToolDefinitions(
			await connectedFake(async () => ({})),
			tools,
		);
		const result = await definitions[0].execute("call-1", {}, idleContext);
		expect(result.content).toEqual([{ type: "text", text: "(no content)" }]);
	});

	it("throws the flattened text when the MCP result is an error", async () => {
		const definitions = createMcpToolDefinitions(
			await connectedFake(async () => ({
				isError: true,
				content: [{ type: "text", text: "boom" }],
			})),
			tools,
		);
		await expect(
			definitions[0].execute("call-1", {}, idleContext),
		).rejects.toThrow("boom");
	});

	it("passes non-object params through as empty arguments", async () => {
		let received: Record<string, unknown> | null = null;
		const definitions = createMcpToolDefinitions(
			await connectedFake(async (_name, args) => {
				received = args;
				return { content: [{ type: "text", text: "ok" }] };
			}),
			tools,
		);
		await definitions[0].execute("call-1", "not-an-object", idleContext);
		expect(received).toEqual({});
	});
});

interface FakeActivation {
	api: ExtensionActivationApi;
	tools: ToolDefinition[];
	observers: ((event: unknown, context: unknown) => void)[];
	diagnostics: ExtensionDiagnosticDraft[];
	disposeHandlers: (() => Promise<void> | void)[];
	fireSpawned(): Promise<void>;
	fireDispose(): Promise<void>;
}

function createFakeActivation(): FakeActivation {
	const tools: ToolDefinition[] = [];
	const observers: ((event: unknown, context: unknown) => void)[] = [];
	const diagnostics: ExtensionDiagnosticDraft[] = [];
	const disposeHandlers: (() => Promise<void> | void)[] = [];
	const context = {
		actions: {
			reportDiagnostic: async (draft: ExtensionDiagnosticDraft) => {
				diagnostics.push(draft);
			},
		},
	};
	const api = {
		extensionId: "mcp",
		agentId: "agent-1",
		profileId: "test",
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
		patchTool: () => {
			throw new Error("not used");
		},
		contributeResources: () => {
			throw new Error("not used");
		},
		registerProvider: () => {
			throw new Error("not used");
		},
		observe: (
			_name: string,
			handler: (event: unknown, context: unknown) => void,
		) => {
			observers.push(handler);
		},
		intercept: () => {
			throw new Error("not used");
		},
		onDispose: (handler: () => Promise<void> | void) => {
			disposeHandlers.push(handler);
		},
	} as unknown as ExtensionActivationApi;
	return {
		api,
		tools,
		observers,
		diagnostics,
		disposeHandlers,
		fireSpawned: async () => {
			for (const observer of observers) {
				await observer({ type: "agent_spawned" }, context);
			}
		},
		fireDispose: async () => {
			for (const handler of disposeHandlers) {
				await handler();
			}
		},
	};
}

const echoFactory: McpClientFactory = async () => ({
	listTools: async () => [
		{ name: "echo", description: "Echo.", inputSchema: { type: "object" } },
	],
	callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
	close: async () => {},
});

describe("activateMcpExtension", () => {
	it("registers nothing and stays silent when the config is missing", async () => {
		const fake = createFakeActivation();
		await activateMcpExtension(fake.api, {
			configPath: join(tmpdir(), "widi-mcp-definitely-absent.json"),
			clientFactory: echoFactory,
		});
		expect(fake.tools).toEqual([]);
		expect(fake.observers).toEqual([]);
	});

	it("registers tools from every reachable server and reports failures on agent_spawned", async () => {
		const configPath = await writeConfig(
			JSON.stringify({
				mcpServers: {
					good: { command: "good-cmd" },
					bad: { command: "bad-cmd" },
				},
			}),
		);
		const factory: McpClientFactory = async (serverName) => {
			if (serverName === "bad") {
				throw new Error("spawn bad-cmd ENOENT");
			}
			return echoFactory(serverName, { command: "good-cmd" });
		};
		const fake = createFakeActivation();
		await activateMcpExtension(fake.api, {
			configPath,
			clientFactory: factory,
		});
		expect(fake.tools.map((tool) => tool.name)).toEqual(["mcp_good_echo"]);
		expect(fake.diagnostics).toEqual([]);
		await fake.fireSpawned();
		expect(fake.diagnostics).toHaveLength(1);
		expect(fake.diagnostics[0].severity).toBe("warning");
		expect(fake.diagnostics[0].disposition).toBe("degraded");
		expect(fake.diagnostics[0].code).toBe("server_connect_failed");
		expect(fake.diagnostics[0].message).toContain("bad");
		expect(fake.diagnostics[0].message).toContain("spawn bad-cmd ENOENT");
	});

	it("reports an invalid config on agent_spawned and registers no tools", async () => {
		const configPath = await writeConfig("{ not json");
		const fake = createFakeActivation();
		await activateMcpExtension(fake.api, {
			configPath,
			clientFactory: echoFactory,
		});
		expect(fake.tools).toEqual([]);
		await fake.fireSpawned();
		expect(fake.diagnostics).toHaveLength(1);
		expect(fake.diagnostics[0].code).toBe("config_invalid");
	});

	it("closes every server connection when the extension is disposed", async () => {
		const configPath = await writeConfig(
			JSON.stringify({
				mcpServers: {
					good: { command: "good-cmd" },
					bad: { command: "bad-cmd" },
				},
			}),
		);
		const closed: string[] = [];
		const factory: McpClientFactory = async (serverName) => {
			if (serverName === "bad") {
				throw new Error("spawn bad-cmd ENOENT");
			}
			return {
				listTools: async () => [
					{
						name: "echo",
						description: "Echo.",
						inputSchema: { type: "object" },
					},
				],
				callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
				close: async () => {
					closed.push(serverName);
				},
			};
		};
		const fake = createFakeActivation();
		await activateMcpExtension(fake.api, {
			configPath,
			clientFactory: factory,
		});
		expect(fake.disposeHandlers).toHaveLength(1);
		await fake.fireDispose();
		expect(closed).toEqual(["good"]);
	});
});
