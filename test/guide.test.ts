// The manual describes an API. This asserts the API it describes is the API that exists.
//
// A real agent read guide.md, found `Vaiven.render` and `mutate` named but never defined,
// and stopped to ask a human rather than invent the signatures — which was the right call,
// because an invented API does not fail at publish time. It fails silently in someone's
// browser and surfaces three turns later as an `error` event. So the signatures live in
// the manual now, and this test is what keeps them true.

import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { rewriteOrigins, serveGuide } from "../src/routes/static.ts";
import { CANONICAL_ORIGIN, CANONICAL_SANDBOX_ORIGIN } from "../src/config.ts";
import { STATUS } from "../src/errors.ts";
import { CLAMP, COLLAPSE_AT } from "../src/events.ts";
import { LIMITS, RATES } from "../src/quota.ts";

const guide = await Bun.file(new URL("../guide.md", import.meta.url)).text();
const helper = await Bun.file(new URL("../src/shell/helper.js", import.meta.url)).text();

/** Every page the server will serve, not just the front one. The sub-pages are where the
 *  API is documented in depth, so they are where an invented signature would hide.
 *
 *  READ FROM DISK, never hardcoded. `serveGuide` serves any `guide/<name>.md` matching its
 *  own `/^[a-z0-9-]+\.md$/` guard, so a hardcoded list silently stops covering the moment
 *  someone adds a page. Measured: a `guide/zz-probe.md` carrying `$HOST`, a relative link
 *  AND a URL glued to a `*` was served with HTTP 200 while all 38 tests passed. The guards
 *  below are only worth what this list covers. */
const SUB_PAGES = (await Array.fromAsync(new Bun.Glob("*.md").scan({ cwd: new URL("../guide", import.meta.url).pathname }))).sort();
if (SUB_PAGES.length === 0) throw new Error("No guide sub-pages found — the guards below would pass vacuously.");
const pageText: Record<string, string> = { "/guide.md": guide };
for (const name of SUB_PAGES) {
	pageText[`/guide/${name}`] = await Bun.file(new URL(`../guide/${name}`, import.meta.url)).text();
}
const everyPage = Object.values(pageText).join("\n");

const config = { appOrigin: "https://vaiven.example" } as unknown as Config;
/** The real handler. Tests that reimplement its logic test the reimplementation. */
const serve = async (path: string) => await (await serveGuide(config, path)).text();

/** Every member the helper actually puts on `window.Vaiven`, read from that object literal
 *  alone so unrelated functions in the file cannot masquerade as public API. */
