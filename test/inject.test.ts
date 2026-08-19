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
