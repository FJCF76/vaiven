import { expect, test, describe } from "bun:test";
import { Writer, threeWayMerge, type PutOutcome, type WriterDeps, type WriterStatus } from "../src/writer.ts";

/** A controllable clock and timer queue, so the pipeline can be driven deterministically
 *  rather than waited on. */
function harness(putImpl?: (input: any) => Promise<PutOutcome>) {
	let clock = 0;
	const timers: Array<{ at: number; fn: () => void; id: number }> = [];
	let nextTimer = 1;

	const puts: any[] = [];
	const statuses: WriterStatus[] = [];
	const adopted: Array<{ state: unknown; version: number }> = [];

	const deps: WriterDeps = {
		now: () => clock,
		setTimer: (fn, ms) => {
			const id = nextTimer++;
			timers.push({ at: clock + ms, fn, id });
			return id;
		},
		clearTimer: (handle) => {
			const index = timers.findIndex((t) => t.id === handle);
			if (index >= 0) timers.splice(index, 1);
		},
		put: async (input) => {
			puts.push(input);
			return putImpl ? putImpl(input) : { ok: true, version: input.ifMatch + 1 };
		},
		onStatus: (status) => statuses.push(status),
		merge: threeWayMerge,
		onAdopt: (state, version) => adopted.push({ state, version }),
		randomId: () => `req-${puts.length}`,
	};

	/** Drain the microtask queue thoroughly: one settled promise can chain several awaits
	 *  deep inside the pipeline, and a stingy drain makes the harness look like a bug in
	 *  the code under test. */
	const drain = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};

	const advance = async (ms: number) => {
		clock += ms;
		const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at);
		for (const timer of due) {
			const index = timers.indexOf(timer);
			if (index >= 0) timers.splice(index, 1);
			timer.fn();
			await drain();
		}
		await drain();
	};

	return { deps, puts, statuses, adopted, advance, clock: () => clock };
}

describe("version pinning — the silent lost update", () => {
	// The pipeline polls every 3 s. If the poll refreshed the version used for If-Match,
	// a PUT would carry the LATEST version with state derived from an OLDER one, the CAS
	// would succeed, and the other writer's change would vanish with no conflict raised.
	test("a poll during pending edits does not become the If-Match version", async () => {
		const h = harness();
		const writer = new Writer(h.deps);
		writer.adopt({ fee: "18400" }, 4);

		writer.localChange({ fee: "900" });
		// Claude writes while the human is mid-edit.
		writer.observeServer(5, { fee: "18400", note: "from claude" });

		await h.advance(500);

		expect(h.puts.length).toBe(1);
		// It must NOT be 5: the pending state was derived from 4, and the merge re-bases
		// onto what the server actually has.
		expect(h.puts[0].ifMatch).toBe(5);
		// ...and the merge kept our field while taking theirs.
		expect(h.puts[0].state).toEqual({ fee: "900", note: "from claude" });
	});

	test("a poll with nothing pending simply adopts", async () => {
		const h = harness();
		const writer = new Writer(h.deps);
		writer.adopt({ a: "1" }, 1);
		writer.observeServer(2, { a: "2" });
		expect(h.adopted.at(-1)).toEqual({ state: { a: "2" }, version: 2 });
		expect(h.puts.length).toBe(0);
	});
});

describe("debounce", () => {
	test("a burst of edits produces one write", async () => {
		const h = harness();
		const writer = new Writer(h.deps);
		writer.adopt({}, 0);

		for (const value of ["1", "12", "120", "1200"]) {
			writer.localChange({ fee: value });
			await h.advance(50);
		}
		await h.advance(500);

		expect(h.puts.length).toBe(1);
		expect(h.puts[0].state).toEqual({ fee: "1200" });
	});

	// Without a ceiling, continuous typing restarts the trailing timer forever and
	// nothing is written at all.
	test("continuous typing still writes, via maxWait", async () => {
		const h = harness();
		const writer = new Writer(h.deps);
		writer.adopt({}, 0);

		for (let i = 0; i < 40; i++) {
			writer.localChange({ n: String(i) });
			await h.advance(100); // faster than the 400ms debounce, forever
		}

		expect(h.puts.length).toBeGreaterThan(0);
	});

	test("an explicit flush does not wait", async () => {
		const h = harness();
		const writer = new Writer(h.deps);
		writer.adopt({}, 0);
		writer.localChange({ a: "1" });
		writer.flush("unload");
		await h.advance(0);
		expect(h.puts.length).toBe(1);
	});
});

describe("single flight", () => {
	test("edits during a write are folded into the next one, not raced", async () => {
		let release: (v: PutOutcome) => void;
		const gate = new Promise<PutOutcome>((resolve) => { release = resolve; });
		let call = 0;

		const h = harness(async (input) => {
			call++;
			if (call === 1) return gate;
			return { ok: true, version: input.ifMatch + 1 };
		});

		const writer = new Writer(h.deps);
		writer.adopt({}, 0);
		writer.localChange({ a: "1" });
		await h.advance(500);
		expect(h.puts.length).toBe(1);

		writer.localChange({ a: "2" });
		await h.advance(500);
		// Still one: the second is waiting, not racing with a stale version.
		expect(h.puts.length).toBe(1);

		release!({ ok: true, version: 1 });
		await h.advance(10);
		await h.advance(10);

		expect(h.puts.length).toBe(2);
		expect(h.puts[1].ifMatch).toBe(1);
		expect(h.puts[1].state).toEqual({ a: "2" });
	});
});

