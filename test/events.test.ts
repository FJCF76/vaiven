import { expect, test, describe } from "bun:test";
import { deriveEvents, stampVids, reconcileVids, safeParse, clamp, validateAnnotations, VID } from "../src/events.ts";

const stamp = (value: unknown) => stampVids(value) as any;

describe("scalar diffs — what E2 proved is worth having", () => {
	test("a changed field carries both values", () => {
		const events = deriveEvents({ budget: "6000" }, { budget: "900" });
		expect(events).toEqual([{ kind: "edit", field: "budget", from: "6000", to: "900" }]);
	});

	test("an unchanged field produces nothing", () => {
		expect(deriveEvents({ a: "1", b: "2" }, { a: "1", b: "2" })).toEqual([]);
	});

	test("booleans read as words, not as JSON noise", () => {
		const events = deriveEvents({ urgent: false }, { urgent: true });
		expect(events[0]).toMatchObject({ field: "urgent", from: "false", to: "true" });
	});

	test("a new field reads as an addition rather than a change from nothing", () => {
		const events = deriveEvents({}, { notes: "Joinery slipped" });
		expect(events[0]).toMatchObject({ field: "notes", from: "", to: "Joinery slipped" });
	});

	test("nested objects are pathed", () => {
		const events = deriveEvents({ a: { b: "1" } }, { a: { b: "2" } });
		expect(events[0]).toMatchObject({ field: "a.b", from: "1", to: "2" });
	});
});

describe("arrays — the E2 regression", () => {
	// E2 produced five events reading {field:"deliverables", from:"", to:"line edited"}
	// out of ten. The log could not say that "Travel time" went 4 -> 5, which is the
	// single fact a reader would have wanted.
	test("editing a row names the row and the column", () => {
		const before = stamp({ deliverables: [{ name: "Travel time", days: "4" }] });
		const after = structuredClone(before);
		after.deliverables[0].days = "5";

		const events = deriveEvents(before, after);
		expect(events).toEqual([
			{ kind: "edit", field: "deliverables[Travel time].days", from: "4", to: "5" },
		]);
	});

	test("no event says only that something changed", () => {
		const before = stamp({ rows: [{ name: "A", n: "1" }] });
		const after = structuredClone(before);
		after.rows[0].n = "2";
		for (const event of deriveEvents(before, after)) {
			expect(event.to).not.toBe("line edited");
			// Either it names a from/to pair, or it names an add/remove. Never neither.
			const informative = (event.from !== undefined && event.to !== undefined) || event.op !== undefined;
			expect(informative).toBe(true);
		}
	});

	test("adding a row names it", () => {
		const before = stamp({ items: [{ name: "One" }] });
		const after = stamp({ items: [...before.items, { name: "Extra budget" }] });
		const events = deriveEvents(before, after);
		expect(events).toEqual([{ kind: "edit", field: "items", op: "add", item: "Extra budget" }]);
	});

	test("removing a row names it", () => {
		const before = stamp({ items: [{ name: "Keep" }, { name: "Lighting schedule" }] });
		const after = { items: [before.items[0]] };
		const events = deriveEvents(before, after);
		expect(events).toEqual([{ kind: "edit", field: "items", op: "remove", item: "Lighting schedule" }]);
	});

	// Index-keyed diffing reports every subsequent row as changed after an insert at the
	// head. Identity-keyed diffing reports one addition.
	test("inserting at the head is one event, not N", () => {
		const before = stamp({ items: [{ name: "A" }, { name: "B" }, { name: "C" }] });
		const after = { items: [{ name: "New", [VID]: "vnew" }, ...before.items] };
		const events = deriveEvents(before, after);
		expect(events).toEqual([{ kind: "edit", field: "items", op: "add", item: "New" }]);
	});

	test("reordering with no content change says nothing", () => {
		const before = stamp({ items: [{ name: "A" }, { name: "B" }] });
		const after = { items: [before.items[1], before.items[0]] };
		expect(deriveEvents(before, after)).toEqual([]);
	});

	test("a large rewrite collapses to a summary", () => {
		const before = stamp({ items: Array.from({ length: 12 }, (_, i) => ({ name: `row ${i}` })) });
		const after = stamp({ items: Array.from({ length: 30 }, (_, i) => ({ name: `new ${i}` })) });
		const events = deriveEvents(before, after);
		expect(events.length).toBe(1);
		expect(events[0]).toMatchObject({ field: "items", from: "12 items", to: "30 items" });
		expect(events[0]!.item).toContain("rows changed");
	});

	test("identity survives renaming the label field", () => {
		const before = stamp({ items: [{ name: "", cost: "0" }] });
		const after = structuredClone(before);
		after.items[0].name = "Extra budget";
		after.items[0].cost = "5000";

		const events = deriveEvents(before, after);
		// One element, two columns changed — not a remove plus an add.
		expect(events.every((e) => e.op === undefined)).toBe(true);
		expect(events.length).toBe(2);
	});
});

