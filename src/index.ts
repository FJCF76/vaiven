// Host dispatch and bootstrap.
//
// A6: the route table is partitioned BY HOST, not merely mounted under one. A router that
// matches path before host is the documented way this design collapses — if `/c/:id` is
// reachable on the app host, model-authored JS runs on the same origin as the page holding
// the write key, with an authenticated `fetch` available to it. So the host is resolved
// first and each host gets a different, non-overlapping table.

import { loadConfig, normalizeHost, type Config } from "./config.ts";
import { migrate, open } from "./db.ts";
import { baseHeaders } from "./headers.ts";
import { RATES, clientIp, enforceRate } from "./quota.ts";
import { ApiError, errorResponse } from "./errors.ts";
import { serveContent } from "./routes/content.ts";
import { serveShell } from "./routes/shell.ts";
import { apiRoutes } from "./routes/router.ts";
import { readByKey } from "./routes/read.ts";
import { serveGuide, serveIndex, serveStatic } from "./routes/static.ts";

const config = loadConfig();
const db = open(config.db);
migrate(db);

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

/** Routes served ONLY on the app host. `/c/*` is deliberately absent, and gate-tested. */
async function appRoutes(request: Request, url: URL): Promise<Response> {
	const path = url.pathname;

	if (path.startsWith("/api/")) return apiRoutes(db, request, url, config);

	if (path.startsWith("/r/")) {
		return readByKey(db, request, url, config, path.slice(3));
	}

	if (path.startsWith("/d/")) {
		const id = path.slice(3);
		if (!id || id.includes("/")) return notFound();
		enforceRate(`d:${clientIp(request, config)}`, RATES.anonymous, "requests");
		return serveShell(request, config, id);
	}

	// A13 lists these as unlimited surfaces to cover. Each one reads from disk per request.
	if (path === "/guide.md" || path.startsWith("/guide/")) {
		enforceRate(`g:${clientIp(request, config)}`, RATES.anonymous, "requests");
		return serveGuide(config, path);
	}
	if (path === "/shell.js" || path === "/shell.css") return serveStatic(path);
	if (path === "/") {
		enforceRate(`g:${clientIp(request, config)}`, RATES.anonymous, "requests");
		return serveIndex(request, config);
	}

	return notFound();
}

/** Routes served ONLY on the sandbox host. Nothing that touches state, keys or the API may
 *  ever appear here — the point of the host is that a compromise of what it serves reaches
 *  nothing. */
async function sandboxRoutes(request: Request, url: URL): Promise<Response> {
	const path = url.pathname;

	if (path.startsWith("/c/")) {
		const id = path.slice(3);
		if (!id || id.includes("/")) return notFound();
		return serveContent(request, config, db, id);
	}

	return notFound();
}

const server = Bun.serve({
	hostname: config.bind,
	port: config.port,
	maxRequestBodySize: 8 * 1024 * 1024,

	async fetch(request) {
		const surface = surfaceOf(request, config);
		if (surface === "unknown") return text("misdirected request\n", 421);

		const url = new URL(request.url);

		if (surface === "sandbox" && request.method !== "GET" && request.method !== "HEAD") {
			return text("method not allowed\n", 405, { allow: "GET, HEAD" });
		}

		try {
			return surface === "app" ? await appRoutes(request, url) : await sandboxRoutes(request, url);
		} catch (error) {
			if (error instanceof ApiError) return errorResponse(error, config.appOrigin);
			// For /r/<read_key>.json the path IS the bearer secret, and this journal is
			// retained and shipped. Caddy's access log is discarded for exactly this
			// reason; logging it here would hand it straight back.
			const safePath = url.pathname.startsWith("/r/") ? "/r/<redacted>.json" : url.pathname;
			console.error(`[error] ${request.method} ${safePath}`, error);
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
