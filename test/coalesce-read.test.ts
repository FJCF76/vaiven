// Coalescing where it is actually served: through `readEvents`, against a real database.
//
// `test/coalesce.test.ts` proves the collapse. This proves the things the collapse could
// break on the way out — the cursor above all. A8 records what a wrong cursor costs here:
// a version-based one made `POST /events` annotations permanently invisible, and made the
// page cut skip everything past it. A projection that moves the cursor brings that back.

import { expect, test, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, open } from "../src/db.ts";
import { newDocId, newTenantId } from "../src/ids.ts";
import { readEvents } from "../src/routes/api.ts";
import { SESSION_GAP_MS, coalesceForRead, type EventRow } from "../src/events.ts";
import { ApiError } from "../src/errors.ts";

const T0 = 1_700_000_000_000;
let db: Database;
let docId: string;

beforeEach(() => {
	db = open(":memory:");
	migrate(db);
	const tenantId = newTenantId();
	db.query("INSERT INTO tenants (id, name, key_hash, disabled, created_at) VALUES (?, ?, ?, ?, ?)").run(tenantId, "T", "h", 0, T0);
	docId = newDocId();
	db.query("INSERT INTO docs (id, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(docId, tenantId, T0, T0);
});

/** The seven-event `cliente` sequence, stored. */
function seedCliente(): void {
	const pairs = [
		["", "Clienet "], ["Clienet ", "Clienet"], ["Clienet", "Cliene"], ["Cliene", "Clien"],
		["Clien", "Clienter"], ["Clienter", "Cliente"], ["Cliente", "Cliente1"],
	];
	const q = db.query("INSERT INTO events (doc_id, version, actor, kind, field, from_value, to_value, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	pairs.forEach(([from, to], i) => q.run(docId, i + 1, "Marta", "edit", "cliente", from!, to!, T0 + i * 1000));
}

describe("the cursor is not moved by the projection", () => {
	test("next_since is identical coalesced and raw, and is the last STORED row's id", () => {
		seedCliente();
		const coalesced = readEvents(db, docId, 0, null, null);
		const raw = readEvents(db, docId, 0, null, "1");
		const lastStoredId = (db.query<{ id: number }, [string]>("SELECT max(id) AS id FROM events WHERE doc_id = ?").get(docId))!.id;

		expect(coalesced.events.length).toBe(1);
		expect(raw.events.length).toBe(7);
		expect(coalesced.nextSince).toBe(raw.nextSince);
		expect(coalesced.nextSince).toBe(lastStoredId);
	});

	test("echoing next_since from a coalesced read returns nothing already seen", () => {
		seedCliente();
		const first = readEvents(db, docId, 0, null, null);
		const second = readEvents(db, docId, first.nextSince, null, null);
		expect(second.events).toEqual([]);
		expect(second.nextSince).toBe(first.nextSince);
	});

	test("a run split across two reads is coherent in both, and neither repeats the other", () => {
		// The accepted edge, asserted rather than only written down: less compression, no
		// information lost and nothing duplicated.
		//
		// The first version of this test called `readEvents` twice with IDENTICAL arguments,
		// called the second one "partial" in a comment, and never read the first half at all.
		// It also wrote `.from_value ?? .from`, where `from_value` does not exist on a mapped
		// event, so the `??` hid the wrong property name. It passed and proved nothing.
		seedCliente();
		const whole = readEvents(db, docId, 0, null, null).events[0] as any;

		// The same stored rows, cut where a poll boundary would cut them. Projected through
		// the real function rather than a re-staged database, so the thing under test is the
		// thing that runs.
		const stored = readEvents(db, docId, 0, null, "1").events as any[];
		const toRow = (e: any): EventRow => ({
			id: e.id, version: e.version, actor: e.actor, kind: e.kind, field: e.field ?? null,
			from_value: e.from ?? null, to_value: e.to ?? null, op: e.op ?? null, item: e.item ?? null,
			note: e.note ?? null, payload: e.payload ?? null, ts: Date.parse(e.at),
		});
		const head = coalesceForRead(stored.slice(0, 4).map(toRow));
		const tail = coalesceForRead(stored.slice(4).map(toRow));

		// Each half is internally coherent, they join end to end with no gap and no overlap,
		// and together they cover exactly what the single read covered.
		expect(head.length).toBe(1);
		expect(tail.length).toBe(1);
		expect(head[0]!.to_value).toBe(tail[0]!.from_value);
		expect(head[0]!.from_value).toBe(whole.from);
		expect(tail[0]!.to_value).toBe(whole.to);
		expect(head[0]!.id).not.toBe(tail[0]!.id);

		// Two events where one read gives one. That is the whole of the accepted edge.
		expect(head.length + tail.length).toBe(2);
	});
});

describe("what the response says about itself", () => {
	test("the coalesced view names raw=1, the cursor rule, and where `from` came from", () => {
		seedCliente();
		const { view } = readEvents(db, docId, 0, null, null);
		expect(view.mode).toBe("coalesced");
		expect(view.raw).toBe("raw=1");
		expect(view.note).toContain("raw=1");
		expect(view.note).toContain("next_since");
		expect(view.note).toContain("stored_events");
		// The trap: `next_since` points PAST the rows a summary stands for.
		expect(view.note.toLowerCase()).toContain("same `since`");
	});

	test("a raw read says so, so an agent can confirm its request took effect", () => {
		seedCliente();
		expect(readEvents(db, docId, 0, null, "1").view.mode).toBe("raw");
	});

	test("the merged event carries stored_events into the JSON, and singles do not", () => {
		seedCliente();
		const { events } = readEvents(db, docId, 0, null, null);
		expect((events[0] as any).stored_events).toBe(7);
		expect((readEvents(db, docId, 0, null, "1").events[0] as any).stored_events).toBeUndefined();
	});

	test("`from` is the first value and `id`/`at` are the last, as the note promises", () => {
		seedCliente();
		const merged = readEvents(db, docId, 0, null, null).events[0] as any;
		// An empty string IS the first value here, and it survives: the mapper tests
		// `from_value !== null`, not truthiness, so a cleared field is distinguishable from
		// an absent one. Asserted because a truthiness check there would silently drop it.
		expect(merged.from).toBe("");
		expect(merged.to).toBe("Cliente1");
		expect(merged.id).toBe(7);
		expect(merged.at).toBe(new Date(T0 + 6000).toISOString());
	});
});

describe("raw accepts one spelling", () => {
	test("raw=banana is a 400 naming the field, never a silent projection", () => {
		seedCliente();
		try {
			readEvents(db, docId, 0, null, "banana");
			throw new Error("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).code).toBe("invalid");
			expect((error as ApiError).detail.field).toBe("raw");
		}
	});

	test("validation runs before precedence, so events=0 cannot mask a typo", () => {
		seedCliente();
		expect(() => readEvents(db, docId, 0, "0", "banana")).toThrow(ApiError);
	});

	test("events=0 beats raw=1 — no events is a narrower request than unprojected events", () => {
		seedCliente();
		const { events, view } = readEvents(db, docId, 0, "0", "1");
		expect(events).toEqual([]);
		expect(view.mode).toBe("raw");
	});
});

describe("annotations survive the projection, which is why the cursor is an event id", () => {
	test("a note stored at an unchanged version is still returned and still reachable", () => {
		seedCliente();
		db.query("INSERT INTO events (doc_id, version, actor, kind, note, ts) VALUES (?, ?, ?, ?, ?, ?)")
			.run(docId, 7, "Marta", "note", "done for today", T0 + 7000);
		const { events, nextSince } = readEvents(db, docId, 0, null, null);
		expect(events.length).toBe(2);
		expect((events[1] as any).kind).toBe("note");
		expect(nextSince).toBe(8);
	});
});

describe("the newest-N branch", () => {
	test("takes 50 STORED rows and presents fewer, rather than hunting for 50 to present", () => {
		const q = db.query("INSERT INTO events (doc_id, version, actor, kind, field, from_value, to_value, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
		for (let i = 0; i < 60; i++) q.run(docId, i + 1, "Marta", "edit", "fee", String(i), String(i + 1), T0 + i * 1000);
		const { events, nextSince } = readEvents(db, docId, -1, null, null);
		expect(events.length).toBe(1); // one continuous run inside the window
		expect((events[0] as any).stored_events).toBe(50);
		expect(nextSince).toBe(60);
	});
});

describe("the index the cursor query needs exists", () => {
	test("events_cursor is created by migrate, and the planner uses it", () => {
		const names = (db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'").all() as any[]).map((r) => r.name);
		expect(names).toContain("events_cursor");
		// Asserted against a POPULATED table on purpose: an empty one plans differently and
		// reports a temp B-tree that never happens in practice. That artifact sent a first
		// reading of this problem in the wrong direction.
		const q = db.query("INSERT INTO events (doc_id, version, actor, kind, field, from_value, to_value, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
		for (let i = 0; i < 500; i++) q.run(docId, i + 1, "Marta", "edit", "fee", String(i), String(i + 1), T0 + i * 1000);
		db.exec("ANALYZE");
		const plan = (db.query("EXPLAIN QUERY PLAN SELECT id FROM events WHERE doc_id = ? AND id > ? ORDER BY id LIMIT 500").all(docId, 0) as any[])
			.map((r) => r.detail)
			.join(" ");
		expect(plan).toContain("events_cursor");
	});
});

describe("the session constant has one definition", () => {
	test("it is exported from events.ts and is A2's ten minutes", () => {
		expect(SESSION_GAP_MS).toBe(10 * 60_000);
	});
});