describe("conflict", () => {
	test("a 409 merges rather than discarding what was typed", async () => {
		let first = true;
		const h = harness(async (input) => {
			if (first) {
				first = false;
				return { ok: false, conflict: { version: 9, state: { fee: "18400", deadline: "changed by them" } } };
			}
			return { ok: true, version: input.ifMatch + 1 };
		});

		const writer = new Writer(h.deps);
		writer.adopt({ fee: "18400", deadline: "14 Nov" }, 8);
		writer.localChange({ fee: "900", deadline: "14 Nov" });
		await h.advance(500);
		await h.advance(10);

		expect(h.puts.length).toBe(2);
		// Our field survived; theirs was taken where we had not touched it.
		expect(h.puts[1].state).toEqual({ fee: "900", deadline: "changed by them" });
		expect(h.puts[1].ifMatch).toBe(9);
	});
});

describe("failure handling", () => {
	test("a transient failure retries with backoff and keeps the edit", async () => {
		let calls = 0;
		const h = harness(async (input) => {
			calls++;
			if (calls < 3) return { ok: false, error: { code: "upstream", message: "boom", fatal: false } };
			return { ok: true, version: input.ifMatch + 1 };
		});

		const writer = new Writer(h.deps);
		writer.adopt({}, 0);
		writer.localChange({ a: "1" });
		await h.advance(500);
		await h.advance(600);
		await h.advance(1600);

		expect(calls).toBe(3);
		expect(h.statuses.some((s) => s.kind === "retrying")).toBe(true);
		expect(h.statuses.at(-1)!.kind).toBe("clean");
	});

	test("a fatal failure stops and says so", async () => {
		const h = harness(async () => ({
			ok: false,
			error: { code: "revoked", message: "This link is no longer active.", fatal: true },
		}));

		const writer = new Writer(h.deps);
		writer.adopt({}, 0);
		writer.localChange({ a: "1" });
		await h.advance(500);

		const last = h.statuses.at(-1)!;
		expect(last.kind).toBe("blocked");
		expect(writer.snapshot().stopped).toBe(true);
	});

	// Vaiven.render(s => { if (!s.items) Vaiven.mutate(...) }) is the natural thing to
	// write and produces a write every debounce interval, forever.
	test("a write loop trips the circuit breaker", async () => {
		const h = harness();
		const writer = new Writer(h.deps);
		writer.adopt({}, 0);

		for (let i = 0; i < 40; i++) {
			writer.localChange({ n: i });
			await h.advance(450);
		}

		expect(writer.snapshot().stopped).toBe(true);
		expect(h.statuses.some((s) => s.kind === "blocked")).toBe(true);
	});

	test("a read-only writer never sends", async () => {
		const h = harness();
		const writer = new Writer(h.deps);
		writer.adopt({}, 0);
		writer.setReadonly(true);
		writer.localChange({ a: "1" });
		await h.advance(2000);
		expect(h.puts.length).toBe(0);
	});
});

describe("threeWayMerge", () => {
	test("ours wins where we changed it, theirs everywhere else", () => {
		const merged = threeWayMerge({ a: "1", b: "1" }, { a: "2", b: "1" }, { a: "1", b: "9", c: "new" });
		expect(merged).toEqual({ a: "2", b: "9", c: "new" });
	});

	test("an untouched field takes their value", () => {
		expect(threeWayMerge({ a: "1" }, { a: "1" }, { a: "2" })).toEqual({ a: "2" });
	});
});

describe("threeWayMerge, nested", () => {
	test("keeps their sibling field when we edit a different one in the same object", () => {
		const base = { contact: { email: "a@x", phone: "111" }, other: 1 };
		const ours = { contact: { email: "b@x", phone: "111" }, other: 1 };
		const theirs = { contact: { email: "a@x", phone: "222" }, other: 1 };
		expect(threeWayMerge(base, ours, theirs)).toEqual({
			contact: { email: "b@x", phone: "222" },
			other: 1,
		});
	});

	test("recurses more than one level", () => {
		const base = { a: { b: { c: 1, d: 1 } } };
		const ours = { a: { b: { c: 2, d: 1 } } };
		const theirs = { a: { b: { c: 1, d: 3 } } };
		expect(threeWayMerge(base, ours, theirs)).toEqual({ a: { b: { c: 2, d: 3 } } });
	});

	test("our value still wins on the same nested field", () => {
		const base = { a: { b: 1 } };
		const ours = { a: { b: 2 } };
		const theirs = { a: { b: 3 } };
		expect(threeWayMerge(base, ours, theirs)).toEqual({ a: { b: 2 } });
	});

	test("a nested object replaced by a scalar is taken whole", () => {
		expect(threeWayMerge({ a: { b: 1 } }, { a: "gone" }, { a: { b: 2 } })).toEqual({ a: "gone" });
	});

	test("their new nested key survives when we did not touch that object", () => {
		const base = { a: { b: 1 } };
		const ours = { a: { b: 1 }, c: 9 };
		const theirs = { a: { b: 1, extra: true } };
		expect(threeWayMerge(base, ours, theirs)).toEqual({ a: { b: 1, extra: true }, c: 9 });
	});
})
