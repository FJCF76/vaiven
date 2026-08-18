// GET /c/:id — model-authored HTML, on the sandbox host only.
//
// No authentication by design: this returns `content`, which holds no data. State never
// passes through here; it enters the frame over postMessage from the shell. That is what
// lets the route be auth-never and still leak nothing.

import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import { contentHeaders } from "../headers.ts";
import { prepareContent } from "../inject.ts";
import { isFixture, lookup } from "../content-source.ts";
import { RATES, enforceRate, clientIp } from "../quota.ts";
import { ApiError, errorResponse } from "../errors.ts";

const helperSource = await Bun.file(new URL("../shell/helper.js", import.meta.url)).text();

/** The helper needs to know which origin is allowed to frame it, and it is served from a
 *  host that has no configuration of its own. */
const helperFor = (config: Config): string =>
	helperSource.replaceAll("__VAIVEN_APP_ORIGIN__", config.appOrigin);


// A 4 MB document is re-parsed and re-rewritten on every single load, and the capacity
// target is 50 concurrent loads of exactly that. The prepared output is a pure function of
// (content, helper), and content is immutable for a given content_version, so it is cached
// under that key. Fixtures are excluded: they change on disk while the gates are being
// written, and a cache that serves yesterday's fixture would be a debugging trap.
interface Prepared {
	html: string;
	bytes: number;
}

const PREPARED_MAX_BYTES = 32 * 1024 * 1024;
const PREPARED_MAX_ENTRIES = 64;
const prepared = new Map<string, Prepared>();
let preparedBytes = 0;

function cacheGet(key: string): Prepared | undefined {
	const hit = prepared.get(key);
	if (!hit) return undefined;
	prepared.delete(key); // re-insert to refresh LRU order
	prepared.set(key, hit);
	return hit;
}

function cachePut(key: string, value: Prepared): void {
	if (value.bytes > PREPARED_MAX_BYTES) return; // one document must not evict everything
	prepared.set(key, value);
	preparedBytes += value.bytes;

	while (preparedBytes > PREPARED_MAX_BYTES || prepared.size > PREPARED_MAX_ENTRIES) {
		const oldest = prepared.keys().next();
		if (oldest.done) break;
		const evicted = prepared.get(oldest.value)!;
		prepared.delete(oldest.value);
		preparedBytes -= evicted.bytes;
	}
}

/** Called when content is republished, so the old rendering cannot outlive it. */
export function forgetPrepared(docId: string): void {
	for (const key of [...prepared.keys()]) {
		if (key.startsWith(`${docId}:`)) {
			preparedBytes -= prepared.get(key)!.bytes;
			prepared.delete(key);
		}
	}
}

export async function serveContent(
	request: Request,
	config: Config,
	db: Database | null,
	id: string,
): Promise<Response> {
	try {
		// A13: this route was entirely unlimited, and it is unauthenticated and
		// enumerable-adjacent, so it gets a budget like everything else.
		enforceRate(`c:${clientIp(request, config)}`, RATES.anonymous, "requests");

		const found = await lookup(db, id);

		if (found === null) {
			return new Response("not found\n", {
				status: 404,
				headers: {
					"content-type": "text/plain; charset=utf-8",
					"referrer-policy": "no-referrer",
					"cache-control": "no-store",
				},
			});
		}

		// NOTHING here writes. This route is the one place in the system that serves
		// model-authored HTML, on a host whose entire premise is that a compromise of what
		// it serves reaches nothing — and it was performing an UPDATE on an arbitrary
		// tenant's `docs` row, unauthenticated, for any document id anyone had ever been
		// handed. The warnings it used to record are computed on the publish path instead,
		// which is where A3 said to compute them.
		const key = `${id}:${found.contentVersion}`;
		const cacheable = db !== null && !isFixture(id);
		let entry = cacheable ? cacheGet(key) : undefined;

		if (!entry) {
			const { html } = await prepareContent(found.html, helperFor(config));
			entry = { html, bytes: Buffer.byteLength(html) };
			if (cacheable) cachePut(key, entry);
		}

		return new Response(entry.html, { headers: contentHeaders(config) });
	} catch (error) {
		if (error instanceof ApiError) return errorResponse(error, config.appOrigin);
		throw error;
	}
}
