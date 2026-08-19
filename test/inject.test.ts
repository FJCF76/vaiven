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
		for (const selector of ["body", "html", ":root", "body.dark", "html,body", "body:has(.x)", "html > body"]) {
			expect(await warns(`<style>${dark} ${selector}{background:#111} }</style>`)).toBe(false);
		}
	});

	test("painting something INSIDE the page is not painting the canvas", async () => {
		// The false negative in the first implementation: these all leave the canvas white.
		for (const selector of ["body .card", "body > main", ".wrap"]) {
			expect(await warns(`<style>${dark} ${selector}{background:#111} }</style>`)).toBe(true);
		}
	});

	test("a light canvas painted globally does NOT excuse a dark block that only sets color", async () => {
		// This test asserted the opposite until an adversarial review pointed out that it pinned
		// the miss: `body{background:#fff}` plus a dark block setting `color:#eee` IS the
		// reported bug — a white canvas with light text — and "is a background painted anywhere"
		// calls it correct.
		expect(await warns(`<style>body{background:#fff;color:#111}${dark} body{color:#eee} }</style>`)).toBe(true);
	});

	test(":root counts as the canvas", async () => {
		// :root IS the html element, and is where custom properties live, so it is the form an
		// agent is most likely to write. Excluding it flagged correct pages.
		expect(await warns(`<style>${dark} :root{background:#111} }</style>`)).toBe(false);
	});

	test("theming done in JavaScript is not read as CSS", async () => {
		expect(await warns(`<script>matchMedia("(prefers-color-scheme: dark)")</script>`)).toBe(false);
	});

	test("prose about dark mode is not read as CSS", async () => {
		expect(await warns(`<p>Use prefers-color-scheme: dark for themes</p>`)).toBe(false);
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

	test("no content shape stalls the event loop", async () => {
		// Two implementations were quadratic here, on OPPOSITE shapes, and the first regression
		// test pinned only the first shape so the second shipped green. `prepareContent` runs on
		// the UNAUTHENTICATED GET /c/:id path in a single-threaded process, so a stall is not
		// slow for one reader, it is downtime for every tenant. Measured before the fix: 903ms
		// at 400KB of `{`, extrapolating to ~90s at the 4MB content cap.
		const shapes = [
			"{".repeat(4 * 1024 * 1024), // many opens, one close — the second implementation
			"{}".repeat(2 * 1024 * 1024), // many complete rules
			"body ".repeat(800_000), // many selector tokens, no braces — the first implementation
			"{".repeat(2 * 1024 * 1024) + "}".repeat(2 * 1024 * 1024), // deep nesting
		];
		for (const payload of shapes) {
			const started = performance.now();
			await prepareContent(
				`<!doctype html><html><head></head><body><style>${dark}${payload}}</style></body></html>`,
				"/*h*/",
			);
			expect(performance.now() - started).toBeLessThan(2000);
		}

		// The THIRD quadratic, and the one that mattered most: a lazy regex extracting <style>
		// bodies rescans to end-of-document for every unterminated opener. Measured before the
		// fix: 9.7s at 50k tags, 148s at 200k — inside the content cap, on the unauthenticated
		// serve path. These shapes never touch a regex now.
		const documentShapes = [
			"<style>".repeat(600_000), // unterminated openers
			`<div style="${"a".repeat(2_000_000)}>x</div>`, // unterminated attribute quote
			"<style>a{color:red}</style>".repeat(100_000), // many well-formed blocks
			`<img src="data:image/png;base64,${"A".repeat(4 * 1024 * 1024)}">`, // a big asset
		];
		for (const payload of documentShapes) {
			const started = performance.now();
			await prepareContent(`<!doctype html><html><head></head><body>${payload}</body></html>`, "/*h*/");
			expect(performance.now() - started).toBeLessThan(2000);
		}
	});

	test("a document full of base64 data: URIs is not told it uses viewport units", async () => {
		// `+` `/` `=` are word boundaries, so `…/3vh+…` matched `\b3vh\b`. Measured 1-2 in 10
		// sample documents before the scan was narrowed to CSS — and the guide instructs authors
		// to embed assets as data: URIs, so the collision was designed in.
		const b64 = Buffer.from(crypto.getRandomValues(new Uint8Array(400_000))).toString("base64");
		const { warnings } = await prepareContent(
			`<!doctype html><html><head></head><body><img src="data:image/png;base64,${b64}"></body></html>`,
			"/*h*/",
		);
		expect(warnings.map((w) => w.code)).not.toContain("no_viewport");
	});
});

describe("a canvas that is already dark is not warned about", () => {
	const dark = "@media (prefers-color-scheme: dark){";
	const warns = async (fragment: string) =>
		(await prepareContent(`<!doctype html><html><head></head><body>${fragment}</body></html>`, "/*h*/")).warnings.some(
			(w) => w.code === "dark_mode_no_background",
		);

	test("a dark canvas painted for both themes is correct, in every literal form", async () => {
		for (const colour of ["#111", "#111111", "rgb(17,17,17)", "black"]) {
			expect(await warns(`<style>body{background:${colour}}${dark} body{color:#eee} }</style>`)).toBe(false);
		}
		expect(await warns(`<body style="background:#111"><style>${dark} .x{color:#eee} }</style>`)).toBe(false);
	});

	test("a LIGHT canvas painted for both themes is the bug, in every literal form", async () => {
		for (const colour of ["#fff", "#ffffff", "rgb(255,255,255)", "white"]) {
			expect(await warns(`<style>body{background:${colour}}${dark} body{color:#eee} }</style>`)).toBe(true);
		}
	});

	test("an unreadable colour warns rather than staying quiet", async () => {
		// A spurious warning costs a sentence; a missed one costs a person an unreadable page.
		expect(await warns(`<style>body{background:color-mix(in srgb, red, blue)}${dark} body{color:#eee} }</style>`)).toBe(
			true,
		);
	});
});
