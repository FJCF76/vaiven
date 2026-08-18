// GET /c/:id — model-authored HTML, on the sandbox host only.
//
// No authentication by design: this returns `content`, which holds no data. State never
// passes through here; it enters the frame over postMessage from the shell. That is what
// lets the route be auth-never and still leak nothing.

import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import { contentHeaders } from "../headers.ts";
import { prepareContent } from "../inject.ts";
import { lookup } from "../content-source.ts";
import { RATES, enforceRate, clientIp } from "../quota.ts";
import { ApiError, errorResponse } from "../errors.ts";

const helper = await Bun.file(new URL("../shell/helper.js", import.meta.url)).text();

/** A3: warnings are computed once, at serve time, and stored on the document so the agent
 *  sees them on its next read without anything re-parsing a megabyte of HTML. */
function recordWarnings(db: Database | null, id: string, warnings: unknown[]): void {
	if (!db) return;
	const encoded = JSON.stringify(warnings);
	try {
		// Only when it actually changed. Writing unconditionally turned every page load of
		// a document that legitimately carries a warning into a database write.
		const current = db
			.query<{ warnings: string }, [string]>("SELECT warnings FROM docs WHERE id = ?")
			.get(id);
		if (!current || current.warnings === encoded) return;
		db.query("UPDATE docs SET warnings = ? WHERE id = ?").run(encoded, id);
	} catch {
		// Advisory only; never fail a page render over a note about it.
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

		const { html, warnings } = await prepareContent(found.html, helper);
		recordWarnings(db, id, warnings);

		return new Response(html, { headers: contentHeaders(config) });
	} catch (error) {
		if (error instanceof ApiError) return errorResponse(error, config.appOrigin);
		throw error;
	}
}
