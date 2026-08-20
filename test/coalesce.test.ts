// Read-time event coalescing.
//
// The defect, from a real 2026-08-19 session: typing one word with corrections stored seven
// events. `cliente` went `Clienet ` -> `Clienet` -> `Cliene` -> `Clien` -> `Clienter` ->
// `Cliente` -> `Cliente1`. Six of those seven carry nothing a reader wants, and they work
// against `next_since`, which exists to stop histories crowding out an agent's context.
//
// Nobody reported it for two releases because an agent reading its own diffs never types
// with backspaces. Only a human does, and the human has no channel to report it.
//
// Every test below states the input that makes it fail without the change. This project has
// shipped two guards that could not see what they claimed to cover; a test whose failing
// input is not written down is a test nobody can check.

import { describe, expect, test } from "bun:test";
import { SESSION_GAP_MS, coalesceForRead, type EventRow } from "../src/events.ts";

const T0 = 1_700_000_000_000;

/** A stored row. Seven displayed VALUES are not seven transitions — each event needs its own
 *  `from`/`to` pair, id and timestamp — so the fixture below is built from real rows. */
function row(over: Partial<EventRow> & { id: number }): EventRow {
	return {
		version: over.id,
		actor: "Marta",
		kind: "edit",
		field: "cliente",
		from_value: null,
		to_value: null,
		op: null,
		item: null,
		note: null,
		payload: null,
		ts: T0 + over.id * 1000,
		...over,
	};
}

/** The seven events exactly as they were stored, as a chain of transitions. */
const CLIENTE: EventRow[] = [
	["", "Clienet "],
	["Clienet ", "Clienet"],
	["Clienet", "Cliene"],
	["Cliene", "Clien"],
	["Clien", "Clienter"],
	["Clienter", "Cliente"],
	["Cliente", "Cliente1"],
].map(([from, to], i) => row({ id: i + 1, from_value: from!, to_value: to! }));

describe("the sequence that started this", () => {
	test("seven stored events read back as one", () => {
		const out = coalesceForRead(CLIENTE);
		expect(out.length).toBe(1);
		expect(out[0]!.from_value).toBe("");
		expect(out[0]!.to_value).toBe("Cliente1");
	});

	test("every property of the merge is pinned, not just the count", () => {
		const [merged] = coalesceForRead(CLIENTE);
		expect(merged!.id).toBe(7); // the LAST row's id, so it is a real row id
		expect(merged!.version).toBe(7);
		expect(merged!.ts).toBe(T0 + 7000); // when it settled
		expect(merged!.from_value).toBe(""); // the FIRST row's from
		expect(merged!.stored_events).toBe(7);
	});

	test("the input is not mutated", () => {
		const frozen = CLIENTE.map((r) => Object.freeze({ ...r }));
		expect(() => coalesceForRead(frozen)).not.toThrow();
		expect(frozen[6]!.from_value).toBe("Cliente");
	});
});

