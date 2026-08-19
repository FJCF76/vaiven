// /api/* dispatch, on the app host only.

import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import { ApiError, errorResponse, fail } from "../errors.ts";
import { createDoc, listDocs, readDoc, requireScope } from "./api.ts";
import {
	deleteDoc,
	deleteKey,
	listVersions,
	postEvents,
	postKey,
	putContent,
	putState,
	restoreVersion,
	setWebhook,
} from "./writes.ts";

export async function apiRoutes(
	db: Database,
	request: Request,
	url: URL,
	config: Config,
): Promise<Response> {
	try {
		const scope = requireScope(db, request, config);
		const segments = url.pathname.split("/").filter(Boolean); // ["api","docs",...]
		const method = request.method;

		if (segments[1] !== "docs") {
			fail("not_found", "No such route.", {
				hint: "Everything lives under /api/docs. See the guide for the full list.",
			});
		}

		// /api/docs
		if (segments.length === 2) {
			if (method === "POST") return await createDoc(db, request, config, scope);
			if (method === "GET") return listDocs(db, url, config, scope);
			return methodNotAllowedWith(config, "GET, POST");
		}

		const id = segments[2]!;

		// /api/docs/:id
		if (segments.length === 3) {
			if (method === "GET") return readDoc(db, request, url, config, scope, id);
			if (method === "DELETE") return deleteDoc(db, scope, id);
			return methodNotAllowedWith(config, "GET, DELETE");
		}

		// /api/docs/:id/<leaf>
		if (segments.length === 4) {
			switch (segments[3]) {
				case "state":
					if (method === "PUT") return await putState(db, request, url, scope, id);
					return methodNotAllowedWith(config, "PUT");
				case "content":
					if (method === "PUT") return await putContent(db, request, scope, id);
					return methodNotAllowedWith(config, "PUT");
				case "events":
					if (method === "POST") return await postEvents(db, request, scope, id);
					return methodNotAllowedWith(config, "POST");
				case "keys":
					if (method === "POST") return await postKey(db, request, config, scope, id);
					return methodNotAllowedWith(config, "POST");
				case "webhook":
					if (method === "PUT") return await setWebhook(db, request, scope, id);
					return methodNotAllowedWith(config, "PUT");
			}
		}

		// /api/docs/:id/keys/:kid  and  /api/docs/:id/state/{versions,restore}
		if (segments.length === 5) {
			if (segments[3] === "keys" && method === "DELETE") return deleteKey(db, scope, id, segments[4]!);
			if (segments[3] === "state" && segments[4] === "versions" && method === "GET") {
				return listVersions(db, scope, id);
			}
			if (segments[3] === "state" && segments[4] === "restore" && method === "POST") {
				return await restoreVersion(db, request, scope, id);
			}
		}

		fail("not_found", "No such route.", {
			hint: "Check the method and the path. The guide lists every route with a working curl example.",
		});
	} catch (error) {
		if (error instanceof ApiError) return errorResponse(error, config.appOrigin);
		throw error;
	}
}

/**
 * A9 says no error without a remedy, and every other path gets there through `fail`. This
 * one was hand-rolled, so it shipped without the `guide` link and with a 405 body that did
 * not match the shape the guide documents.
 */
function methodNotAllowedWith(config: Config, allow: string): Response {
	const error = new ApiError("invalid", "That method is not allowed on this route.", {
		hint: `Use ${allow} on this path.`,
		headers: { allow },
	});
	const response = errorResponse(error, config.appOrigin);
	// `invalid` is a 400 everywhere else; on a route that exists but not for this method,
	// 405 with `Allow` is the answer an HTTP client can act on.
	return new Response(response.body, { status: 405, headers: response.headers });
}
