/**
 * Serving the page instead of writing it.
 *
 * Every request rebuilds from disk, so refreshing a browser tab while a run is
 * still going shows what has been appended since. The server binds to loopback:
 * a session transcript is the most sensitive thing in a project, and a viewer
 * that quietly listened on every interface would be a way to lose it.
 */

import { createServer } from "node:http";

export interface ServeOptions {
	readonly port: number;
	readonly label: string;
	render(): Promise<string>;
}

export async function serveTrajectory(options: ServeOptions): Promise<void> {
	const server = createServer((request, response) => {
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405, { allow: "GET, HEAD" }).end();
			return;
		}
		options
			.render()
			.then((html) => {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
				response.end(request.method === "HEAD" ? undefined : html);
			})
			.catch((error: unknown) => {
				response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				response.end(error instanceof Error ? error.message : String(error));
			});
	});

	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(options.port, "127.0.0.1", () => {
			server.off("error", rejectPromise);
			resolvePromise();
		});
	});

	process.stderr.write(`widi-trajectory serving ${options.label}\n  http://127.0.0.1:${options.port}/\n`);
	await new Promise<void>((resolvePromise) => {
		const stop = (): void => {
			server.close(() => resolvePromise());
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}