describe("the session boundary", () => {
	test("a gap longer than the session splits the run in two", () => {
		// The rows are already a second apart, so the shift is measured from the row BEFORE
		// the split, not from the base. Getting this wrong makes the test pass for the wrong
		// reason, which is how the first draft of it read.
		const late = CLIENTE.map((r, i) => (i >= 4 ? { ...r, ts: r.ts + SESSION_GAP_MS } : r));
		const gap = late[4]!.ts - late[3]!.ts;
		expect(gap).toBeGreaterThan(SESSION_GAP_MS);
		const out = coalesceForRead(late);
		expect(out.length).toBe(2);
		expect(out[0]!.from_value).toBe("");
		expect(out[0]!.to_value).toBe("Clien");
		expect(out[1]!.from_value).toBe("Clien");
		expect(out[1]!.to_value).toBe("Cliente1");
	});

	test("exactly the session gap still collapses, matching the write path", () => {
		// `writes.ts` starts a new session on `now - latest.ts > SESSION_GAP_MS`, so exactly
		// ten minutes is the SAME session there. One definition of "session", both directions.
		// Built as an exact pair rather than by shifting, so the gap is the number named.
		const pair = [
			row({ id: 1, from_value: "a", to_value: "b", ts: T0 }),
			row({ id: 2, from_value: "b", to_value: "c", ts: T0 + SESSION_GAP_MS }),
		];
		expect(pair[1]!.ts - pair[0]!.ts).toBe(SESSION_GAP_MS);
		expect(coalesceForRead(pair).length).toBe(1);
	});

	test("the gap is pairwise, so a run can span far longer than one session", () => {
		// Documented because it surprised a reviewer and would surprise an agent: the limit is
		// between NEIGHBOURS. Edits nine minutes apart chain indefinitely, so one summary can
		// cover an afternoon and many versions. Pinned so the docs stay true.
		const nineMinutes = 9 * 60_000;
		const long = Array.from({ length: 9 }, (_, i) =>
			row({ id: i + 1, version: i + 1, from_value: String(i), to_value: String(i + 1), ts: T0 + i * nineMinutes }),
		);
		const out = coalesceForRead(long);
		expect(out.length).toBe(1);
		expect(out[0]!.stored_events).toBe(9);
		expect(out[0]!.ts - long[0]!.ts).toBeGreaterThan(SESSION_GAP_MS * 7);
		expect(out[0]!.version).toBe(9); // the LAST version, though the run began at 1
	});

	test("one millisecond over the gap does not collapse", () => {
		const pair = [
			row({ id: 1, from_value: "a", to_value: "b", ts: T0 }),
			row({ id: 2, from_value: "b", to_value: "c", ts: T0 + SESSION_GAP_MS + 1 }),
		];
		expect(coalesceForRead(pair).length).toBe(2);
	});

	test("time going backwards never merges", () => {
		// Rows arrive ordered by id, not by ts. A negative delta is "within" any upper bound,
		// so without an explicit floor a clock step would merge events an hour apart.
		const backwards = [row({ id: 1, from_value: "a", to_value: "b", ts: T0 + 90_000 }), row({ id: 2, from_value: "b", to_value: "c", ts: T0 })];
		expect(coalesceForRead(backwards).length).toBe(2);
	});
});

describe("what may never be merged", () => {
	// These two carry endpoints and no `note` text ON PURPOSE, so `kind` is the ONLY thing
	// preventing the merge. The first version of both used the helper's null endpoints and a
	// `note` string, which meant three separate guards each independently blocked the merge —
	// so deleting the `kind` check entirely left every assertion still passing. Found by
	// mutation, not by reading.
	test("a non-edit kind never collapses, even carrying a perfectly mergeable transition", () => {
		const annotations = [
			row({ id: 1, kind: "done", from_value: "a", to_value: "b" }),
			row({ id: 2, kind: "done", from_value: "b", to_value: "c" }),
		];
		expect(coalesceForRead(annotations).length).toBe(2);
	});

	test("every annotation kind is excluded, not just the one that got a test", () => {
		for (const kind of ["done", "note", "error", "conflict", "webhook_failed"]) {
			const pair = [
				row({ id: 1, kind, from_value: "a", to_value: "b" }),
				row({ id: 2, kind, from_value: "b", to_value: "c" }),
			];
			expect(coalesceForRead(pair).length).toBe(2);
		}
	});

	test("an annotation between two edits is a barrier on its kind alone", () => {
		const mixed = [
			row({ id: 1, from_value: "a", to_value: "b" }),
			row({ id: 2, kind: "note", from_value: "b", to_value: "b" }),
			row({ id: 3, from_value: "b", to_value: "c" }),
		];
		expect(coalesceForRead(mixed).map((r) => r.id)).toEqual([1, 2, 3]);
	});

	test("array element events never collapse — two adds are two elements", () => {
		const adds = [
			row({ id: 1, field: "deliverables", op: "add", item: "Travel time", from_value: "", to_value: "x" }),
			row({ id: 2, field: "deliverables", op: "add", item: "Extra budget", from_value: "", to_value: "y" }),
		];
		expect(coalesceForRead(adds).length).toBe(2);
	});

	test("different actors never collapse", () => {
		const two = [row({ id: 1, from_value: "a", to_value: "b" }), row({ id: 2, actor: "claude", from_value: "b", to_value: "c" })];
		expect(coalesceForRead(two).length).toBe(2);
	});

	test("different fields never collapse", () => {
		const two = [row({ id: 1, from_value: "a", to_value: "b" }), row({ id: 2, field: "fee", from_value: "b", to_value: "c" })];
		expect(coalesceForRead(two).length).toBe(2);
	});

	test("a discontinuous pair never merges, so no invented transition ships", () => {
		// Stored `a -> b` then `x -> y`. Merging would present `a -> y`: a change that never
		// happened, in the one channel this product exists to provide. Same actor and field do
		// not imply continuity — a ?force=1 write or a conflict merge can move the value.
		const gap = [row({ id: 1, from_value: "a", to_value: "b" }), row({ id: 2, from_value: "x", to_value: "y" })];
		const out = coalesceForRead(gap);
		expect(out.length).toBe(2);
		expect(out.some((r) => r.from_value === "a" && r.to_value === "y")).toBe(false);
	});

	test("an edit carrying note, payload or item is a barrier, so metadata is never dropped", () => {
		for (const extra of [{ note: "x" }, { payload: "{}" }, { item: "row" }]) {
			const rows = [
				row({ id: 1, from_value: "a", to_value: "b" }),
				row({ id: 2, from_value: "b", to_value: "c", ...extra }),
				row({ id: 3, from_value: "c", to_value: "d" }),
			];
			expect(coalesceForRead(rows).length).toBe(3);
		}
	});

	test("null endpoints never merge", () => {
		// Two absent values would compare equal and satisfy continuity while meaning nothing.
		const nulls = [row({ id: 1 }), row({ id: 2 })];
		expect(coalesceForRead(nulls).length).toBe(2);
	});

	test("an empty-string field or op is treated as it is stored, not as absent", () => {
		const empties = [
			row({ id: 1, field: "", from_value: "a", to_value: "b" }),
			row({ id: 2, field: "", from_value: "b", to_value: "c" }),
		];
		expect(coalesceForRead(empties).length).toBe(2);
	});
});

