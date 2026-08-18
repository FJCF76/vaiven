// GET /d/:id — the shell, on the app host only.
//
// This page holds the write key in location.hash and renders strings other people wrote.
// A6 gives it its own CSP; the markup here carries no interpolated data at all beyond the
// two origins it needs, and shell.js fills everything else in with textContent.

import type { Config } from "../config.ts";
import { SANDBOX_ATTRIBUTE, shellHeaders } from "../headers.ts";

export async function serveShell(
	_request: Request,
	config: Config,
	_id: string,
): Promise<Response> {
	// The document id comes from the URL the script already has, and the key never leaves
	// the fragment. Nothing user-controlled is interpolated into this markup.
	const html = `<!doctype html>
<html lang="en" data-sandbox-origin="${config.sandboxOrigin}" data-sandbox-flags="${SANDBOX_ATTRIBUTE}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vaiven</title>
<link rel="stylesheet" href="/shell.css">
</head>
<body>
<noscript>This document needs JavaScript to open.</noscript>
<script src="/shell.js" type="module"></script>
</body>
</html>
`;

	return new Response(html, { headers: shellHeaders(config) });
}
