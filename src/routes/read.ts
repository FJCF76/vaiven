// GET /r/<read_key>.json — the universal read.
//
// This is the route premise 1 exists for, and the only one that has to satisfy I2 unaided:
// no headers, no auth ceremony, no JavaScript, no SDK. Anything that can issue a GET can
// read the document — curl, a cron job, a CI step, an agent that was handed one URL and
// has never heard of this system.
//
// The key rides in the PATH rather than a header precisely because the weakest possible
// reader cannot set a header. §3 prices that honestly: the URL is a bearer secret.

import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import { hashKey } from "../auth.ts";
import { safeParse } from "../events.ts";
import { baseHeaders } from "../headers.ts";
import { RATES, enforceRate } from "../quota.ts";
import { docUrls } from "../urls.ts";
import { ApiError, errorResponse } from "../errors.ts";
import { UNTRUSTED, readEvents, truthy } from "./api.ts";

/**
 * A13: an unknown key and a revoked key must be indistinguishable, so the route is not an
 * oracle for which keys ever existed. Both produce this, byte for byte.
 */
function opaqueMiss(config: Config): Response {
	return new Response(
		JSON.stringify(
			{
				error: {
					code: "not_found",
					message: "No document for that key.",
					hint: "The key may be wrong, or it may have been revoked. Ask whoever shared the link for a current one.",
					guide: `${config.appOrigin}/guide/errors.md`,
				},
			},
			null,
			2,
		),
		{
			status: 404,
			headers: {
				...baseHeaders(),
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
			},
		},
	);
}

export function readByKey(
	db: Database,
	request: Request,
	url: URL,
	config: Config,
	keyWithSuffix: string,
): Response {
	try {
		// `/r/<key>.json` — the extension is there so that a browser, an editor and a
		// content-type sniffer all agree about what this is.
		if (!keyWithSuffix.endsWith(".json")) return opaqueMiss(config);
		const plaintext = keyWithSuffix.slice(0, -".json".length);
		if (!plaintext) return opaqueMiss(config);

		const row = db
			.query<
				{
					doc_id: string;
					role: string;
					revoked_at: number | null;
					tenant_disabled: number;
					title: string;
					sender_note: string;
					state: string;
					version: number;
					warnings: string;
					content_version: number;
				},
				[string]
			>(
				`SELECT k.doc_id, k.role, k.revoked_at,
				        t.disabled AS tenant_disabled,
				        d.title, d.sender_note, d.state, d.version, d.warnings,
				        c.content_version
				   FROM doc_keys k
				   JOIN docs         d ON d.id = k.doc_id
				   JOIN tenants      t ON t.id = d.tenant_id
				   JOIN doc_content  c ON c.doc_id = d.id
				  WHERE k.key_hash = ?`,
			)
			.get(hashKey(plaintext));

		// Every failure below returns the same bytes.
		if (!row) return opaqueMiss(config);
		if (row.revoked_at !== null) return opaqueMiss(config);
		if (row.tenant_disabled) return opaqueMiss(config);
		// §3: "/r/ works if and only if the document has a live read key." A write key is
		// not a read key — it belongs in a header, not in a URL that gets pasted around.
		if (row.role !== "read") return opaqueMiss(config);

		enforceRate(`p:${row.doc_id}`, RATES.publicRead, "reads");

		const since = Number(url.searchParams.get("since") ?? -1);
		const events = readEvents(db, row.doc_id, since, url.searchParams.get("events"));

		const body = {
			doc_id: row.doc_id,
			title: row.title,
			sender_note: row.sender_note,
			version: row.version,
			content_version: row.content_version,
			state: safeParse(row.state),
			events,
			// A8: one opaque cursor to echo back, rather than three integers to choose
			// between. Passing the wrong one silently returns the wrong slice.
			next_since: row.version,
			warnings: safeParse(row.warnings),
			// A11: self-describing rather than a bare boolean, because this route is the
			// one most likely to be read by something that never saw the guide.
			untrusted: UNTRUSTED,
			// A12: a cold reader handed only this URL otherwise gets field names and no
			// way to reach the app they belong to.
			...docUrls(config, row.doc_id),
		};

		return new Response(JSON.stringify(body, null, 2), {
			headers: {
				...baseHeaders(),
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
				// CORS, decided explicitly rather than defaulted (A13). The URL is already
				// a bearer secret in a path: anyone holding it can read this server-side
				// with curl, so refusing browser origins would stop honest browser-based
				// tools and stop nothing else. I2 argues for reach; reach wins here.
				"access-control-allow-origin": "*",
			},
		});
	} catch (error) {
		if (error instanceof ApiError) return errorResponse(error, config.appOrigin);
		throw error;
	}
}