describe("a run that ends where it started", () => {
	const THERE_AND_BACK = [
		row({ id: 1, from_value: "A", to_value: "B" }),
		row({ id: 2, from_value: "B", to_value: "A" }),
	];

	test("passes through whole rather than vanishing", () => {
		// The first draft dropped it, on A1's rule against a contentless event. That made the
		// history depend on who read it: zero events for an agent reading afterwards, two for
		// the shell, which polls every few seconds. Nothing is merged here, so nothing
		// contentless is emitted, and nothing disappears either.
		const out = coalesceForRead(THERE_AND_BACK);
		expect(out.length).toBe(2);
		expect(out.map((r) => r.id)).toEqual([1, 2]);
		expect(out.every((r) => r.stored_events === undefined)).toBe(true);
	});

	test("reading it in one page and in two agrees on what happened", () => {
		const whole = coalesceForRead(THERE_AND_BACK);
		const split = [...coalesceForRead([THERE_AND_BACK[0]!]), ...coalesceForRead([THERE_AND_BACK[1]!])];
		expect(whole.map((r) => [r.from_value, r.to_value])).toEqual(split.map((r) => [r.from_value, r.to_value]));
	});

	test("and it is not a barrier to its neighbours in the wrong direction", () => {
		// Runs are found in the RAW input. If contentless runs were removed FIRST, these two
		// `fee` edits would become adjacent and merge across activity that really happened.
		const rows = [
			row({ id: 1, field: "fee", from_value: "1", to_value: "2" }),
			row({ id: 2, field: "note", from_value: "A", to_value: "B" }),
			row({ id: 3, field: "note", from_value: "B", to_value: "A" }),
			row({ id: 4, field: "fee", from_value: "2", to_value: "3" }),
		];
		const out = coalesceForRead(rows);
		expect(out.map((r) => r.id)).toEqual([1, 2, 3, 4]);
	});
});

describe("the shapes that must not change", () => {
	test("a single eligible event comes back untouched and unmarked", () => {
		const one = [row({ id: 1, from_value: "a", to_value: "b" })];
		expect(coalesceForRead(one)).toEqual(one);
		expect(coalesceForRead(one)[0]!.stored_events).toBeUndefined();
	});

	test("an empty log is an empty log", () => {
		expect(coalesceForRead([])).toEqual([]);
	});

	test("unmerged events never acquire stored_events", () => {
		const mixed = [row({ id: 1, kind: "note" }), row({ id: 2, from_value: "a", to_value: "b" })];
		expect(coalesceForRead(mixed).every((r) => r.stored_events === undefined)).toBe(true);
	});

	test("empty string is a legitimate endpoint, distinguishable from absent", () => {
		const cleared = [row({ id: 1, from_value: "text", to_value: "" }), row({ id: 2, from_value: "", to_value: "new" })];
		const out = coalesceForRead(cleared);
		expect(out.length).toBe(1);
		expect(out[0]!.from_value).toBe("text");
		expect(out[0]!.to_value).toBe("new");
	});
});
