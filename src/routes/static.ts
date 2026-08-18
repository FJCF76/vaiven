// The manual, the shell's assets, and the front door.

import { join } from "node:path";
import type { Config } from "../config.ts";
import { baseHeaders } from "../headers.ts";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * A12: served as `text/markdown` so a fetching agent renders it rather than downloading
 * it, and so the file reads the same over HTTP as it does installed as a skill.
 */
export async function serveGuide(config: Config, path: string): Promise<Response> {
	// `/guide.md` and `/guide/<name>.md`. Nothing else, and no traversal.
	const name = path === "/guide.md" ? "guide.md" : path.slice("/guide/".length);
	if (!/^[a-z0-9-]+\.md$/.test(name) && name !== "guide.md") {
		return new Response("not found\n", { status: 404, headers: baseHeaders() });
	}

	const file = Bun.file(name === "guide.md" ? join(ROOT, "guide.md") : join(ROOT, "guide", name));
	if (!(await file.exists())) {
		return new Response(`Not written yet. Start at ${config.appOrigin}/guide.md\n`, {
			status: 404,
			headers: { ...baseHeaders(), "content-type": "text/markdown; charset=utf-8" },
		});
	}

	return new Response(await file.text(), {
		headers: {
			...baseHeaders(),
			"content-type": "text/markdown; charset=utf-8",
			"cache-control": "public, max-age=300",
			"access-control-allow-origin": "*",
		},
	});
}

/** The shell imports the write pipeline, which is TypeScript shared with the server's
 *  tests. Bundling on first request keeps one copy of that logic instead of two that drift,
 *  and avoids a build step between editing and running. */
let bundled: string | null = null;

async function shellBundle(): Promise<string> {
	if (bundled !== null) return bundled;

	const built = await Bun.build({
		entrypoints: [join(ROOT, "src", "shell", "shell.js")],
		target: "browser",
		format: "esm",
		minify: false,
	});

	if (!built.success) {
		const reasons = built.logs.map((log) => String(log)).join("\n");
		throw new Error(`shell bundle failed:\n${reasons}`);
	}

	bundled = await built.outputs[0]!.text();
	return bundled;
}

export async function serveStatic(path: string): Promise<Response> {
	if (path === "/shell.js") {
		return new Response(await shellBundle(), {
			headers: {
				...baseHeaders(),
				"content-type": "text/javascript; charset=utf-8",
				"cache-control": "public, max-age=60",
			},
		});
	}

	const file = Bun.file(join(ROOT, "src", "shell", "shell.css"));
	if (!(await file.exists())) {
		return new Response("not found\n", { status: 404, headers: baseHeaders() });
	}
	return new Response(await file.text(), {
		headers: {
			...baseHeaders(),
			"content-type": "text/css; charset=utf-8",
			"cache-control": "public, max-age=60",
		},
	});
}

/**
 * DX finding M7: `/` was a 404, and it is the only cold-discovery path anyone would try.
 * A human gets a page; anything asking for JSON gets the shape of the system.
 */
export function serveIndex(request: Request, config: Config): Response {
	const accept = request.headers.get("accept") ?? "";

	if (accept.includes("application/json")) {
		return new Response(
			JSON.stringify(
				{
					name: "vaiven",
					what: "Living documents between an agent and people. An agent publishes a small web app, a person works in it, and the agent reads back a diff of what changed.",
					guide: `${config.appOrigin}/guide.md`,
					install: `curl --create-dirs -o ~/.claude/skills/vaiven/SKILL.md ${config.appOrigin}/guide.md`,
				},
				null,
				2,
			),
			{
				headers: { ...baseHeaders(), "content-type": "application/json; charset=utf-8" },
			},
		);
	}

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vaiven</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 0 auto; padding: 15vh 1.5rem; }
  h1 { font-size: 1.5rem; letter-spacing: -0.01em; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; }
  code { font: 13px/1.5 ui-monospace, Menlo, monospace; background: rgba(128,128,128,.14);
         padding: .15em .4em; border-radius: 3px; }
  pre { font: 13px/1.6 ui-monospace, Menlo, monospace; background: rgba(128,128,128,.14);
        padding: .9rem 1rem; border-radius: 4px; overflow-x: auto; }
  .muted { opacity: .7; font-size: .9rem; }
</style>
</head>
<body>
<h1>Vaiven</h1>
<p>An agent publishes a small web app. A person works in it. The agent reads back a
   diff of what they changed, from a plain URL.</p>
<p>The manual is two screens and explains the whole system:
   <a href="/guide.md">/guide.md</a></p>
<p>To install it as a skill:</p>
<pre>curl --create-dirs -o ~/.claude/skills/vaiven/SKILL.md \\
  ${config.appOrigin}/guide.md</pre>
<p class="muted">Documents are private. There is no directory, no search, and no way in
   without a key.</p>
</body>
</html>
`;

	return new Response(html, {
		headers: { ...baseHeaders(), "content-type": "text/html; charset=utf-8" },
	});
}
