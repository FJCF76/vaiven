// The three strings that tell a person what happens to what they type.
//
// There are THREE, and that is the whole reason this file exists. The write notice, the
// read-only notice, and the "What's recorded" panel each make the same claim about who can
// read the record. The first person to use the system reported the wording as confusing
// ("nobody sent me a link"); the fix landed on ONE of the three and the other two kept the
// reported phrasing for two releases. Nothing failed, because nothing was watching.
//
// Source text, not a rendered DOM: `shell.js` runs in a browser and touches `document` at
// module scope, so importing it here would throw. What is being guarded is a claim a human
// reads, and the claim is in the source.

import { describe, expect, test } from "bun:test";

const shell = await Bun.file(new URL("../src/shell/shell.js", import.meta.url)).text();

/** The template literals passed to `el("span", ...)` inside `renderDisclosure`, plus the
 *  panel's own paragraph. Extracted by their opening words rather than by line number, so
 *  editing the prose does not silently drop a string out of coverage. */
const CLAIMS = [
	{ name: "write notice", opens: "Your edits save automatically" },
	{ name: "read-only notice", opens: "You can read this document but not change it" },
	{ name: "what's-recorded panel", opens: "Everything this document has recorded" },
];

function claim(opens: string): string {
	const start = shell.indexOf(opens);
	if (start === -1) throw new Error(`Disclosure string starting "${opens}" is gone. If it was reworded, reword it HERE too rather than deleting the guard.`);
	// To the end of the string literal it lives in.
	const end = shell.indexOf("\n", start);
	return shell.slice(start, end === -1 ? undefined : end);
}

describe("every string that names who can read the record names the same party", () => {
	test("all three exist", () => {
		expect(CLAIMS.length).toBe(3);
		for (const c of CLAIMS) expect(claim(c.opens).length).toBeGreaterThan(40);
	});

	for (const c of CLAIMS) {
		test(`the ${c.name} names the creator`, () => {
			// Case-insensitive: the panel string opens its second sentence with the phrase, so
			// it is capitalised there and mid-sentence in the other two. Same party either way.
			expect(claim(c.opens).toLowerCase()).toContain("whoever created the document");
		});
	}

	test("none of them names a sender the reader may not have", () => {
		// The exact phrasing that was reported. `shell.js:671` legitimately says "the person
		// who shared it" about who to ask for a REPLACEMENT KEY, which is a different claim
		// and a different sentence, so this is scoped to the three disclosure strings.
		for (const c of CLAIMS) {
			expect(claim(c.opens)).not.toContain("person who shared the link");
			expect(claim(c.opens)).not.toContain("sent you this link");
		}
	});
});

describe("the claims a consent notice has to keep making", () => {
	test("the write notice says edits are recorded, under a name, and that others can edit", () => {
		const write = claim("Your edits save automatically");
		expect(write).toContain("recorded under the name");
		expect(write).toContain("${label}");
		expect(write).toContain("Anyone with this link");
	});

	test("the read-only notice is honest that opening is still noted", () => {
		const read = claim("You can read this document but not change it");
		expect(read).toContain("Nothing you type is kept");
		expect(read).toContain("noted");
	});
});
