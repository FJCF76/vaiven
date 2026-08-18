// The manual, the shell's assets, and the front door.

import { join } from "node:path";
import { CANONICAL_ORIGIN, CANONICAL_SANDBOX_ORIGIN, type Config } from "../config.ts";
import { baseHeaders } from "../headers.ts";

const ROOT = join(import.meta.dir, "..", "..");

/** The running version, for the freshness stamp below. */
const VERSION = (await Bun.file(join(ROOT, "VERSION")).text().catch(() => "unknown")).trim();

/**
 * A12: served as `text/markdown` so a fetching agent renders it rather than downloading
 * it, and so the file reads the same over HTTP as it does installed as a skill.
 */
/**
 * Rewrite both canonical origins in ONE pass.
 *
 * Two chained `replaceAll` calls look equivalent and are not: the second re-scans the text the
 * first just inserted. Measured — sandbox host `vaiven.owncompute.com.evil.test` with app origin
 * `http://localhost:8080` came back as `http://localhost:8080.evil.test`, a host that resolves
 * nowhere. It takes an operator misconfiguration to reach, so it is a correctness landmine
 * rather than an exploit, but a single pass costs nothing and removes the ordering question.
 *
 * Sandbox is listed first because regex alternation is leftmost-first and it is the longer,
 * more specific match. A replacer FUNCTION, not a string, because a string replacement
 * interprets `$&`, `` $` ``, `$'` and `$$` inside itself.
 */
export function rewriteOrigins(text: string, config: Config): string {
	const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`${escape(CANONICAL_SANDBOX_ORIGIN)}|${escape(CANONICAL_ORIGIN)}`, "g");
	return text.replace(pattern, (match) =>
		match === CANONICAL_SANDBOX_ORIGIN ? config.sandboxOrigin : config.appOrigin,
	);
}

export async function serveGuide(config: Config, path: string): Promise<Response> {
	// `/guide.md` and `/guide/<name>.md`. Nothing else, and no traversal.
	const name = path === "/guide.md" ? "guide.md" : path.slice("/guide/".length);
	if (!/^[a-z0-9-]+\.md$/.test(name)) {
		return new Response("not found\n", { status: 404, headers: baseHeaders() });
	}

	const file = Bun.file(name === "guide.md" ? join(ROOT, "guide.md") : join(ROOT, "guide", name));
	if (!(await file.exists())) {
		return new Response(`Not written yet. Start at ${config.appOrigin}/guide.md\n`, {
			status: 404,
			headers: { ...baseHeaders(), "content-type": "text/markdown; charset=utf-8" },
		});
	}

	// The manual is written against the canonical origin and rewritten to whichever origin
	// this instance actually serves, so production is a no-op and local dev and self-hosters
	// get their own host. See CANONICAL_ORIGIN for why the file stores a real URL rather than
	// a placeholder, and why the constant must stay scheme-qualified.
	//
	// A FUNCTION, not a string: a string replacement interprets $&, $', $` and $$ inside
	// itself, so an origin carrying one of those would rewrite or truncate the manual.
	// Config refuses such a host now; this is the second lock on the same door.
	let markdown = rewriteOrigins(await file.text(), config);

	// The manual is distributed by COPY: `vaiven tenant create` prints an installer that
	// curls it to ~/.claude/skills/vaiven/SKILL.md, and from then on the agent reads that
	// snapshot. Nothing in it said which version it was or that it could go stale, so a
	// manual corrected today stays wrong forever for everyone who installed it yesterday —
	// and they cannot tell. Stamped at serve time, so the copy carries the version it was
	// taken at and the address of the current one.
	// No date in the body. A per-request date makes the bytes unstable, so the obvious check
	// — diff my installed copy against a fresh fetch — reports a change every time even when
	// the manual is identical. The version is the freshness signal; the date was noise in
	// exactly the comparison this stamp exists to support.
	// The URL must not sit flush against the closing `*`. A markdown renderer closes the
	// emphasis correctly, but an agent extracting URLs with a regex takes the `*` with it and
	// gets a 404 on the one address whose entire job is to be re-fetchable. Keep the URL
	// mid-sentence, with whitespace after it.
	const stamp =
		`\n*Vaivén ${VERSION} — the current version of this page is always at ` +
		`${config.appOrigin}${path} and re-fetching it is safe. If you are reading an installed ` +
		`copy and something here does not match what the API does, that copy is stale.*\n`;
	if (/^#\s.*\n/m.test(markdown)) {
		markdown = markdown.replace(/^(#\s.*\n)/m, (heading) => `${heading}${stamp}`);
	} else {
		// No heading to hang it on. Prepending is worse than nothing for a file that is read
		// as a skill, so put it at the end rather than serve an unstamped copy silently.
		markdown = `${markdown}\n${stamp}`;
	}

	return new Response(markdown, {
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
					// A discovering agent reads this object before anything else, and it said
					// nothing about keys at all. One agent followed the install line, got the
					// manual, held no key, and went hunting for a binary that has never been
					// published. State the negative here, where it is met first.
					keys: "Issued by the operator of this instance. There is no signup and no key-provisioning endpoint, so no request you can make will produce one — ask the human you are working with.",
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
<title>Vaivén</title>
<style>
  :root { color-scheme: light dark; --ink: #16212b; --accent: #0b6b5e; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e6edf3; --accent: #3fbfa8; } }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 0 auto;
         padding: 15vh 1.5rem; color: var(--ink); }
  a { color: var(--accent); }
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
<h1>Vaivén</h1>
<p>An agent publishes a small web app. A person works in it. The agent reads back a
   diff of what they changed, from a plain URL.</p>
<p>The manual is one page and explains the whole system, with nothing to fetch after it:
   <a href="${config.appOrigin}/guide.md">${config.appOrigin}/guide.md</a></p>
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
