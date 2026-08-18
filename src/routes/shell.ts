// GET /d/:id — the shell, on the app host only.
//
// This is the page that holds the write key in `location.hash` and renders strings other
// people wrote. A6 gives it its own CSP; the markup here carries no interpolated data at
// all, and the shell script fills it in with textContent only.
//
// Phase 0 serves the frame and the headers so the gates can run. Phase 4 adds the chrome,
// the state machine and the write pipeline.

import type { Config } from "../config.ts";
import { shellHeaders } from "../headers.ts";
import { SANDBOX_ATTRIBUTE } from "../headers.ts";

export async function serveShell(
	_request: Request,
	config: Config,
	id: string,
): Promise<Response> {
	// A4's union trap: the iframe attribute must list exactly the flags the response
	// header grants, or the narrower of the two silently wins and every capability the
	// audit restored disappears. Both are built from SANDBOX_FLAGS.
	const frameSrc = `${config.sandboxOrigin}/c/${encodeURIComponent(id)}`;

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vaiven</title>
<link rel="stylesheet" href="/shell.css">
</head>
<body>
<div id="chrome"></div>
<iframe
  id="frame"
  title="Document"
  src="${frameSrc}"
  sandbox="${SANDBOX_ATTRIBUTE}"
  allow=""
  referrerpolicy="no-referrer"
  hidden></iframe>
<script src="/shell.js" type="module"></script>
</body>
</html>
`;

	return new Response(html, { headers: shellHeaders(config) });
}
