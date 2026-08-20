// A stylesheet can be broken in a way that no brace counter and no eye catches.
//
// 0.3.0.0 removed the Done dialog by deleting a line range. That took `.panel-body textarea {`
// with it and left the ten declarations underneath with no selector. Nothing threw. A
// selector-less block is not inert: the CSS parser, looking for a qualified rule, consumes
// forward until the next `{`, folds whatever it passed over into an invalid prelude, and DROPS
// that rule. `.panel-body > p` was the rule underneath, and it was dead in production for two
// releases. The panel's own explanatory paragraph rendered at the wrong size that entire time.
//
// Measured against `df7a319:src/shell/shell.css`, the commit that introduced it: the file
// carried a brace depth of **-1**, so even a trivial brace counter would have caught this on
// the day it shipped. There was no such check. That is the whole argument for this file — the
// defect was not subtle, it was simply unwatched. The orphan scan below flags 14 lines on that
// same file, so both checks here are known to fire on the real defect rather than asserted to.
//
// This is a structural check, not a style one. It does not care what the rules say.

import { describe, expect, test } from "bun:test";

const SHEETS = ["shell.css"];

async function read(name: string): Promise<string> {
	return await Bun.file(new URL(`../src/shell/${name}`, import.meta.url)).text();
}

/** Comments and strings both hold braces and semicolons of their own, and either will desync
 *  every count below. Both are blanked to spaces rather than removed, so line numbers survive
 *  into the failure message.
 *
 *  An adversarial pass found two ways the first version of this could be defeated, and both
 *  are handled here rather than noted and left:
 *    - An UNTERMINATED `/*` is not matched by a lazy comment regex, so everything after it was
 *      still being counted while the browser treats it as commented out. `unterminated()` below
 *      is a separate check for exactly that.
 *    - A brace inside a string, `content: "{"`, was counted as structural. That is legal CSS
 *      and would have failed the build for no reason. */
const BLANK = (m: string) => m.replace(/[^\n]/g, " ");
const stripNoise = (css: string) =>
	css
		.replace(/\/\*[\s\S]*?\*\//g, BLANK)
		.replace(/"(?:[^"\\\n]|\\.)*"/g, BLANK)
		.replace(/'(?:[^'\\\n]|\\.)*'/g, BLANK);

/** `/*` with no closer. Everything after it is comment to a browser and code to a naive scan,
 *  which is the difference that lets a broken sheet look balanced. */
const unterminated = (css: string) => {
	const withoutPairs = css.replace(/\/\*[\s\S]*?\*\//g, BLANK);
	return withoutPairs.includes("/*");
};

const stripComments = stripNoise;

describe.each(SHEETS)("%s parses as the author intended", (name) => {
	test("braces balance", async () => {
		const css = stripComments(await read(name));
		let depth = 0;
		for (const ch of css) {
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
			expect(depth).toBeGreaterThanOrEqual(0); // a `}` with no opener
		}
		expect(depth).toBe(0);
	});

	test("no comment is left open", async () => {
		// A sheet with an unterminated `/*` can satisfy every other check in this file while the
		// browser discards everything from that point on.
		expect(unterminated(await read(name))).toBe(false);
	});

	test("no declaration sits at the top level without a selector", async () => {
		// The check that would have caught the 0.3.0.0 defect. At depth 0 a line ending in `;`
		// and containing `:` is a declaration that has lost its rule. `@import`/`@charset` are
		// the legitimate exception: they are at-rules, not declarations.
		//
		// KNOWN LIMIT, stated rather than discovered later: this looks at depth 0 only, so an
		// orphan directly inside an `@media` block would slip past, as would a declaration
		// split across lines or written without a trailing semicolon. It catches the shape the
		// defect actually had. Widening it means parsing CSS properly, which is a different and
		// larger job than a guard against one regression.
		const css = stripComments(await read(name));
		let depth = 0;
		const orphans: string[] = [];
		css.split("\n").forEach((line, i) => {
			const text = line.trim();
			if (depth === 0 && text && !text.startsWith("@") && text.endsWith(";") && text.includes(":")) {
				orphans.push(`${name}:${i + 1}  ${text}`);
			}
			for (const ch of line) {
				if (ch === "{") depth++;
				else if (ch === "}") depth--;
			}
		});
		expect(orphans).toEqual([]);
	});

	test("every block is preceded by something that could be a selector", async () => {
		// Catches the mirror image: a `{` whose prelude is empty, which the parser also
		// discards. Deleting a selector line and leaving its body is how that happens.
		const css = stripComments(await read(name));
		let depth = 0;
		const empty: number[] = [];
		const lines = css.split("\n");
		lines.forEach((line, i) => {
			const openAt = line.indexOf("{");
			if (depth === 0 && openAt !== -1) {
				const before = line.slice(0, openAt).trim() || (lines[i - 1] ?? "").trim();
				if (!before || before.endsWith(";") || before.endsWith("}")) empty.push(i + 1);
			}
			for (const ch of line) {
				if (ch === "{") depth++;
				else if (ch === "}") depth--;
			}
		});
		expect(empty).toEqual([]);
	});
});

describe("the rule the 0.3.0.0 defect silently killed", () => {
	test(".panel-body > p is still reachable, not swallowed by an orphan above it", async () => {
		const css = stripComments(await read("shell.css"));
		const at = css.indexOf(".panel-body > p");
		expect(at).toBeGreaterThan(-1);
		// Nothing between the previous `}` and this selector except whitespace. If an orphaned
		// block sat above, the text between would carry declarations.
		const priorClose = css.lastIndexOf("}", at);
		expect(priorClose).toBeGreaterThan(-1);
		expect(css.slice(priorClose + 1, at).trim()).toBe("");
	});
});
