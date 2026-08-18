// The manual describes an API. This asserts the API it describes is the API that exists.
//
// A real agent read guide.md, found `Vaiven.render` and `mutate` named but never defined,
// and stopped to ask a human rather than invent the signatures — which was the right call,
// because an invented API does not fail at publish time. It fails silently in someone's
// browser and surfaces three turns later as an `error` event. So the signatures live in
// the manual now, and this test is what keeps them true.

import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { serveGuide } from "../src/routes/static.ts";

const guide = await Bun.file(new URL("../guide.md", import.meta.url)).text();
const helper = await Bun.file(new URL("../src/shell/helper.js", import.meta.url)).text();

/** Every page the server will serve, not just the front one. The sub-pages are where the
 *  API is documented in depth, so they are where an invented signature would hide. */
const SUB_PAGES = ["app-mode.md", "errors.md", "limits.md"];
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
	// It handed out `$HOST/guide/app-mode.md`, a shell placeholder, as the ONLY pointer to
	// the app-mode API. serveGuide substitutes the real origin now; these assert the two
	// halves of that contract.
	test("the file on disk uses the $HOST placeholder", () => {
		expect(guide).toContain("$HOST/guide/app-mode.md");
	});

	test("every sub-page the guide names exists on disk", async () => {
		// [a-z0-9-] to match the server's own guard. `[a-z-]` silently skipped any page with
		// a digit in its name, so the test's claim quietly became false without failing.
		const pages = [...guide.matchAll(/\$HOST\/guide\/([a-z0-9-]+\.md)/g)].map((m) => m[1]!);
		expect(pages.length).toBeGreaterThan(0);
		for (const page of new Set(pages)) {
			expect(await Bun.file(new URL(`../guide/${page}`, import.meta.url)).exists()).toBe(true);
		}
	});

	test("the SERVED page has no placeholder left in it", async () => {
		// Through serveGuide, not through a copy of what serveGuide does. The previous
		// version of this test reimplemented the replacement inline, so deleting the
		// substitution from the route left every test passing while $HOST shipped raw.
		const served = await serve("/guide.md");
		expect(served).not.toContain("$HOST");
		expect(served).toContain("https://vaiven.example/guide/app-mode.md");
	});

	test("every served page carries the version stamp", async () => {
		for (const path of Object.keys(pageText)) {
			expect(await serve(path)).toContain(`current version always at https://vaiven.example${path}`);
		}
	});

	test("the stamp names the version the copy was taken at", async () => {
		const version = (await Bun.file(new URL("../VERSION", import.meta.url)).text()).trim();
		expect(await serve("/guide.md")).toContain(`*Vaivén ${version} ·`);
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
		expect(served).toContain("current version always at");
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

	test("$KEY and $DOC are deliberately left for the caller to fill in", async () => {
		const served = await serve("/guide.md");
		expect(served).toContain("$KEY");
		expect(served).toContain("$DOC");
	});
});
