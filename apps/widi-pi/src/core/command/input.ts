export interface ParsedInputInvocation {
	readonly name: string;
	readonly args: string;
}

export function parseInputInvocation(
	text: string,
): ParsedInputInvocation | undefined {
	if (!text.startsWith("/")) return undefined;
	const body = text.slice(1);
	if (!body.trim()) return undefined;
	const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(body);
	if (!match) return undefined;
	const name = match[1];
	if (!name) return undefined;
	return {
		name,
		args: match[2] ?? "",
	};
}
