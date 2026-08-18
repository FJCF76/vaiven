// A12: never make the agent construct a URL.
//
// Three unguessable single letters across two hostnames with two different key
// placements is not something to document and hope for. Every response that mentions a
// document carries the URLs for it, `/r/` included — a cold agent handed only a read URL
// otherwise gets field names and no way to reach the app they belong to.

import type { Config } from "./config.ts";

export interface DocUrls {
	/** The human's link. The key rides in the fragment, so it never reaches the server:
	 *  no access log, no Referer, no proxy cache. */
	view_url?: string;
	/** The universal read. A bearer secret in a path, deliberately, because the weakest
	 *  possible reader cannot set a header (I2). */
	read_url?: string;
	/** The content itself, on the sandbox host. */
	content_url: string;
	api_url: string;
	guide: string;
}

export function docUrls(
	config: Config,
	docId: string,
	keys: { write?: string; read?: string } = {},
): DocUrls {
	return {
		...(keys.write
			? { view_url: `${config.appOrigin}/d/${docId}#k=${encodeURIComponent(keys.write)}` }
			: {}),
		...(keys.read ? { read_url: `${config.appOrigin}/r/${keys.read}.json` } : {}),
		content_url: `${config.sandboxOrigin}/c/${docId}`,
		api_url: `${config.appOrigin}/api/docs/${docId}`,
		guide: `${config.appOrigin}/guide.md`,
	};
}
