import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../../../.widi/extensions/mcp/lib.ts";

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
