import { readFile } from "node:fs/promises";

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
