// The three strings that tell a person what happens to what they type.
//
// There are THREE, and that is the whole reason this file exists. The write notice, the
// read-only notice, and the "What's recorded" panel each make the same claim about who can
// read the record. The first person to use the system reported the wording as confusing
// ("nobody sent me a link"); the fix landed on ONE of the three and the other two kept the
// reported phrasing for two releases. Nothing failed, because nothing was watching.
//
// Source text, not a rendered DOM: `shell.js` runs in a browser and touches `document` at
// module scope, so importing it here would throw. What is guarded is a claim a human reads,
// and the claim is in the source. The rendered side is covered by `test/repaint.ts` and the
// browser checks in the QA pass; this file is the cheap half, and says so rather than
// implying it watches the shipped page.
//
// The first version of this file was picked apart by an adversarial pass and deserved it:
// it matched the FIRST occurrence of an opening phrase without proving uniqueness, sliced to
// the next newline rather than to the end of the sentence (so a reworded multi-line notice
// would have been half-checked), and compared case-sensitively. Each of those is fixed below,
// because a guard that can pass while the thing it guards is broken is worse than no guard.

import { describe, expect, test } from "bun:test";

const shell = await Bun.file(new URL("../src/shell/shell.js", import.meta.url)).text();

/** The shell with whole-line `//` comments blanked out. The comment above the disclosure
 *  QUOTES the retired phrasing on purpose, so a naive whole-file scan flags the record of the
 *  fix as if it were the defect. Only whole-line comments are removed, never a trailing `//`,
 *  because that would cut a string containing `https://` in half. Lines are kept as empty
 *  lines so any offset reported in a failure still points at the right place. */
const shellCode = shell
	.split("\n")
	.map((line) => (line.trim().startsWith("//") ? "" : line))
	.join("\n");

/** Bounded by BOTH ends. The write notice is deliberately not one string any more — the
 *  caller-supplied name is its own element — so an opening-phrase-to-newline slice would now
 *  miss most of it. Opening and closing phrase together survive that, survive reformatting,
 *  and survive the sentence being split across more nodes later. */
const CLAIMS = [
	{
		name: "write notice",
		opens: "Your edits save automatically",
		closes: "can read back what changed.",
	},
	{
		name: "read-only notice",
		opens: "You can read this document but not change it",
		closes: "Anyone with this link can read it too.",
	},
	{
		name: "what's-recorded panel",
		opens: "Everything this document has recorded",
		closes: "can read all of it.",
	},
];

function claim(c: { name: string; opens: string; closes: string }): string {
	const start = shell.indexOf(c.opens);
	if (start === -1) {
		throw new Error(`The ${c.name} opening "${c.opens}" is gone. If it was reworded, reword it HERE too rather than deleting the guard.`);
	}
	// Uniqueness, or the slice below could be reading a comment, a dead branch or an obsolete
	// copy while the live string says something else entirely.
	expect(shell.indexOf(c.opens)).toBe(shell.lastIndexOf(c.opens));
	const end = shell.indexOf(c.closes, start);
	if (end === -1) {
		throw new Error(`The ${c.name} starts but never reaches "${c.closes}" — it was truncated or split, and this guard would have checked only part of it.`);
	}
	return shell.slice(start, end + c.closes.length);
}

describe("every string that names who can read the record names the same party", () => {
	test("all three are present and whole", () => {
		expect(CLAIMS.length).toBe(3);
		for (const c of CLAIMS) expect(claim(c).length).toBeGreaterThan(60);
	});

	for (const c of CLAIMS) {
		test(`the ${c.name} names the creator`, () => {
			// Case-insensitive: the panel opens its second sentence with the phrase, so it is
			// capitalised there and mid-sentence in the other two. Same party either way.
			expect(claim(c).toLowerCase()).toContain("whoever created the document");
		});
	}

	test("none of them names a sender the reader may not have", () => {
		for (const c of CLAIMS) {
			const text = claim(c).toLowerCase();
			expect(text).not.toContain("person who shared the link");
			expect(text).not.toContain("sent you this link");
		}
	});

	test("and no FOURTH string reintroduces the phrasing elsewhere in the shell", () => {
		// The per-claim checks above cannot see a notice that does not exist yet. This can.
		// One occurrence is expected and correct: the revoked-key screen tells the reader that
		// "the person who shared it can send you a new one", which is advice about replacing a
		// key, not a claim about who can read the record.
		const hits = [...shellCode.matchAll(/person who shared/gi)];
		expect(hits.length).toBe(1);
		const context = shellCode.slice(hits[0]!.index, hits[0]!.index + 120);
		expect(context).toContain("send you a new one");
	});
});

describe("the claims a consent notice has to keep making", () => {
	test("the write notice says edits are recorded, under a name, and that others can edit", () => {
		const write = claim(CLAIMS[0]!);
		expect(write).toContain("recorded under the name");
		expect(write).toContain("Anyone with this link");
	});

	test("the name is rendered as its own element, never spliced into the sentence", () => {
		// The defect this prevents: the label is chosen by the tenant-key holder — the party the
		// notice says can read the reader's edits — and was interpolated straight into the prose
		// inside quotes. A label of `Alice”. Your edits are private. “` then reads, in trusted
		// chrome, as a promise the system does not make. Keeping it in its own element keeps
		// anything smuggled in visibly inside the name.
		const write = claim(CLAIMS[0]!);
		expect(write).not.toContain("${label}");
		expect(write).toContain('el("span", "actor", label)');
	});

	test("the read-only notice is honest that opening is still noted", () => {
		const read = claim(CLAIMS[1]!);
		expect(read).toContain("Nothing you type is kept");
		expect(read).toContain("noted");
	});
});

describe("the server strips what the notice cannot defend against", () => {
	test("bidi overrides and zero-width characters never reach a rendered string", async () => {
		const quota = await Bun.file(new URL("../src/quota.ts", import.meta.url)).text();
		// A right-to-left override inside the name reverses the sentence around it, which no
		// amount of element separation in the shell can undo.
		expect(quota).toContain("INVISIBLE");
		for (const codepoint of ["202a-\\u202e", "200b-\\u200f", "2066-\\u2069", "ufeff"]) {
			expect(quota).toContain(codepoint);
		}
		// Stripped before the length check, so the budget is spent on characters that survive.
		const strip = quota.indexOf("raw.replace(INVISIBLE");
		const measure = quota.indexOf("[...text].length");
		expect(strip).toBeGreaterThan(-1);
		expect(measure).toBeGreaterThan(strip);
	});
});
