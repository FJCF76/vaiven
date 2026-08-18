// The manual describes an API. This asserts the API it describes is the API that exists.
//
// A real agent read guide.md, found `Vaiven.render` and `mutate` named but never defined,
// and stopped to ask a human rather than invent the signatures — which was the right call,
// because an invented API does not fail at publish time. It fails silently in someone's
// browser and surfaces three turns later as an `error` event. So the signatures live in
// the manual now, and this test is what keeps them true.

import { describe, expect, test } from "bun:test";

const guide = await Bun.file(new URL("../guide.md", import.meta.url)).text();
const helper = await Bun.file(new URL("../src/shell/helper.js", import.meta.url)).text();

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

	test("nothing is documented that does not exist", () => {
		for (const match of guide.matchAll(/Vaiven\.(\w+)/g)) {
			expect(surface).toContain(match[1]!);
		}
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
		const pages = [...guide.matchAll(/\$HOST\/guide\/([a-z-]+\.md)/g)].map((m) => m[1]!);
		expect(pages.length).toBeGreaterThan(0);
		for (const page of new Set(pages)) {
			expect(await Bun.file(new URL(`../guide/${page}`, import.meta.url)).exists()).toBe(true);
		}
	});

	test("the substitution leaves no placeholder behind in what is served", () => {
		// What serveGuide does, applied here so the rule is pinned to a test rather than to
		// one line in a route handler.
		const served = guide.replaceAll("$HOST", "https://vaiven.example");
		expect(served).not.toContain("$HOST");
		expect(served).toContain("https://vaiven.example/guide/app-mode.md");
	});

	test("there is a heading for the freshness stamp to attach to", () => {
		// serveGuide injects the version stamp after the first markdown heading. The manual
		// travels as a COPY into ~/.claude/skills/vaiven/SKILL.md, so without a version on
		// it a correction made today never reaches anyone who installed yesterday.
		expect(guide).toMatch(/^#\s.+$/m);
	});

	test("$KEY and $DOC are deliberately left for the caller to fill in", () => {
		const served = guide.replaceAll("$HOST", "https://vaiven.example");
		expect(served).toContain("$KEY");
		expect(served).toContain("$DOC");
	});
});
