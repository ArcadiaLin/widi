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
	loadMcpConfig,
	type McpCallToolResult,
	type McpClientFactory,
	McpServerConnection,
} from "../../../../.widi/extensions/mcp/lib.ts";

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
