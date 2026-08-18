// Host dispatch and bootstrap.
//
// A6: the route table is partitioned BY HOST, not merely mounted under one. A router
// that matches path before host is the documented way this design collapses — if
// `/c/:id` is reachable on the app host, model-authored JS runs on the same origin as
// the page holding the write key, with an authenticated `fetch` available to it.
// So the host is resolved first and each host gets a different, non-overlapping table.

import { loadConfig, normalizeHost, type Config } from "./config.ts";
import { baseHeaders } from "./headers.ts";
import { serveContent } from "./routes/content.ts";
import { serveShell } from "./routes/shell.ts";

const config = loadConfig();

/** Which host a request arrived on. Anything we do not recognise is a misdirect. */
type Surface = "app" | "sandbox" | "unknown";

function surfaceOf(request: Request, config: Config): Surface {
	const raw = request.headers.get("host");
	if (!raw) return "unknown";
	const host = normalizeHost(raw);
	if (host === config.appHost) return "app";
	if (host === config.sandboxHost) return "sandbox";
	return "unknown";
}

function text(body: string, status: number, extra: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: { ...baseHeaders(), "content-type": "text/plain; charset=utf-8", ...extra },
	});
}

const notFound = () => text("not found\n", 404);

/**
 * Routes served ONLY on the app host. `/c/*` is deliberately absent: reaching it here
 * must 404, and that is a blocking Phase 0 gate.
 */
async function appRoutes(request: Request, url: URL): Promise<Response> {
	const path = url.pathname;

	if (path.startsWith("/d/")) {
		const id = path.slice(3);
		if (!id || id.includes("/")) return notFound();
		return serveShell(request, config, id);
	}

	// Phase 1-3 mount /api, /r and /guide.md here.
	if (path === "/" || path.startsWith("/api/") || path.startsWith("/r/") || path === "/guide.md") {
		return text("not built yet\n", 404);
	}

	return notFound();
}

/**
 * Routes served ONLY on the sandbox host. Nothing that touches state, keys or the API
 * may ever appear in this table — the whole point of the host is that a compromise of
 * what it serves reaches nothing.
 */
async function sandboxRoutes(request: Request, url: URL): Promise<Response> {
	const path = url.pathname;

	if (path.startsWith("/c/")) {
		const id = path.slice(3);
		if (!id || id.includes("/")) return notFound();
		return serveContent(request, config, id);
	}

	return notFound();
}

const server = Bun.serve({
	hostname: config.bind,
	port: config.port,
	// A13: reject oversized bodies at the socket rather than buffering them to compute a
	// 413. Caddy also caps this; belt and braces, because the process must survive being
	// addressed directly during a misconfiguration.
	maxRequestBodySize: 8 * 1024 * 1024,

	async fetch(request) {
		const surface = surfaceOf(request, config);

		// 421 Misdirected Request is the honest status: the connection reached a server
		// that is not authoritative for the requested host. It also makes a forged Host
		// distinguishable from a missing route in the gate tests.
		if (surface === "unknown") {
			return text("misdirected request\n", 421);
		}

		const url = new URL(request.url);

		if (request.method !== "GET" && request.method !== "HEAD" && surface === "sandbox") {
			// The sandbox host is read-only by construction. Nothing it serves accepts input.
			return text("method not allowed\n", 405, { allow: "GET, HEAD" });
		}

		try {
			return surface === "app"
				? await appRoutes(request, url)
				: await sandboxRoutes(request, url);
		} catch (error) {
			console.error(`[error] ${request.method} ${url.pathname}`, error);
			return text("internal error\n", 500);
		}
	},
});

console.log(
	[
		`vaiven listening on ${config.bind}:${server.port}`,
		`  app      ${config.appOrigin}      /d/:id /api /r /guide.md`,
		`  sandbox  ${config.sandboxOrigin}  /c/:id only`,
		`  db       ${config.db}`,
		"",
	].join("\n"),
);
