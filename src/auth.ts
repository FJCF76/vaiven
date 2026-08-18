// Key minting, the resolver, and the capability table.
//
// A13 exists because §5 and §6 disagreed by omission. §5 defines a `write` document key as
// "that doc: state RW, content RO", and §6 then lists key minting, key revocation, document
// deletion and `?force=1` without saying who may call them. Read literally, a write key you
// handed to one collaborator could mint itself a permanent key, publish a public `/r/` URL
// for a document you meant to keep private, revoke your keys, delete the document, and
// overwrite the agent's state unconditionally.
//
// So capabilities are enumerated, the table is default-deny, and there is exactly one
// function that answers "may this scope do that".

import type { Database } from "bun:sqlite";
import { newKeyId } from "./ids.ts";

// ------------------------------------------------------------------------- key material

/** 32 random bytes, base64url. The plaintext exists only in the minting response. */
export function mintKey(): { plaintext: string; hash: string } {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const plaintext = Buffer.from(bytes).toString("base64url");
	return { plaintext, hash: hashKey(plaintext) };
}

export function hashKey(plaintext: string): string {
	return new Bun.CryptoHasher("sha256").update(plaintext, "utf8").digest("hex");
}

// ------------------------------------------------------------------------------- scopes

export interface TenantScope {
	kind: "tenant";
	tenantId: string;
	/** Source label on everything written with this scope. Not identity: it names which
	 *  key was used, not who held it (premise 3). */
	actor: string;
}

export interface DocScope {
	kind: "doc";
	tenantId: string;
	docId: string;
	keyId: string;
	role: "read" | "write";
	label: string;
	actor: string;
}

export type Scope = TenantScope | DocScope;

// ------------------------------------------------------------------- capability table

export type Capability =
	| "doc.create"
	| "doc.list"
	| "doc.read"
	| "doc.delete"
	| "content.write"
	| "state.write"
	| "state.force"
	| "events.append"
	| "keys.mint"
	| "keys.revoke"
	| "keys.list"
	| "versions.read"
	| "versions.restore"
	| "webhook.set";

/**
 * What a document key may do. Everything absent from these sets is tenant-only, which is
 * the point: the table is a list of exceptions to "the tenant owns it", not a list of
 * restrictions on an otherwise-permitted key.
 */
const DOC_WRITE_CAPS: ReadonlySet<Capability> = new Set([
	"doc.read",
	"state.write",
	"events.append",
]);

const DOC_READ_CAPS: ReadonlySet<Capability> = new Set(["doc.read"]);

/**
 * The single authorization decision in the system.
 *
 * `docId` must be supplied for any per-document capability: a document key is scoped to
 * exactly one document, and forgetting to compare would let a key for document A act on
 * document B.
 */
export function can(scope: Scope, capability: Capability, docId?: string): boolean {
	if (scope.kind === "tenant") {
		// The tenant owns its documents outright. Cross-tenant access is prevented by the
		// WHERE clause on every query, not here.
		return true;
	}

	if (docId !== undefined && docId !== scope.docId) return false;

	return scope.role === "write"
		? DOC_WRITE_CAPS.has(capability)
		: DOC_READ_CAPS.has(capability);
}

// ----------------------------------------------------------------------- the resolver

interface TenantRow {
	id: string;
	name: string;
	disabled: number;
}

interface DocKeyRow {
	id: string;
	doc_id: string;
	label: string;
	role: "read" | "write";
	revoked_at: number | null;
	tenant_id: string;
	tenant_disabled: number;
}

/**
 * Bearer token to scope, or null.
 *
 * One code path for both key kinds. Every subsequent query carries `tenant_id` or `doc_id`
 * in its WHERE clause — isolation is never a filter applied in memory.
 */