describe("containment", () => {
	test("long values are clamped", () => {
		const long = "x".repeat(5000);
		const events = deriveEvents({ a: "" }, { a: long });
		expect(events[0]!.to!.length).toBeLessThanOrEqual(200);
		expect(events[0]!.to!.endsWith("…")).toBe(true);
	});

	test("clamp leaves short values untouched", () => {
		expect(clamp("short")).toBe("short");
	});

	test("only annotation kinds are accepted from a client", () => {
		const accepted = validateAnnotations([
			{ kind: "done", note: "changed the price" },
			{ kind: "edit", field: "budget", from: "1", to: "2" }, // must be rejected
			{ kind: "error", note: "boom" },
			{ kind: "arbitrary" },
		]);
		expect(accepted.map((a) => a.kind)).toEqual(["done", "error"]);
	});

	test("prototype-shaped keys do not survive parsing", () => {
		const parsed = safeParse('{"__proto__":{"polluted":true},"ok":1}') as any;
		expect(parsed.ok).toBe(1);
		expect(({} as any).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(parsed)).toBeNull();
	});
});

describe("identity stamping", () => {
	test("every array element gets an id, once", () => {
		const stamped = stamp({ items: [{ a: 1 }, { b: 2 }] });
		const ids = stamped.items.map((i: any) => i[VID]);
		expect(ids.every((id: string) => typeof id === "string")).toBe(true);
		expect(new Set(ids).size).toBe(2);

		// Re-stamping must not reassign — identity is the whole point.
		const again = stamp(stamped);
		expect(again.items.map((i: any) => i[VID])).toEqual(ids);
	});

	test("scalars and scalar arrays are left alone", () => {
		expect(stamp({ tags: ["a", "b"], n: 1 })).toEqual({ tags: ["a", "b"], n: 1 });
	});
});

describe("identity reconciliation — the bug end-to-end testing caught", () => {
	// An API client does not know about _vid and does not echo it. Minting ids on the
	// incoming state alone made every element match nothing, so a one-column edit came
	// back as "add Survey, remove Survey". Unit tests missed it by pre-stamping both sides.
	test("an unstamped client edit reads as an edit, not a churn of add and remove", () => {
		const stored = stampVids({ rows: [{ name: "Survey", days: "4" }] });
		const fromClient = { rows: [{ name: "Survey", days: "5" }] };

		const next = reconcileVids(stored, fromClient);
		const events = deriveEvents(stored, next);

		expect(events).toEqual([
			{ kind: "edit", field: "rows[Survey].days", from: "4", to: "5" },
		]);
	});

	test("an unstamped append is one addition", () => {
		const stored = stampVids({ rows: [{ name: "Survey", days: "4" }] });
		const fromClient = { rows: [{ name: "Survey", days: "4" }, { name: "Extra budget", days: "5000" }] };

		const events = deriveEvents(stored, reconcileVids(stored, fromClient));
		expect(events).toEqual([{ kind: "edit", field: "rows", op: "add", item: "Extra budget" }]);
	});

	test("inherited ids are stable across successive writes", () => {
		const v1 = stampVids({ rows: [{ name: "A" }] }) as any;
		const v2 = reconcileVids(v1, { rows: [{ name: "A" }] }) as any;
		expect(v2.rows[0][VID]).toBe(v1.rows[0][VID]);
	});

	test("an echoed vid survives reordering, unlike position", () => {
		const v1 = stampVids({ rows: [{ name: "A" }, { name: "B" }] }) as any;
		const reordered = { rows: [v1.rows[1], v1.rows[0]] };
		expect(deriveEvents(v1, reconcileVids(v1, reordered))).toEqual([]);
	});
});
