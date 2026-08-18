import { expect, test, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, open } from "../src/db.ts";
import { can, insertDocKey, mintKey, resolve, type Scope } from "../src/auth.ts";
import { newDocId, newTenantId } from "../src/ids.ts";

let db: Database;
let tenantId: string;
let docId: string;
let otherDocId: string;
let tenantKey: string;
let writeKey: string;
let readKey: string;

function makeTenant(name: string, disabled = 0): { id: string; key: string } {
	const id = newTenantId();
	const { plaintext, hash } = mintKey();
	db.query(
		"INSERT INTO tenants (id, name, key_hash, disabled, created_at) VALUES (?, ?, ?, ?, ?)",
	).run(id, name, hash, disabled, Date.now());
	return { id, key: plaintext };
}

function makeDoc(tenant: string): string {
	const id = newDocId();
	const now = Date.now();
	db.query(
		"INSERT INTO docs (id, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
	).run(id, tenant, now, now);
	db.query("INSERT INTO doc_content (doc_id) VALUES (?)").run(id);
	return id;
}

beforeEach(() => {
	db = open(":memory:");
	migrate(db);
	const tenant = makeTenant("Fixture");
	tenantId = tenant.id;
	tenantKey = tenant.key;
	docId = makeDoc(tenantId);
	otherDocId = makeDoc(tenantId);
	writeKey = insertDocKey(db, docId, "Marta", "write").plaintext;
	readKey = insertDocKey(db, docId, "reader", "read").plaintext;
});

describe("resolver", () => {
	test("a tenant key resolves to tenant scope", () => {
		const scope = resolve(db, tenantKey);
		expect(scope?.kind).toBe("tenant");
		expect((scope as any).tenantId).toBe(tenantId);
	});

	test("a write key resolves to its document with its label as the actor", () => {
		const scope = resolve(db, writeKey) as any;
		expect(scope.kind).toBe("doc");
		expect(scope.role).toBe("write");
		expect(scope.docId).toBe(docId);
		expect(scope.actor).toBe("Marta");
	});

	test("a read key resolves read-only", () => {
		expect((resolve(db, readKey) as any).role).toBe("read");
	});

	test("an unknown key resolves to nothing", () => {
		expect(resolve(db, "not-a-key")).toBeNull();
		expect(resolve(db, "")).toBeNull();
		expect(resolve(db, null)).toBeNull();
	});

	test("a revoked key stops resolving", () => {
		db.query("UPDATE doc_keys SET revoked_at = ? WHERE role = 'write'").run(Date.now());
		expect(resolve(db, writeKey)).toBeNull();
	});

	test("a disabled tenant's own key stops resolving", () => {
		db.query("UPDATE tenants SET disabled = 1 WHERE id = ?").run(tenantId);
		expect(resolve(db, tenantKey)).toBeNull();
	});

	// A13: without the join to tenants, `vaiven tenant disable` stops the tenant key and
	// leaves every document key of that tenant working — which is the opposite of what
	// disabling a tenant means.
	test("disabling a tenant also stops its document keys", () => {
		db.query("UPDATE tenants SET disabled = 1 WHERE id = ?").run(tenantId);
		expect(resolve(db, writeKey)).toBeNull();
		expect(resolve(db, readKey)).toBeNull();
	});
});

describe("capability table", () => {
	const tenantScope = (): Scope => ({ kind: "tenant", tenantId, actor: "claude" });
	const scopeFor = (key: string) => resolve(db, key)!;

	test("the tenant may do everything", () => {
		for (const capability of [
			"doc.create", "doc.delete", "content.write", "state.write", "state.force",
			"keys.mint", "keys.revoke", "versions.restore", "webhook.set",
		] as const) {
			expect(can(tenantScope(), capability, docId)).toBe(true);
		}
	});

	test("a write key may write state and append events", () => {
		const scope = scopeFor(writeKey);
		expect(can(scope, "state.write", docId)).toBe(true);
		expect(can(scope, "events.append", docId)).toBe(true);
		expect(can(scope, "doc.read", docId)).toBe(true);
	});

	// Each of these was reachable if the table were read literally from §5 plus §6.
	test("a write key may NOT escalate", () => {
		const scope = scopeFor(writeKey);
		for (const capability of [
			"keys.mint", "keys.revoke", "keys.list", "doc.delete",
			"state.force", "content.write", "versions.restore", "webhook.set", "doc.list",
		] as const) {
			expect(can(scope, capability, docId)).toBe(false);
		}
	});

	test("a read key may only read", () => {
		const scope = scopeFor(readKey);
		expect(can(scope, "doc.read", docId)).toBe(true);
		expect(can(scope, "state.write", docId)).toBe(false);
		expect(can(scope, "events.append", docId)).toBe(false);
	});

	test("a document key cannot act on another document", () => {
		const scope = scopeFor(writeKey);
		expect(can(scope, "state.write", otherDocId)).toBe(false);
		expect(can(scope, "doc.read", otherDocId)).toBe(false);
	});
});

describe("schema integrity", () => {
	// A5: foreign_keys is per-connection and defaults OFF, which makes every cascade in
	// the schema a no-op and leaves orphaned keys that still authenticate.
	test("deleting a document cascades to its keys, events and versions", () => {
		db.query("INSERT INTO events (doc_id, version, actor, kind, ts) VALUES (?, 1, 'x', 'edit', 0)").run(docId);
		db.query(
			"INSERT INTO state_versions (doc_id, version, state, bytes, actor, ts, session) VALUES (?, 1, '{}', 2, 'x', 0, 0)",
		).run(docId);

		db.query("DELETE FROM docs WHERE id = ?").run(docId);

		expect(db.query("SELECT count(*) AS n FROM doc_keys WHERE doc_id = ?").get(docId)).toEqual({ n: 0 });
		expect(db.query("SELECT count(*) AS n FROM events WHERE doc_id = ?").get(docId)).toEqual({ n: 0 });
		expect(db.query("SELECT count(*) AS n FROM state_versions WHERE doc_id = ?").get(docId)).toEqual({ n: 0 });
		expect(db.query("SELECT count(*) AS n FROM doc_content WHERE doc_id = ?").get(docId)).toEqual({ n: 0 });
	});

	test("an orphaned key cannot authenticate after its document is deleted", () => {
		db.query("DELETE FROM docs WHERE id = ?").run(docId);
		expect(resolve(db, writeKey)).toBeNull();
	});

	test("keys are stored hashed, never in plaintext", () => {
		const rows = db.query<{ key_hash: string }, []>("SELECT key_hash FROM doc_keys").all();
		expect(rows.length).toBe(2);
		for (const row of rows) {
			expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
			expect(row.key_hash).not.toBe(writeKey);
			expect(row.key_hash).not.toBe(readKey);
		}
	});

	test("the role column rejects anything but read or write", () => {
		expect(() =>
			db.query(
				"INSERT INTO doc_keys (id, doc_id, key_hash, label, role, created_at) VALUES ('k_x', ?, 'h', 'l', 'admin', 0)",
			).run(docId),
		).toThrow();
	});
});