export function resolve(db: Database, plaintext: string | null | undefined): Scope | null {
	if (!plaintext) return null;
	const hash = hashKey(plaintext);

	const tenant = db
		.query<TenantRow, [string]>("SELECT id, name, disabled FROM tenants WHERE key_hash = ?")
		.get(hash);

	if (tenant) {
		if (tenant.disabled) return null;
		return { kind: "tenant", tenantId: tenant.id, actor: "claude" };
	}

	// A13: the join is load-bearing. Without it `vaiven tenant disable` stops the tenant
	// key and leaves every document key of that tenant working.
	const key = db
		.query<DocKeyRow, [string]>(
			`SELECT k.id, k.doc_id, k.label, k.role, k.revoked_at,
			        d.tenant_id            AS tenant_id,
			        t.disabled             AS tenant_disabled
			   FROM doc_keys k
			   JOIN docs    d ON d.id = k.doc_id
			   JOIN tenants t ON t.id = d.tenant_id
			  WHERE k.key_hash = ?`,
		)
		.get(hash);

	if (!key) return null;
	if (key.revoked_at !== null) return null;
	if (key.tenant_disabled) return null;

	return {
		kind: "doc",
		tenantId: key.tenant_id,
		docId: key.doc_id,
		keyId: key.id,
		role: key.role,
		label: key.label,
		actor: key.label,
	};
}

// --------------------------------------------------------------- last_seen, throttled

/** keyId -> epoch ms of the last persisted touch. */
const lastTouch = new Map<string, number>();
const TOUCH_INTERVAL_MS = 60_000;
/** Enough to notice a leak, small enough to stay a rounding error in the row.
 *
 *  These are per-key hashes of the address, never the address: salting with the key id
 *  means the same person visiting two documents is not correlatable across them either. */
const MAX_TRACKED_IPS = 20;

/**
 * A5: as specified, "resolving a key updates last_seen" turns every read into a write —
 * and the shell polls every three seconds, so an idle open document would write twenty
 * times a minute to the same file the 304 fast path exists to keep cheap.
 *
 * Throttled to once per key per minute, and deliberately outside the request transaction:
 * a failure to record telemetry must never fail the request that triggered it.
 */
export function touchKey(db: Database, scope: Scope, ip: string | null): void {
	if (scope.kind !== "doc") return;
	touchKeyById(db, scope.keyId, ip);
}

/**
 * The same thing for `/r/`, which resolves a key by hash without ever building a Scope.
 * Without this the leak signal — `last_seen` and the distinct-IP count that `vaiven key
 * list` prints — was blank for exactly the keys most likely to leak: the ones that travel
 * in a URL people paste around.
 */
export function touchKeyById(db: Database, keyId: string, ip: string | null): void {
	const now = Date.now();
	const previous = lastTouch.get(keyId) ?? 0;
	if (now - previous < TOUCH_INTERVAL_MS) return;
	lastTouch.set(keyId, now);

	try {
		const row = db
			.query<{ seen_ips: string }, [string]>("SELECT seen_ips FROM doc_keys WHERE id = ?")
			.get(keyId);

		let ips: string[] = [];
		if (row) {
			try {
				const parsed = JSON.parse(row.seen_ips);
				if (Array.isArray(parsed)) ips = parsed.filter((v) => typeof v === "string");
			} catch {
				ips = [];
			}
		}

		// Hashed, not raw. The only consumer — `vaiven key list` — reads the COUNT, which is
		// all A13 asked for ("expose last_seen and a distinct-IP count so a leak is at least
		// observable"). Storing the addresses themselves kept personal data, indefinitely,
		// about people who were told their edits are recorded and nothing about their
		// network. A hash keeps distinctness and drops the data.
		const marker = ip ? hashKey(`${keyId}:${ip}`).slice(0, 16) : null;
		if (marker && !ips.includes(marker) && ips.length < MAX_TRACKED_IPS) ips.push(marker);

		db.query("UPDATE doc_keys SET last_seen = ?, seen_ips = ? WHERE id = ?").run(
			now,
			JSON.stringify(ips),
			keyId,
		);
	} catch {
		// Telemetry only. A locked database here must not turn a successful read into a 500.
	}
}

// ------------------------------------------------------------------------------ minting

export function insertDocKey(
	db: Database,
	docId: string,
	label: string,
	role: "read" | "write",
): { id: string; plaintext: string; label: string; role: "read" | "write" } {
	const { plaintext, hash } = mintKey();
	const id = newKeyId();
	db.query(
		"INSERT INTO doc_keys (id, doc_id, key_hash, label, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run(id, docId, hash, label, role, Date.now());
	return { id, plaintext, label, role };
}

/** Bearer token from the Authorization header. Nothing else is accepted: a token in a
 *  query string ends up in logs, history and referrers. `/r/` is the deliberate exception
 *  and it has its own route. */
export function bearerFrom(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match?.[1] ? match[1].trim() : null;
}
