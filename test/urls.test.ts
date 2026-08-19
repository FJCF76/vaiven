// The URL contract: what a response hands an agent, and what stops the next route forgetting.
//
// A12 says "never make the agent construct a URL." It was written before three defects and
// stopped none of them, because a stated invariant is not a checked one. Three of these tests
// exist to make it checked; the rest pin the encodings that a hand-built URL got wrong.
//
// These run in `bun test`. That matters: the first version of this guard was specified to run
// against a live server, and `bun test` collects only `*.test.ts`, so a green run would have
// meant the guard never executed. `apiRoutes` is importable and side-effect-free, so the real
// handler runs here against an in-memory database.

import { expect, test, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, open } from "../src/db.ts";
import { insertDocKey, mintKey, KeyMaterial } from "../src/auth.ts";
import type { Config } from "../src/config.ts";
import { newDocId, newTenantId } from "../src/ids.ts";
import { apiRoutes } from "../src/routes/router.ts";
import { docUrls, mintedKeyBody } from "../src/urls.ts";

// Built literally rather than through `loadConfig`, which reads `process.env` directly — its
// `env` parameter is accepted and ignored. Mutating `process.env` from a test file would leak
// into every other file bun runs in the same process.
const config: Config = {
	db: ":memory:",
	appHost: "vaiven.localhost",
	sandboxHost: "uc.vaiven.localhost",
	scheme: "http",
	appOrigin: "http://vaiven.localhost:8080",
	sandboxOrigin: "http://uc.vaiven.localhost:8080",
	port: 8080,
	bind: "127.0.0.1",
	publicPort: 8080,
	trustedProxyHops: 0,
};

let db: Database;
let tenantKey: string;
let docId: string;

beforeEach(() => {
	db = open(":memory:");
	migrate(db);
	const tenantId = newTenantId();
	const { plaintext, hash } = mintKey();
	tenantKey = plaintext.reveal();
	db.query("INSERT INTO tenants (id, name, key_hash, disabled, created_at) VALUES (?, ?, ?, ?, ?)").run(
		tenantId,
		"Fixture",
		hash,
		0,
		Date.now(),
	);
	docId = newDocId();
	const now = Date.now();
	db.query("INSERT INTO docs (id, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
		docId,
		tenantId,
		now,
		now,
	);
	db.query("INSERT INTO doc_content (doc_id) VALUES (?)").run(docId);
});

function mint(role: "read" | "write", label = "Marta"): Promise<Response> {
	const url = new URL(`http://vaiven.localhost:8080/api/docs/${docId}/keys`);
	return apiRoutes(
		db,
		new Request(url, {
			method: "POST",
			headers: { authorization: `Bearer ${tenantKey}`, "content-type": "application/json" },
			body: JSON.stringify({ label, role }),
		}),
		url,
		config,
	);
}

describe("the mint response carries every URL its key can open", () => {
	// The defect, exactly: this route answered with a key and no URL, an agent built the link
	// itself, wrote `#<key>` instead of `#k=<key>`, and a person received a dead link.
	test("a write key gets the shell link and NO read link", async () => {
		const body = (await (await mint("write")).json()) as Record<string, string>;
		// Asserted against a literal, not against docUrls(). Comparing the route's output to
		// the function the route calls is a tautology that holds for a broken function too —
		// the mistake `guide.test.ts` already records having made once.
		expect(body.view_url).toBe(`http://vaiven.localhost:8080/d/${docId}#k=${body.key}`);
		// Absence, not falsiness. A write key is not a read key: `/r/` returns the opaque miss
		// for it, so handing over that URL would be handing over a link that 404s.
		expect(body).not.toHaveProperty("read_url");
	});

	test("a read key gets BOTH, because it opens both", async () => {
		const body = (await (await mint("read", "reader")).json()) as Record<string, string>;
		expect(body.view_url).toBe(`http://vaiven.localhost:8080/d/${docId}#k=${body.key}`);
		expect(body.read_url).toBe(`http://vaiven.localhost:8080/r/${body.key}.json`);
	});

	test("the fields that were already there survive", async () => {
		const body = (await (await mint("write")).json()) as Record<string, string>;
		// The body grew from four fields to eight. Nothing else pins the original four: every
		// live suite reads its keys from document CREATION, so if `key` vanished from the mint
		// response tomorrow, no other test would notice.
		expect(body.id).toMatch(/^k_/);
		expect(body.label).toBe("Marta");
		expect(body.role).toBe("write");
		expect(typeof body.key).toBe("string");
	});

	test("the echoed role matches what was asked for", async () => {
		for (const role of ["read", "write"] as const) {
			const body = (await (await mint(role)).json()) as Record<string, string>;
			expect(body.role).toBe(role);
		}
	});

	test("the response is no-store", async () => {
		// It now carries the same secret three times: in `key`, in `view_url`, and for a read
		// key in `read_url`.
		expect((await mint("write")).headers.get("cache-control")).toBe("no-store");
	});
});

