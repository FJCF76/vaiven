// What the server reads out of published markup.
//
// The exclusions here are a security boundary, not a nicety: whatever seeding captures
// becomes state, and the FIRST edit to that field records the seeded value as `from` in an
// event log that is readable from a bearer URL. A field the helper refuses to report but
// the seeder happily reads is therefore published, once, on the way out.

import { describe, expect, test } from "bun:test";
import { extractSeedFields, seedStateFromContentSync } from "../src/seed.ts";

const seed = (html: string) => extractSeedFields(`<!doctype html><html><body>${html}</body></html>`);

describe("what is captured", () => {
	test("text inputs and their values", async () => {
		expect(await seed(`<input name="fee" value="18400">`)).toEqual({ fee: "18400" });
	});

	test("a missing value is an empty string, not absent", async () => {
		expect(await seed(`<input name="fee">`)).toEqual({ fee: "" });
	});

	test("checkboxes are booleans", async () => {
		expect(await seed(`<input type="checkbox" name="a" checked><input type="checkbox" name="b">`)).toEqual({
			a: true,
			b: false,
		});
	});

	test("a radio group records the checked value", async () => {
		const found = await seed(
			`<input type="radio" name="s" value="x"><input type="radio" name="s" value="y" checked>`,
		);
		expect(found).toEqual({ s: "y" });
	});

	test("a radio group with nothing checked is empty, not the last value", async () => {
		expect(await seed(`<input type="radio" name="s" value="x"><input type="radio" name="s" value="y">`)).toEqual({
			s: "",
		});
	});

	test("textarea content", async () => {
		expect(await seed(`<textarea name="notes">first line</textarea>`)).toEqual({ notes: "first line" });
	});

	test("a select takes the selected option", async () => {
		const html = `<select name="city"><option value="a">A</option><option value="b" selected>B</option></select>`;
		expect(await seed(html)).toEqual({ city: "b" });
	});

	test("a select with nothing selected takes the first option, which is what the browser shows", async () => {
		const html = `<select name="city"><option value="a">A</option><option value="b">B</option></select>`;
		expect(await seed(html)).toEqual({ city: "a" });
	});

	test("an option with no value attribute submits its text", async () => {
		expect(await seed(`<select name="c"><option selected>Santander</option></select>`)).toEqual({ c: "Santander" });
	});

	test("<select multiple> is array-valued", async () => {
		const html = `<select name="d" multiple><option value="mon" selected>M</option><option value="tue">T</option><option value="wed" selected>W</option></select>`;
		expect(await seed(html)).toEqual({ d: ["mon", "wed"] });
	});

	test("a named contenteditable region — the living-document case", async () => {
		expect(await seed(`<div contenteditable name="summary">An editable region.</div>`)).toEqual({
			summary: "An editable region.",
		});
	});
});

describe("what must never be captured", () => {
	test("passwords", async () => {
		expect(await seed(`<input type="password" name="secret" value="hunter2">`)).toEqual({});
	});

	test("file inputs, which cannot be restored", async () => {
		expect(await seed(`<input type="file" name="upload">`)).toEqual({});
	});

	test("hidden inputs", async () => {
		expect(await seed(`<input type="hidden" name="csrf" value="tok">`)).toEqual({});
	});

	test('autocomplete="off" — the helper honours it, so the seeder must too', async () => {
		expect(await seed(`<input name="off" autocomplete="off" value="private">`)).toEqual({});
	});

	test("payment autocomplete hints", async () => {
		expect(await seed(`<input name="card" autocomplete="cc-number" value="4111">`)).toEqual({});
	});

	test("data-vaiven-ignore on the field itself", async () => {
		expect(await seed(`<input name="x" data-vaiven-ignore value="private">`)).toEqual({});
	});

	test("data-vaiven-ignore on an ancestor", async () => {
		expect(await seed(`<div data-vaiven-ignore><label><input name="x" value="private"></label></div>`)).toEqual({});
	});

	test("...and the subtree ends where the element ends", async () => {
		const found = await seed(`<div data-vaiven-ignore><input name="x" value="private"></div><input name="y" value="ok">`);
		expect(found).toEqual({ y: "ok" });
	});

	test("a field the author disabled", async () => {
		expect(await seed(`<input name="frozen" value="frozen" disabled>`)).toEqual({});
	});

	test("an excluded textarea leaves nothing behind", async () => {
		expect(await seed(`<textarea name="n" autocomplete="off">private</textarea>`)).toEqual({});
	});

	test("a field with no name has no key to be stored under", async () => {
		expect(await seed(`<input value="unnamed">`)).toEqual({});
	});
});

describe("merging", () => {
	test("stored state always wins, which is what makes republishing safe", () => {
		expect(seedStateFromContentSync({ fee: "900" }, { fee: "18400", extra: "new" })).toEqual({
			fee: "900",
			extra: "new",
		});
	});

	test("a falsy stored value still wins", () => {
		expect(seedStateFromContentSync({ agreed: false }, { agreed: true })).toEqual({ agreed: false });
	});
});