const block = helper.slice(helper.indexOf("window.Vaiven = {"));
const literal = block.slice(0, block.indexOf("\n\t};"));
const surface = [...literal.matchAll(/^\t\t(?:get )?(\w+)\s*[({]/gm)].map((m) => m[1]!);

describe("the documented app-mode API matches the real one", () => {
	test("the helper exposes exactly what we think it does", () => {
		expect(new Set(surface)).toEqual(new Set(["state", "readonly", "render", "mutate", "log"]));
	});

	for (const member of ["render", "mutate", "log", "state", "readonly"]) {
		test(`guide.md documents Vaiven.${member}`, () => {
			expect(guide).toContain(`Vaiven.${member}`);
		});
	}

	test("nothing is documented that does not exist, across every page", () => {
		// Scans the sub-pages too: app-mode.md is where the API is described in depth, so it
		// is where an invented signature would hide.
		const mentioned = [...everyPage.matchAll(/Vaiven\.(\w+)/g)].map((m) => m[1]!);
		// A loop over nothing passes vacuously; the manual must actually mention the API.
		expect(mentioned.length).toBeGreaterThan(5);
		for (const name of mentioned) expect(surface).toContain(name);
	});
});

describe("the manual never asks an agent to construct a URL (A12)", () => {
	// It handed out `$HOST/guide/app-mode.md` — a shell placeholder, not a URL. The served
	// bytes were fine, but the FILE is what people meet: on GitHub, through
	// raw.githubusercontent.com, in every clone. Through all three it said `curl -s
	// $HOST/api/docs`, and in a shell an unset variable expands to empty, so that silently
	// becomes `curl -s /api/docs`. The manual is written against the canonical origin now
	// and rewritten to whatever this instance serves.

	test("no page on disk contains a shell placeholder", () => {
		// The regression guard. `$HOST` came back once already; this is what stops it.
		for (const [path, text] of Object.entries(pageText)) {
			// `\$\{HOST\}` and `\$Host` slipped past the first version of this guard, which only
			// matched `\$[A-Z_]{2,}` — and `\$\{HOST\}` is the MORE idiomatic shell form, so it was
			// the likelier way the bug came back. Any `\$` followed by a name or a brace now.
			const found = [...text.matchAll(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g)].map((m) => m[0]);
			expect({ path, found }).toEqual({ path, found: [] });
		}
	});

	test("every URL in every page on disk is absolute and parses", () => {
		let checked = 0;
		for (const text of Object.values(pageText)) {
			for (const [url] of text.matchAll(/https?:\/\/[^\s"'`)\]<>]+/g)) {
				// `<a href="https://…">` is prose showing the SHAPE of a link, not a link.
				if (url.includes("…")) continue;
				const trimmed = url.replace(/[.,;]+$/, "");
				expect(() => new URL(trimmed)).not.toThrow();
				checked++;
			}
		}
		// A loop over nothing passes vacuously.
		expect(checked).toBeGreaterThan(10);
	});

	test("no pointer to another guide page is relative", () => {
		// The bug that started all of this was a RELATIVE link. `/guide/errors.md` renders
		// fine and reads fine, and an agent whose fetch tool takes only absolute URLs cannot
		// open it — which is indistinguishable, from the agent's side, from the page not
		// existing. Route descriptions like `POST /api/docs` are prose about the API and stay
		// as they are; a POINTER to a page must carry its origin.
		for (const [path, text] of Object.entries(pageText)) {
			const relative = [...text.matchAll(/(^|[^:/\w])(\/guide\/[a-z0-9-]+\.md)/g)].map((m) => m[2]);
			expect({ path, relative }).toEqual({ path, relative: [] });
			const relativeLinks = [...text.matchAll(/\]\((\/[^)]*)\)/g)].map((m) => m[1]);
			expect({ path, relativeLinks }).toEqual({ path, relativeLinks: [] });
		}
	});

	test("the canonical origin is only ever followed by a path", () => {
		// replaceAll matches a bare substring, so `…owncompute.com:443/x` or
		// `…owncompute.com.example` would be rewritten from the MIDDLE, producing a
		// double-port or otherwise broken URL for anyone not on the canonical origin.
		// Nothing in the manual does this today; this keeps it that way.
		for (const [path, text] of Object.entries(pageText)) {
			const bad = [...text.matchAll(new RegExp(`${CANONICAL_ORIGIN}([^/\\s\`"'.,)\\]]|\\.[a-z])`, "g"))].map((m) => m[0]);
			expect({ path, bad }).toEqual({ path, bad: [] });
		}
	});

	test("the sandbox origin is rewritten too, not left pointing at production", async () => {
		// serveGuide rewrote only the app origin at first. The day anyone documents the
		// sandbox host, a self-hoster's manual would send their readers to OUR sandbox.
		const served = await serve("/guide.md");
		expect(served).not.toContain(CANONICAL_SANDBOX_ORIGIN);
		const rewritten = `${CANONICAL_SANDBOX_ORIGIN}/c/d_x`.replaceAll(CANONICAL_SANDBOX_ORIGIN, () => "https://uc.vaiven.example");
		expect(rewritten).toBe("https://uc.vaiven.example/c/d_x");
	});

	test("both origins are rewritten in one pass, so neither can corrupt the other", () => {
		// Tested against rewriteOrigins directly, NOT through serveGuide: guide.md never
		// mentions the sandbox origin, so serving it cannot exercise this path at all. The
		// first version of this test went through serveGuide and passed against the BROKEN
		// two-pass implementation — a test that tests nothing.
		//
		// Two chained replaceAll calls re-scan what the first inserted. Measured before the
		// fix: sandbox host `vaiven.owncompute.com.evil.test` with app origin
		// `http://localhost:8080` came back as `http://localhost:8080.evil.test`, a host that
		// resolves nowhere. Reaching it needs an operator misconfiguration, so it is a
		// correctness landmine rather than an exploit — but a single pass settles it.
		const hostile = {
			appOrigin: "http://localhost:8080",
			sandboxOrigin: `${CANONICAL_ORIGIN}.evil.test`,
		} as unknown as Config;
		const source = `app=${CANONICAL_ORIGIN}/api sandbox=${CANONICAL_SANDBOX_ORIGIN}/c/d_x`;
		const out = rewriteOrigins(source, hostile);
		expect(out).toBe(`app=http://localhost:8080/api sandbox=${CANONICAL_ORIGIN}.evil.test/c/d_x`);
	});

	test("the ordinary origins round-trip through the same one-pass rewrite", () => {
		const local = {
			appOrigin: "http://vaiven.localhost:8080",
			sandboxOrigin: "http://uc.vaiven.localhost:8080",
		} as unknown as Config;
		const source = `${CANONICAL_ORIGIN}/api and ${CANONICAL_SANDBOX_ORIGIN}/c/d_x`;
		expect(rewriteOrigins(source, local)).toBe(
			"http://vaiven.localhost:8080/api and http://uc.vaiven.localhost:8080/c/d_x",
		);
	});

	test("the file on disk is written against the canonical origin", () => {
		expect(guide).toContain(`${CANONICAL_ORIGIN}/guide/app-mode.md`);
	});

	test("every sub-page the guide names exists on disk", async () => {
		// Every page, not just guide.md — a sub-page can link to a page that no longer exists.
		const pages = Object.values(pageText).flatMap((text) =>
			[...text.matchAll(/https:\/\/[^\s"'`)\]<>]+\/guide\/([a-z0-9-]+\.md)/g)].map((m) => m[1]!),
		);
		expect(pages.length).toBeGreaterThan(0);
		for (const page of new Set(pages)) {
			expect(await Bun.file(new URL(`../guide/${page}`, import.meta.url)).exists()).toBe(true);
		}
	});

	test("serving under another origin rewrites every canonical URL away", async () => {
		// Through serveGuide, not through a copy of what it does. An earlier version of this
		// test reimplemented the replacement inline, so deleting it from the route left every
		// test passing while the placeholder shipped raw.
		for (const path of Object.keys(pageText)) {
			const served = await serve(path);
			expect(served).not.toContain(CANONICAL_ORIGIN);
			expect(served).not.toMatch(/\$[A-Z_]{2,}/);
		}
		expect(await serve("/guide.md")).toContain("https://vaiven.example/guide/app-mode.md");
	});

	test("the sandbox origin survives substitution intact", async () => {
		// Measured, not assumed: the BARE host `vaiven.owncompute.com` IS a substring of the
		// sandbox host `uc.vaiven.owncompute.com`, so matching on the bare host would rewrite
		// the middle of any sandbox URL and produce a host that resolves nowhere. The
		// scheme-qualified origin is not a substring of the sandbox origin, which is the only
		// reason this is safe — so pin it, or a later "simplification" reintroduces the bug.
		expect("uc.vaiven.owncompute.com").toContain("vaiven.owncompute.com");
		expect(`https://uc.vaiven.owncompute.com`).not.toContain(CANONICAL_ORIGIN);

		const sandboxUrl = "https://uc.vaiven.owncompute.com/c/d_abc";
		const rewritten = sandboxUrl.replaceAll(CANONICAL_ORIGIN, () => "https://vaiven.example");
		expect(rewritten).toBe(sandboxUrl);
	});

	test("no URL in a served page is flush against a markdown emphasis marker", async () => {
		// A renderer closes `*emphasis*` correctly; an agent extracting URLs with a regex does
		// not, and takes the `*` with it. The version stamp had exactly this shape, so the one
		// address whose entire job is to be re-fetchable extracted as a 404.
		for (const path of Object.keys(pageText)) {
			const served = await serve(path);
			// Take the whole non-space run and look at how it ENDS. `_` is a legal URL
			// character (d_YOUR_DOCUMENT_ID), so only a trailing marker is a problem.
			const glued = [...served.matchAll(/https?:\/\/\S+/g)]
				.map((m) => m[0])
				.filter((url) => /[*~]$/.test(url));
			expect({ path, glued }).toEqual({ path, glued: [] });
		}
	});

	test("every served page carries the version stamp", async () => {
		for (const path of Object.keys(pageText)) {
			expect(await serve(path)).toContain(`always at https://vaiven.example${path} `);
		}
	});

	test("the stamp names the version the copy was taken at", async () => {
		const version = (await Bun.file(new URL("../VERSION", import.meta.url)).text()).trim();
		expect(await serve("/guide.md")).toContain(`*Vaivén ${version} —`);
	});

	test("the served body is byte-stable, so diffing a copy against a fetch is meaningful", async () => {
		expect(await serve("/guide.md")).toBe(await serve("/guide.md"));
	});

	test("the frontmatter still comes first, because this is read as a skill file", async () => {
		expect((await serve("/guide.md")).startsWith("---\nname: vaiven")).toBe(true);
	});

	test("a page with no heading is still stamped rather than served bare", async () => {
		// The stamp attaches after the first heading. Silently serving an unstamped page is
		// the exact state it exists to prevent.
		const served = await serve("/guide/limits.md");
		expect(served).toContain("the current version of this page is always at");
	});

	test("an unknown page is refused, and never reaches the stamp", async () => {
		expect(await serve("/guide/nope.md")).toContain("Not written yet");
		expect((await serveGuide(config, "/guide/Nope.MD")).status).toBe(404);
		expect((await serveGuide(config, "/guide/../schema.sql")).status).toBe(404);
	});

	test("there is a heading for the freshness stamp to attach to", () => {
		// serveGuide injects the version stamp after the first markdown heading. The manual
		// travels as a COPY into ~/.claude/skills/vaiven/SKILL.md, so without a version on
		// it a correction made today never reaches anyone who installed yesterday.
		expect(guide).toMatch(/^#\s.+$/m);
	});

	test("the substitution cannot be corrupted by $ sequences in the origin", async () => {
		// A string replacement interprets $&, $', $` and $$ INSIDE the replacement, so an
		// origin carrying one would rewrite or truncate the manual. Config refuses such a
		// host at startup; this pins the second lock, through the real handler.
		const hostile = "https://a$'b$&c.example";
		const hostileConfig = { appOrigin: hostile } as unknown as Config;
		const served = await (await serveGuide(hostileConfig, "/guide.md")).text();
		expect(served).toContain(`${hostile}/guide/app-mode.md`);
		expect(served).not.toContain("$HOST");
		// And the document is not duplicated or truncated by the expansion.
		expect(served.length).toBeLessThan(guide.length * 2);
	});

	test("every blank the examples ask you to fill in is explained in the legend", () => {
		// The manual now uses literal SHOUTED tokens instead of shell variables, so a reader
		// cannot infer from syntax that something is a blank. The legend table is what tells
		// them — so every token used anywhere must appear in it, or the reader meets a
		// placeholder with no idea where its value comes from.
		const legend = guide.slice(guide.indexOf("| Fill in |"), guide.indexOf("```bash"));
		const used = new Set<string>();
		for (const text of Object.values(pageText)) {
			for (const [token] of text.matchAll(/\b(?:[dk]_)?YOUR_[A-Z_]+\b/g)) used.add(token);
		}
		expect(used.size).toBeGreaterThan(3);
		for (const token of used) expect(legend).toContain(token);
	});
});

// ---------------------------------------------------------------------------------------

describe("the inlined tables cannot drift from the code", () => {
	// guide.md now carries the error table and the limits inline, because the whole point of
	// the page is that one fetch is enough. That duplicates src/errors.ts and src/quota.ts,
	// and duplication nothing checks goes stale — a wrong status here sends an agent down the
	// wrong recovery path with no error to tell it so. These tests are the pin.
	const rows = new Map<string, number>();
	for (const [, code, status] of guide.matchAll(/^\| `(\w+)` \| (\d{3}) \|/gm)) {
		rows.set(code!, Number(status));
	}

	test("the table has a row for every code the server can actually throw", async () => {
		const thrown = new Set(Object.keys(STATUS));
		// `upstream_error` is declared but never thrown, so the manual is right to omit it.
		// Asserted rather than assumed, because the day it IS thrown the table must grow.
		thrown.delete("upstream_error");
		expect(new Set(rows.keys())).toEqual(thrown);
	});

	test("upstream_error really is unreachable, which is why it is omitted", async () => {
		const glob = new Bun.Glob("**/*.ts");
		let thrownAnywhere = false;
		for await (const file of glob.scan({ cwd: new URL("../src", import.meta.url).pathname })) {
			const text = await Bun.file(new URL(`../src/${file}`, import.meta.url)).text();
			if (/fail\(\s*"upstream_error"/.test(text)) thrownAnywhere = true;
		}
		expect(thrownAnywhere).toBe(false);
	});

	for (const [code, status] of Object.entries(STATUS)) {
		if (code === "upstream_error") continue;
		test(`guide.md gives ${code} the status the server sends`, () => {
			expect(rows.get(code)).toBe(status);
		});
	}

	test("every size and rate in the manual is the number the server enforces", () => {
		// Collapsed to single spaces: the manual is wrapped prose, so a limit can legitimately
		// straddle a line break and still be the same sentence.
		const limits = guide
			.slice(guide.indexOf("The limits behind those:"))
			.replace(/\s+/g, " ");
		expect(limits).toContain(`\`content\` ${LIMITS.contentBytes / 1024 / 1024} MB`);
		expect(limits).toContain(`\`state\` ${LIMITS.stateBytes / 1024 / 1024} MB`);
		expect(limits).toContain(`${RATES.write} writes a minute`);
		expect(limits).toContain(`${RATES.publicRead} reads of a read URL`);
		expect(limits).toContain(`${RATES.apiRead} API reads`);
		expect(limits).toContain(`${LIMITS.eventsPerWrite} events per write`);
		expect(limits).toContain(`truncated at ${CLAMP} characters`);
		expect(limits).toContain(`labels at 40`);
		expect(limits).toContain(`\`title\` is capped at ${LIMITS.titleChars} characters`);
		expect(limits).toContain(`\`sender_note\` at ${LIMITS.senderNoteChars}`);
		expect(limits).toContain(`key label at ${LIMITS.labelChars}`);
		expect(limits).toContain(`More than ${COLLAPSE_AT} changes`);
	});
});
