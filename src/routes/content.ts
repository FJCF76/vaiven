// GET /c/:id — model-authored HTML, on the sandbox host only.
//
// This route needs no authentication: it returns `content`, which holds no data. State
// never passes through here; it enters the frame over postMessage from the shell. That
// is what lets the route be cached-never, auth-never, and still leak nothing.

import type { Config } from "../config.ts";
import { contentHeaders } from "../headers.ts";
import { prepareContent } from "../inject.ts";
import { lookup } from "../content-source.ts";

const helper = await Bun.file(new URL("../shell/helper.js", import.meta.url)).text();

export async function serveContent(
	_request: Request,
	config: Config,
	id: string,
): Promise<Response> {
	const raw = await lookup(id);

	if (raw === null) {
		// Deliberately identical to any other miss on this host: the content host must
		// not be an oracle for which document ids exist.
		return new Response("not found\n", {
			status: 404,
			headers: { "content-type": "text/plain; charset=utf-8", "referrer-policy": "no-referrer" },
		});
	}

	const { html } = await prepareContent(raw, helper);

	return new Response(html, { headers: contentHeaders(config) });
}