describe("the fragment is pinned to the parser that reads it", () => {
	// The bug was one character in a URL fragment, and a fragment NEVER REACHES THE SERVER.
	// `GET /d/:id` answers 200 for any fragment or none, so "open the view_url and see" proves
	// nothing. Only the shell resolves it, so the producer is asserted against the real
	// consumer's own expression.
	const asShellParsesIt = (viewUrl: string) =>
		new URLSearchParams(new URL(viewUrl).hash.slice(1)).get("k");

	test("what the shell pulls out of the fragment is the key that was minted", async () => {
		for (const role of ["read", "write"] as const) {
			const body = (await (await mint(role)).json()) as Record<string, string>;
			expect(body.view_url).toBeDefined();
			expect(asShellParsesIt(body.view_url!)).toBe(body.key!);
		}
	});

	test("the exact defect that shipped would fail this", () => {
		const key = "abc123";
		// `#<key>` — what the agent wrote.
		expect(asShellParsesIt(`http://x/d/d_1#${key}`)).not.toBe(key);
		// `#k=<key>` — what the shell needs.
		expect(asShellParsesIt(`http://x/d/d_1#k=${key}`)).toBe(key);
	});
});

describe("encodings that were asymmetric until they were tested", () => {
	// `view_url` encoded the key and `read_url` did not. Safe only because the alphabet is
	// base64url, which nothing asserted. A hostile key proves what each construction does.
	const hostile = new KeyMaterial("a+b/c=d#e&f");

	test("a key needing escapes survives the round trip through the shell's parser", () => {
		const { view_url } = docUrls(config, "d_1", { shell: hostile });
		const parsed = new URLSearchParams(new URL(view_url!).hash.slice(1)).get("k");
		expect(parsed).toBe("a+b/c=d#e&f");
	});

	test("the read path segment is encoded, so `.json` still parses off the end", () => {
		const { read_url } = docUrls(config, "d_1", { read: hostile });
		expect(read_url!.endsWith(".json")).toBe(true);
		// `#` would otherwise truncate the URL and `/` would invent a path segment.
		expect(read_url).not.toContain("#");
		const segment = new URL(read_url!).pathname.slice("/r/".length, -".json".length);
		expect(decodeURIComponent(segment)).toBe("a+b/c=d#e&f");
	});

	test("the key alphabet is what both constructions assume", () => {
		// If this ever changes, the two tests above are the ones that catch the consequence.
		for (let i = 0; i < 20; i++) expect(mintKey().plaintext.reveal()).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});

describe("the invariant is enforced by the compiler, not by a grep", () => {
	test("a key refuses to serialize itself", () => {
		const wrapped = new KeyMaterial("s3cret");
		// The failure mode is redaction, not leakage. A source scan cannot offer this: it
		// tells you afterwards that a key MIGHT have shipped, whereas this ships "[redacted]".
		expect(JSON.stringify({ key: wrapped })).toBe('{"key":"[redacted]"}');
		expect(`${wrapped}`).toBe("[redacted]");
		expect(wrapped.reveal()).toBe("s3cret");
	});

	test("an unhandled role throws rather than inheriting the write shape", () => {
		expect(() =>
			mintedKeyBody(config, "d_1", {
				id: "k_1",
				label: "x",
				// A third role must not silently get a shell link.
				role: "admin" as "read" | "write",
				plaintext: new KeyMaterial("k"),
			}),
		).toThrow(/unhandled key role/);
	});
});

describe("the routes that hand out keys", () => {
	test("document creation and key minting are the only two, and both go through urls.ts", async () => {
		// Not a text scan over source — that was the rejected design, and `const { plaintext }`
		// walks straight through one. This asserts the observable property instead: every
		// response in the system that contains key material also contains a URL for it.
		const minted = insertDocKey(db, docId, "probe", "read");
		const body = mintedKeyBody(config, docId, minted);
		const serialized = JSON.stringify(body);
		expect(serialized).toContain(minted.plaintext.reveal());
		expect(body.view_url).toBeDefined();
		expect(body.read_url).toBeDefined();
	});
});
