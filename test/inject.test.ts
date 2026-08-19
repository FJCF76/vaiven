// Publish-time detection of the two failures an author cannot see for themselves.

import { expect, test, describe } from "bun:test";
import { prepareContent } from "../src/inject.ts";

describe("rendering warnings — failures the author structurally cannot see", () => {
	// Both of these were first proposed as sentences in the manual. The manual is fetched once,
	// before any HTML is written, and these bugs are found by the person who opens the document
	// — who has no channel back. `warnings` rides every read, so the agent meets it while it
	// can still act.
	const codes = async (html: string) =>
		(await prepareContent(html, "/*helper*/")).warnings.map((w) => w.code);

	test("a dark-mode block that never paints a background is flagged", async () => {
		expect(
			await codes(`<!doctype html><html><head><style>@media (prefers-color-scheme: dark){ .card{color:#eee} }</style></head><body>x</body></html>`),
		).toContain("dark_mode_no_background");
	});

	test("a dark-mode block that DOES paint the canvas is not flagged", async () => {
		// The false positive that would train agents to ignore warnings.
		expect(
			await codes(`<!doctype html><html><head><style>@media (prefers-color-scheme: dark){ body{background:#111;color:#eee} }</style></head><body>x</body></html>`),
		).not.toContain("dark_mode_no_background");
	});

	test("an inline background on body counts as painting it", async () => {
		expect(
			await codes(`<!doctype html><html><head><style>@media (prefers-color-scheme: dark){ .c{color:#eee} }</style></head><body style="background:#111">x</body></html>`),
		).not.toContain("dark_mode_no_background");
	});

	test("viewport units are flagged — they are circular here, not merely ignored", async () => {
		// The frame is grown to the content's scrollHeight, so a 100vh block plus anything else
		// grows the document every round trip until the 20000px clamp. Documenting it as inert
		// would have been wrong.
		expect(await codes(`<!doctype html><html><head><style>.hero{height:100vh}</style></head><body>x</body></html>`)).toContain(
			"no_viewport",
		);
		for (const unit of ["dvh", "svh", "lvh"]) {
			expect(await codes(`<!doctype html><html><head><style>.h{height:100${unit}}</style></head><body>x</body></html>`)).toContain(
				"no_viewport",
			);
		}
	});

	test("fixed and sticky are flagged", async () => {
		expect(await codes(`<!doctype html><html><head><style>th{position:sticky;top:0}</style></head><body>x</body></html>`)).toContain(
			"no_viewport",
		);
		expect(await codes(`<!doctype html><html><head><style>nav{position:fixed}</style></head><body>x</body></html>`)).toContain(
			"no_viewport",
		);
	});

	test("an ordinary page earns no rendering warnings at all", async () => {
		expect(
			await codes(`<!doctype html><html><head><style>body{background:#fff;color:#111}</style></head><body>x</body></html>`),
		).toEqual([]);
	});

	test("the message names the mechanism, not just the symptom", async () => {
		const { warnings } = await prepareContent(
			`<!doctype html><html><head><style>.h{height:100vh}</style></head><body>x</body></html>`,
			"/*helper*/",
		);
		const w = warnings.find((x) => x.code === "no_viewport")!;
		expect(w.message).toContain("sized to your content");
	});
});

describe("canvas detection is precise about which selector paints", () => {
	// Every case below was produced by an adversarial review of the first implementation,
	// which used one selector-through-declaration regex. That version was quadratic AND wrong:
	// `body .card { background }` counted as painting the canvas.
	const dark = "@media (prefers-color-scheme: dark){";
	const warns = async (fragment: string) =>
		(await prepareContent(`<!doctype html><html><head></head><body>${fragment}</body></html>`, "/*h*/")).warnings.some(
			(w) => w.code === "dark_mode_no_background",
		);

	test("painting the canvas, in all the shapes people write it", async () => {
		for (const selector of ["body", "html", "body.dark", "html,body", "body:has(.x)", "html > body"]) {
			expect(await warns(`<style>${dark} ${selector}{background:#111} }</style>`)).toBe(false);
		}
	});

	test("painting something INSIDE the page is not painting the canvas", async () => {
		// The false negative in the first implementation: these all leave the canvas white.
		for (const selector of ["body .card", "body > main", ".wrap"]) {
			expect(await warns(`<style>${dark} ${selector}{background:#111} }</style>`)).toBe(true);
		}
	});

	test("a background set outside the dark block still counts", async () => {
		expect(await warns(`<style>body{background:#111}${dark} .x{color:#eee} }</style>`)).toBe(false);
	});

	test("the idiomatic custom-property pattern is not flagged", async () => {
		// body{background:var(--bg)} with --bg redefined in the dark block. Warning on this
		// would train authors to ignore warnings, which is worse than not warning at all.
		expect(
			await warns(`<style>body{background:var(--bg)}:root{--bg:#fff}${dark} :root{--bg:#111} }</style>`),
		).toBe(false);
	});

	test("rules nested inside at-rules are still found", async () => {
		// A scanner that does not descend into @media finds no dark-mode rule at all, which is
		// where essentially every rule worth finding lives.
		expect(await warns(`<style>@supports (color:red){${dark} body{background:#111} }}</style>`)).toBe(false);
	});

	test("4 MB of hostile content does not stall the event loop", async () => {
		// `body ` repeated with no braces made the original regex rescan the remaining
		// megabytes from every candidate. Publishing is on the request path.
		const hostile = `${dark}}` + "body ".repeat(800_000);
		const started = performance.now();
		await prepareContent(`<!doctype html><html><head></head><body>${hostile}</body></html>`, "/*h*/");
		expect(performance.now() - started).toBeLessThan(2000);
	});
});
