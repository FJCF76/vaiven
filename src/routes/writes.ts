// The mutating routes.
//
// The state write is the transaction everything else in the design leans on: it advances
// the version, stores the new state, derives the events, keeps the safety net, prunes both
// tables and updates the byte counters — atomically, or not at all.

import type { Database } from "bun:sqlite";
import { insertDocKey, type Scope } from "../auth.ts";
import { byteLength, writeTx } from "../db.ts";
import { deriveEvents, fieldWarnings, reconcileVids, safeParse, stampVids, validateAnnotations, clamp } from "../events.ts";
import { fail } from "../errors.ts";
import { isValidId } from "../ids.ts";
import { LIMITS, RATES, enforceRate, requireWithin } from "../quota.ts";
import { queueWebhook, validateWebhookUrl } from "../webhook.ts";
import { forgetPrepared } from "./content.ts";
import { extractSeedFields, seedStateFromContentSync } from "../seed.ts";
import {
	EVENT_RETENTION_MS,
	HARD_VERSION_CAP,
	KEEP_RECENT_VERSIONS,
	MAX_EVENTS_PER_DOC,
	SESSION_GAP_MS,
	UNTRUSTED,
	etagFor,
	json,
	loadDoc,
	parseIfMatch,
	readJson,
	requireCap,
	type DocRow,
} from "./api.ts";

// ------------------------------------------------------------------------ state write

export async function putState(
	db: Database,
	request: Request,
	url: URL,
	scope: Scope,
	id: string,
): Promise<Response> {
	requireCap(scope, "state.write", id);
	const doc = loadDoc(db, scope, id);

	enforceRate(scope.kind === "tenant" ? `w:${scope.tenantId}` : `w:${scope.keyId}`, RATES.write, "writes");

	const force = url.searchParams.get("force") === "1";
	if (force) requireCap(scope, "state.force", id);

	const ifMatch = parseIfMatch(request);
	if (ifMatch === null && !force) {
		fail("precondition_required", "This write needs If-Match.", {
			hint: `Send "If-Match: \\"${doc.version}\\"" with the version you read. Without it, two writers silently overwrite each other. Use ?force=1 only with a tenant key and only when you mean to discard whatever is there.`,
			extra: { version: doc.version },
		});
	}

	const body = await readJson(request, LIMITS.stateBytes + 65536, "state");
	if (body.state === undefined || typeof body.state !== "object" || body.state === null) {
		fail("invalid", "The body needs a `state` object.", {
			hint: 'Send {"state": {...}}. To append events without changing state, use POST /api/docs/:id/events instead.',
			field: "state",
		});
	}

	const previous = safeParse(doc.state);
	const next = reconcileVids(previous, body.state);
	const nextText = JSON.stringify(next);
	const nextBytes = byteLength(nextText);

	if (nextBytes > LIMITS.stateBytes) {
		fail("too_large", "That state is larger than the limit.", {
			hint: "Nothing was stored, so the document is unchanged. State holds the document's data; assets belong in content as data: URIs.",
			limit: LIMITS.stateBytes,
			actual: nextBytes,
		});
	}

	const tenant = db
		.query<{ used_bytes: number; max_bytes: number; versions_bytes: number; max_versions_bytes: number }, [string]>(
			"SELECT used_bytes, max_bytes, versions_bytes, max_versions_bytes FROM tenants WHERE id = ?",
		)
		.get(doc.tenant_id)!;

	const delta = nextBytes - doc.state_bytes;
	if (delta > 0 && tenant.used_bytes + delta > tenant.max_bytes) {
		fail("quota_exceeded", "This tenant is out of storage.", {
			hint: "Nothing was stored. Delete a document, or raise the limit with `vaiven tenant set --max-bytes`.",
			limit: tenant.max_bytes,
			actual: tenant.used_bytes + delta,
		});
	}

	// Derived, never accepted: the server holds both states, so the log cannot be forged
	// by the page. Client events are annotations only.
	const derived = deriveEvents(previous, next);
	const annotations = validateAnnotations(body.events);
	const requestId = typeof body.request_id === "string" ? body.request_id.slice(0, 64) : null;
	const now = Date.now();

	const result = writeTx(db, () => {
		// Everything the deltas depend on is read HERE, inside the transaction. Reading it
		// before writeTx and using it after was correct only by accident: BEGIN IMMEDIATE
		// serialises writers, but the ?force=1 path has no compare-and-set to catch a value
		// that moved, so the counters were adjusted against a row the UPDATE did not
		// actually replace.
		const live = db
			.query<{ state: string; state_bytes: number }, [string]>(
				"SELECT state, state_bytes FROM docs WHERE id = ?",
			)
			.get(id);
		if (!live) return { gone: true as const };

		// A commit whose response was lost comes back as a retry. Without this the retry
		// conflicts, rebases, writes again, advances the version twice and duplicates every
		// annotation in the batch -- so someone who pressed "Done for now" during a flaky
		// moment is recorded as done twice. The writer already sends the key; this is the
		// half that was missing.
		if (requestId) {
			const seen = db
				.query<{ last_request_id: string | null; last_request_version: number | null }, [string]>(
					"SELECT last_request_id, last_request_version FROM docs WHERE id = ?",
				)
				.get(id);
			if (seen?.last_request_id === requestId && seen.last_request_version !== null) {
				return { replay: true as const, version: seen.last_request_version };
			}
		}

		const liveDelta = nextBytes - live.state_bytes;

		// The quota check belongs in here too: outside, two concurrent writes on different
		// documents of the same tenant both saw the same used_bytes and both committed.
		const liveTenant = db
			.query<{ used_bytes: number; max_bytes: number }, [string]>(
				"SELECT used_bytes, max_bytes FROM tenants WHERE id = ?",
			)
			.get(doc.tenant_id)!;
		if (liveDelta > 0 && liveTenant.used_bytes + liveDelta > liveTenant.max_bytes) {
			return { quota: true as const, limit: liveTenant.max_bytes, actual: liveTenant.used_bytes + liveDelta };
		}

		// A5: single-statement compare-and-set. Correct under any isolation mode, and it
		// removes the read-then-write shape entirely.
		const changes = force
			? db.query("UPDATE docs SET state = ?, state_bytes = ?, version = version + 1, updated_at = ? WHERE id = ?").run(nextText, nextBytes, now, id).changes
			: db
					.query(
						"UPDATE docs SET state = ?, state_bytes = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
					)
					.run(nextText, nextBytes, now, id, ifMatch!).changes;

		if (changes === 0) return { conflict: true as const };

		// A3: computed here, once, rather than by scanning the state on every read.
		db.query("UPDATE docs SET field_warnings = ? WHERE id = ?").run(JSON.stringify(fieldWarnings(next)), id);

		const version = db.query<{ version: number }, [string]>("SELECT version FROM docs WHERE id = ?").get(id)!.version;

		// A2: one version per editing session survives, so the net can reach yesterday
		// rather than only the last few minutes of typing.
		const latest = db
			.query<{ ts: number; session: number }, [string]>(
				"SELECT ts, session FROM state_versions WHERE doc_id = ? ORDER BY version DESC LIMIT 1",
			)
			.get(id);
		const session = !latest || now - latest.ts > SESSION_GAP_MS ? now : latest.session;

		db.query(
			"INSERT INTO state_versions (doc_id, version, state, bytes, actor, ts, session) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(id, version, live.state, live.state_bytes, scope.actor, now, session);

		const insertEvent = db.query(
			`INSERT INTO events (doc_id, version, actor, kind, field, from_value, to_value, op, item, note, ts)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const event of derived) {
			insertEvent.run(id, version, scope.actor, "edit", event.field, event.from ?? null, event.to ?? null, event.op ?? null, event.item ?? null, null, now);
		}
		for (const annotation of annotations) {
			insertEvent.run(id, version, scope.actor, annotation.kind, null, null, null, null, null, annotation.note ?? null, now);
		}

		// The tenant budget was passed in but never compared against the tenant's actual
		// usage, so a per-document cap of 8 MB across 100 documents permitted 800 MB
		// against a 200 MB limit. Give each document what is left of the tenant's budget.
		const tenantHistory = db
			.query<{ versions_bytes: number; max_versions_bytes: number }, [string]>(
				"SELECT versions_bytes, max_versions_bytes FROM tenants WHERE id = ?",
			)
			.get(doc.tenant_id)!;
		const remainingHistory = Math.max(0, tenantHistory.max_versions_bytes - tenantHistory.versions_bytes);
		const freed = pruneVersions(db, id, remainingHistory);
		pruneEvents(db, id, now);

		if (requestId) {
			db.query("UPDATE docs SET last_request_id = ?, last_request_version = ? WHERE id = ?").run(
				requestId,
				version,
				id,
			);
		}

		const versionsDelta = live.state_bytes - freed;
		db.query("UPDATE docs SET versions_bytes = max(0, versions_bytes + ?) WHERE id = ?").run(versionsDelta, id);
		db.query(
			"UPDATE tenants SET used_bytes = max(0, used_bytes + ?), versions_bytes = max(0, versions_bytes + ?) WHERE id = ?",
		).run(liveDelta, versionsDelta, doc.tenant_id);

		return { conflict: false as const, version };
	});

	if ("replay" in result) {
		// Same answer as the original write, so a retry is safe rather than duplicating.
		const cv =
			db
				.query<{ content_version: number }, [string]>("SELECT content_version FROM doc_content WHERE doc_id = ?")
				.get(id)?.content_version ?? 0;
		return json({ version: result.version!, replayed: true }, 200, { etag: etagFor(result.version!, cv) });
	}

	if ("gone" in result) {
		fail("not_found", "That document was deleted while your write was in flight.", {
			hint: "Nothing was stored. If you still need it, create a new document.",
		});
	}

	if ("quota" in result) {
		fail("quota_exceeded", "This tenant is out of storage.", {
			hint: "Nothing was stored. Delete a document, or raise the limit with `vaiven tenant set --max-bytes`.",
			limit: result.limit,
			actual: result.actual,
		});
	}

	if (result.conflict) {
		const current = db.query<DocRow, [string]>("SELECT * FROM docs WHERE id = ?").get(id);
		if (!current) {
			fail("not_found", "That document was deleted while your write was in flight.", {
				hint: "Nothing was stored.",
			});
		}
		// A9's model error: it states the problem AND hands back what is needed to fix it.
		fail("conflict", "Someone else wrote to this document first.", {
			hint: "Merge your change into the `state` returned here, then retry with If-Match set to the `version` returned here. Your write was not applied.",
			extra: { version: current.version, state: safeParse(current.state), untrusted: UNTRUSTED },
		});
	}

	const contentVersion = db
		.query<{ content_version: number }, [string]>("SELECT content_version FROM doc_content WHERE doc_id = ?")
		.get(id)!.content_version;

	queueWebhook(db, doc, {
		doc_id: id,
		version: result.version,
		state: next,
		events: derived,
		next_since: result.version,
		untrusted: UNTRUSTED,
	});

	return json({ version: result.version }, 200, { etag: etagFor(result.version, contentVersion) });
}

/** Returns the bytes freed. */
function pruneVersions(db: Database, docId: string, tenantBudget: number): number {
	const rows = db
		.query<{ version: number; bytes: number; session: number }, [string]>(
			"SELECT version, bytes, session FROM state_versions WHERE doc_id = ? ORDER BY version DESC",
		)
		.all(docId);

	if (rows.length === 0) return 0;

	const keep = new Set<number>();
	// The recent tail, for undoing what just happened.
	for (const row of rows.slice(0, KEEP_RECENT_VERSIONS)) keep.add(row.version);
	// One per session, for reaching back past this sitting (A2, from the E2 result).
	const seenSessions = new Set<number>();
	for (const row of rows) {
		if (!seenSessions.has(row.session)) {
			seenSessions.add(row.session);
			keep.add(row.version);
		}
	}

	let total = 0;
	for (const row of rows) if (keep.has(row.version)) total += row.bytes;

	// Byte budget and hard row cap, oldest first, never dropping the newest.
	const perDocBudget = Math.min(8 * 1024 * 1024, tenantBudget);
	const ordered = rows.filter((r) => keep.has(r.version)).sort((a, b) => a.version - b.version);
	let index = 0;
	while ((total > perDocBudget || keep.size > HARD_VERSION_CAP) && index < ordered.length - 1) {
		const victim = ordered[index]!;
		keep.delete(victim.version);
		total -= victim.bytes;
		index++;
	}

	let freed = 0;
	const drop = db.query("DELETE FROM state_versions WHERE doc_id = ? AND version = ?");
	for (const row of rows) {
		if (!keep.has(row.version)) {
			drop.run(docId, row.version);
			freed += row.bytes;
		}
	}
	return freed;
}

/** A5: scoped to this document and indexed, not a full-table sweep on every write. The
 *  clock guard is for NTP steps on a freshly provisioned box, where a forward jump would
 *  otherwise delete the entire history in one statement. */
function pruneEvents(db: Database, docId: string, now: number): void {
	const bounds = db
		.query<{ oldest: number; newest: number; n: number }, [string]>(
			"SELECT min(ts) AS oldest, max(ts) AS newest, count(*) AS n FROM events WHERE doc_id = ?",
		)
		.get(docId);
	if (!bounds || bounds.n === 0) return;

	// A hard count ceiling, because retention by age alone bounds nothing on a busy
	// document: 120 writes/min x 200 events is millions of rows well inside 90 days.
	if (bounds.n > MAX_EVENTS_PER_DOC) {
		db.query(
			`DELETE FROM events WHERE doc_id = ? AND id NOT IN (
			   SELECT id FROM events WHERE doc_id = ? ORDER BY id DESC LIMIT ?)`,
		).run(docId, docId, MAX_EVENTS_PER_DOC);
	}

	// The original guard was dead code AND aimed the wrong way: `now - oldest < RETENTION`
	// already returns for every backwards step, so the backwards check could never run,
	// while the forward jump it was written for -- an NTP correction on a fresh box, which
	// would delete a document's entire history in one statement -- was unguarded.
	if (now < bounds.newest) return; // clock behind the data: do nothing rather than guess
	if (now - bounds.newest > EVENT_RETENTION_MS) return; // implausibly far ahead: a clock step
	if (now - bounds.oldest < EVENT_RETENTION_MS) return;

	db.query("DELETE FROM events WHERE doc_id = ? AND ts < ?").run(docId, now - EVENT_RETENTION_MS);
}

// ---------------------------------------------------------------------- content write

export async function putContent(
	db: Database,
	request: Request,
	scope: Scope,
	id: string,
): Promise<Response> {
	requireCap(scope, "content.write", id);
	const doc = loadDoc(db, scope, id);
	enforceRate(scope.kind === "tenant" ? `w:${scope.tenantId}` : `w:${scope.keyId}`, RATES.write, "writes");

	// A12: accept a raw body. JSON-encoding a 4 MB HTML document inside a shell command
	// is the highest-probability failure in the whole flow.
	const type = request.headers.get("content-type") ?? "";
	let content: string;
	if (type.includes("text/html") || type.includes("text/plain")) {
		content = await request.text();
	} else {
		const body = await readJson(request, LIMITS.contentBytes + 65536, "content");
		if (typeof body.content !== "string") {
			fail("invalid", "The body needs a `content` string.", {
				hint: 'Send {"content":"<!doctype html>…"}, or send the HTML as a raw body with Content-Type: text/html and skip the JSON entirely.',
				field: "content",
			});
		}
		content = body.content;
	}

	const bytes = byteLength(content);
	if (bytes > LIMITS.contentBytes) {
		fail("too_large", "That content is larger than the limit.", {
			hint: "Nothing was stored. Inline assets count toward the same budget — compress images or move them out of the document.",
			limit: LIMITS.contentBytes,
			actual: bytes,
		});
	}

	const current = db
		.query<{ content_version: number; bytes: number }, [string]>(
			"SELECT content_version, bytes FROM doc_content WHERE doc_id = ?",
		)
		.get(id)!;

	const tenant = db
		.query<{ used_bytes: number; max_bytes: number }, [string]>(
			"SELECT used_bytes, max_bytes FROM tenants WHERE id = ?",
		)
		.get(doc.tenant_id)!;

	const ifMatch = parseIfMatch(request);
	if (ifMatch !== null && ifMatch !== current.content_version) {
		fail("conflict", "The content changed since you read it.", {
			hint: "Re-read the document, then retry with If-Match set to the content_version you just read.",
			extra: { content_version: current.content_version },
		});
	}

	// Parsing the HTML is async and must not happen inside the transaction.
	const seedFields = await extractSeedFields(content);
	const now = Date.now();

	const outcome = writeTx(db, () => {
		// Read state INSIDE the transaction. The request body can be megabytes and takes
		// real time to arrive, so a state write that landed while it was being read would
		// otherwise be seeded over and silently erased.
		const live = db
			.query<{ state: string; state_bytes: number; version: number }, [string]>(
				"SELECT state, state_bytes, version FROM docs WHERE id = ?",
			)
			.get(id);
		if (!live) return { gone: true as const };

		// A republish may introduce fields the previous version did not have. Their authored
		// defaults become state; nothing already stored is touched -- that is what makes
		// republishing safe (§7's central loop).
		const existingState = safeParse(live.state) as Record<string, unknown>;
		const seeded = seedStateFromContentSync(existingState, seedFields);
		const seededText = JSON.stringify(seeded);
		const seededBytes = byteLength(seededText);
		const stateChanged = seededText !== live.state;

		if (seededBytes > LIMITS.stateBytes) {
			return { tooLarge: true as const, actual: seededBytes };
		}

		const stateDelta = stateChanged ? seededBytes - live.state_bytes : 0;
		const totalDelta = bytes - current.bytes + stateDelta;
		if (totalDelta > 0 && tenant.used_bytes + totalDelta > tenant.max_bytes) {
			return { quota: true as const, actual: tenant.used_bytes + totalDelta };
		}

		db.query(
			"UPDATE doc_content SET content = ?, content_version = content_version + 1, bytes = ? WHERE doc_id = ?",
		).run(content, bytes, id);

		if (stateChanged) {
			// The version MUST advance. Changing state without it left an editor holding the
			// old version able to pass the compare-and-set and delete the seeded defaults,
			// with no snapshot and no event recording that they had ever existed.
			db.query(
				"UPDATE docs SET state = ?, state_bytes = ?, version = version + 1, updated_at = ? WHERE id = ?",
			).run(seededText, seededBytes, now, id);
			db.query("UPDATE docs SET field_warnings = ? WHERE id = ?").run(JSON.stringify(fieldWarnings(seeded)), id);
			db.query(
				"INSERT INTO state_versions (doc_id, version, state, bytes, actor, ts, session) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(id, live.version + 1, live.state, live.state_bytes, scope.actor, now, now);
			db.query("UPDATE docs SET versions_bytes = versions_bytes + ? WHERE id = ?").run(live.state_bytes, id);

			const insert = db.query(
				`INSERT INTO events (doc_id, version, actor, kind, field, from_value, to_value, op, item, note, ts)
				 VALUES (?, ?, ?, 'edit', ?, ?, ?, ?, ?, NULL, ?)`,
			);
			for (const event of deriveEvents(existingState, seeded)) {
				insert.run(id, live.version + 1, scope.actor, event.field, event.from ?? null, event.to ?? null, event.op ?? null, event.item ?? null, now);
			}
		} else {
			db.query("UPDATE docs SET updated_at = ? WHERE id = ?").run(now, id);
		}

		db.query(
			"UPDATE tenants SET used_bytes = max(0, used_bytes + ?), versions_bytes = versions_bytes + ? WHERE id = ?",
		).run(totalDelta, stateChanged ? live.state_bytes : 0, doc.tenant_id);

		const after = db
			.query<{ content_version: number }, [string]>("SELECT content_version FROM doc_content WHERE doc_id = ?")
			.get(id)!;
		const version = db.query<{ version: number }, [string]>("SELECT version FROM docs WHERE id = ?").get(id)!.version;
		// The drift signal has to describe the state that now exists, not the one before
		// the seed -- otherwise it omits exactly the keys this republish just added.
		return { contentVersion: after.content_version, version, keys: Object.keys(seeded) };
	});

	if ("gone" in outcome) {
		fail("not_found", "That document was deleted while the content was uploading.", {
			hint: "Nothing was stored.",
		});
	}
	if ("tooLarge" in outcome) {
		fail("too_large", "Seeding the fields in that content would exceed the state limit.", {
			hint: "Nothing was stored. The default values in your markup become state; reduce them or the number of fields.",
			limit: LIMITS.stateBytes,
			actual: outcome.actual,
		});
	}
	if ("quota" in outcome) {
		fail("quota_exceeded", "This tenant is out of storage.", {
			hint: "Nothing was stored. Delete a document, or raise the limit with `vaiven tenant set --max-bytes`.",
			limit: tenant.max_bytes,
			actual: outcome.actual,
		});
	}

	// The old rendering is keyed by content_version so it can never be served for this one,
	// but there is no reason to keep it resident either.
	forgetPrepared(id);

	return json(
		{ content_version: outcome.contentVersion, version: outcome.version, state_keys: outcome.keys },
		200,
		{ etag: etagFor(outcome.version, outcome.contentVersion) },
	);
}

// -------------------------------------------------------------------- events append

export async function postEvents(
	db: Database,
	request: Request,
	scope: Scope,
	id: string,
): Promise<Response> {
	requireCap(scope, "events.append", id);
	const doc = loadDoc(db, scope, id);
	enforceRate(scope.kind === "tenant" ? `w:${scope.tenantId}` : `w:${scope.keyId}`, RATES.write, "events");

	const body = await readJson(request, 256 * 1024, "events");
	const annotations = validateAnnotations(body.events);
	if (annotations.length === 0) {
		fail("invalid", "No usable events in that request.", {
			hint: 'Send {"events":[{"kind":"done","note":"…"}]}. Only done, note and error are accepted here — edit events are derived from state by the server and cannot be asserted.',
			field: "events",
		});
	}

	const now = Date.now();
	writeTx(db, () => {
		const insert = db.query(
			"INSERT INTO events (doc_id, version, actor, kind, note, payload, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		for (const annotation of annotations) {
			insert.run(id, doc.version, scope.actor, annotation.kind, annotation.note ?? null, annotation.payload ? String(annotation.payload) : null, now);
		}
		// This route accepted ~256 KB per call at 120 calls/min per key, charged no quota
		// and never pruned, so any collaborator could write the disk full at roughly
		// 30 MB/minute. Retention only ran on a state write, which an attacker never has
		// to perform.
		pruneEvents(db, id, now);
	});

	// A12: deliberately does NOT bump `version` — that would burn a safety-net slot and
	// invalidate every open client's ETag for something that changed no data.
	return json({ version: doc.version, appended: annotations.length });
}

// ------------------------------------------------------------------------ key routes

export async function postKey(db: Database, request: Request, scope: Scope, id: string): Promise<Response> {
	requireCap(scope, "keys.mint", id);
	loadDoc(db, scope, id);
	const body = await readJson(request, 8192, "request");

	const role = body.role === "read" ? "read" : body.role === "write" ? "write" : null;
	if (!role) {
		fail("invalid", "A key needs a role.", {
			hint: 'Send {"label":"Marta","role":"write"}. Roles are "read" or "write" — read can look, write can change state.',
			field: "role",
		});
	}
	const label = requireWithin(body.label, LIMITS.labelChars, "label", "key label").trim();
	if (!label) {
		fail("invalid", "A key needs a label.", {
			hint: 'The label becomes the actor on everything written with this key, so name the person or system it is for: {"label":"Marta","role":"write"}.',
			field: "label",
		});
	}

	const minted = writeTx(db, () => insertDocKey(db, id, label, role));
	return json({ id: minted.id, label: minted.label, role: minted.role, key: minted.plaintext }, 201);
}

export function deleteKey(db: Database, scope: Scope, id: string, keyId: string): Response {
	requireCap(scope, "keys.revoke", id);
	loadDoc(db, scope, id);
	if (!isValidId(keyId, "k")) {
		fail("not_found", "No key with that id.", { hint: "Key ids look like k_ followed by 26 characters. `GET /api/docs/:id` lists them under `keys`." });
	}

	// A13: scoped to the document as well as the key. Without the doc_id clause a key id
	// from one document could revoke a key on another.
	const changes = writeTx(
		db,
		() =>
			db
				.query("UPDATE doc_keys SET revoked_at = ? WHERE id = ? AND doc_id = ? AND revoked_at IS NULL")
				.run(Date.now(), keyId, id).changes,
	);

	if (changes === 0) {
		fail("not_found", "No live key with that id on this document.", {
			hint: "It may already be revoked. `GET /api/docs/:id` shows every key and whether it is revoked.",
		});
	}
	return new Response(null, { status: 204 });
}

export function deleteDoc(db: Database, scope: Scope, id: string): Response {
	requireCap(scope, "doc.delete", id);
	const doc = loadDoc(db, scope, id);

	writeTx(db, () => {
		const versionBytes = db
			.query<{ total: number }, [string]>("SELECT coalesce(sum(bytes), 0) AS total FROM state_versions WHERE doc_id = ?")
			.get(id)!.total;
		const contentBytes = db
			.query<{ bytes: number }, [string]>("SELECT bytes FROM doc_content WHERE doc_id = ?")
			.get(id)?.bytes ?? 0;
		// Inside the transaction, like the other two, so a write that lands between the
		// load and here cannot leave the counter over- or under-stated.
		const stateBytes = db
			.query<{ state_bytes: number }, [string]>("SELECT state_bytes FROM docs WHERE id = ?")
			.get(id)?.state_bytes ?? 0;

		// The cascade does the rest — and it only works because foreign_keys is ON per
		// connection, which is why db.ts sets it and a test asserts it.
		db.query("DELETE FROM docs WHERE id = ?").run(id);
		db.query(
			"UPDATE tenants SET used_bytes = max(0, used_bytes - ?), versions_bytes = max(0, versions_bytes - ?) WHERE id = ?",
		).run(stateBytes + contentBytes, versionBytes, doc.tenant_id);
	});

	return new Response(null, { status: 204 });
}

// ------------------------------------------------------------------ version recovery

export function listVersions(db: Database, scope: Scope, id: string): Response {
	requireCap(scope, "versions.read", id);
	loadDoc(db, scope, id);
	const rows = db
		.query<any, [string]>(
			"SELECT version, bytes, actor, ts, session FROM state_versions WHERE doc_id = ? ORDER BY version DESC",
		)
		.all(id);

	return json({
		versions: rows.map((row) => ({
			version: row.version,
			bytes: row.bytes,
			actor: row.actor,
			at: new Date(row.ts).toISOString(),
			session: new Date(row.session).toISOString(),
		})),
	});
}

export async function restoreVersion(
	db: Database,
	request: Request,
	scope: Scope,
	id: string,
): Promise<Response> {
	requireCap(scope, "versions.restore", id);
	const doc = loadDoc(db, scope, id);
	// It rewrites state and advances the version, so it is a write in every sense and
	// carries the same budget as one.
	enforceRate(scope.kind === "tenant" ? `w:${scope.tenantId}` : `w:${scope.keyId}`, RATES.write, "writes");
	const body = await readJson(request, 8192, "request");
	const target = Number(body.version);

	// Optional, but honoured when sent. Restoring replaces the whole state, so without a
	// precondition a restore issued from a stale read silently discards every write that
	// landed in between. The replaced state is snapshotted below, so this is a guard
	// rather than the only thing standing between the caller and data loss.
	const ifMatch = parseIfMatch(request);

	const snapshot = db
		.query<{ state: string; bytes: number }, [string, number]>(
			"SELECT state, bytes FROM state_versions WHERE doc_id = ? AND version = ?",
		)
		.get(id, target);

	if (!snapshot) {
		fail("not_found", "No stored version with that number.", {
			hint: "`GET /api/docs/:id/state/versions` lists what is still retained. History is pruned by age and size, so an old version may be gone.",
			field: "version",
		});
	}

	const now = Date.now();
	const version = writeTx(db, () => {
		// Read what we are about to destroy, inside the transaction, so the snapshot and
		// the counter delta both describe the row the UPDATE actually replaces.
		const live = db
			.query<{ state: string; state_bytes: number; version: number }, [string]>(
				"SELECT state, state_bytes, version FROM docs WHERE id = ?",
			)
			.get(id)!;

		if (ifMatch !== null && live.version !== ifMatch) {
			fail("conflict", "The document changed since you read it, so it was not restored.", {
				hint: "Re-read the document. If you still want this version, retry with If-Match set to the `version` returned here — or omit If-Match to restore unconditionally.",
				extra: { version: live.version, state: safeParse(live.state) },
			});
		}

		db.query("UPDATE docs SET state = ?, state_bytes = ?, version = version + 1, updated_at = ? WHERE id = ?").run(
			snapshot.state,
			snapshot.bytes,
			now,
			id,
		);
		const next = db.query<{ version: number }, [string]>("SELECT version FROM docs WHERE id = ?").get(id)!.version;

		// Snapshot what we just replaced. Restoring is itself a destructive write, and
		// without this, restoring to an old version destroys the current one with no way
		// back -- a hole in the safety net, in the one operation it exists for.
		const latest = db
			.query<{ ts: number; session: number }, [string]>(
				"SELECT ts, session FROM state_versions WHERE doc_id = ? ORDER BY version DESC LIMIT 1",
			)
			.get(id);
		const session = !latest || now - latest.ts > SESSION_GAP_MS ? now : latest.session;
		db.query(
			"INSERT OR REPLACE INTO state_versions (doc_id, version, state, bytes, actor, ts, session) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(id, next, live.state, live.state_bytes, scope.actor, now, session);
		db.query("UPDATE docs SET versions_bytes = versions_bytes + ? WHERE id = ?").run(live.state_bytes, id);
		db.query("UPDATE tenants SET versions_bytes = versions_bytes + ? WHERE id = ?").run(
			live.state_bytes,
			doc.tenant_id,
		);
		db.query(
			"INSERT INTO events (doc_id, version, actor, kind, note, ts) VALUES (?, ?, ?, 'note', ?, ?)",
		).run(id, next, scope.actor, `restored the state from version ${target}`, now);
		db.query("UPDATE tenants SET used_bytes = max(0, used_bytes + ?) WHERE id = ?").run(
			snapshot.bytes - live.state_bytes,
			doc.tenant_id,
		);
		return next;
	});

	return json({ version, restored_from: target });
}

// --------------------------------------------------------------------------- webhook

export async function setWebhook(db: Database, request: Request, scope: Scope, id: string): Promise<Response> {
	requireCap(scope, "webhook.set", id);
	loadDoc(db, scope, id);
	const body = await readJson(request, 8192, "request");
	const raw = typeof body.webhook === "string" ? body.webhook.trim() : "";

	if (!raw) {
		writeTx(db, () => db.query("UPDATE docs SET webhook_url = NULL, webhook_secret = NULL WHERE id = ?").run(id));
		return json({ webhook: null });
	}

	const verdict = await validateWebhookUrl(raw);
	if (!verdict.ok) {
		fail("invalid", "That webhook URL cannot be used.", { hint: verdict.reason, field: "webhook" });
	}

	const secret = crypto.randomUUID().replaceAll("-", "");
	writeTx(db, () => db.query("UPDATE docs SET webhook_url = ?, webhook_secret = ? WHERE id = ?").run(raw, secret, id));
	return json({
		webhook: raw,
		webhook_secret: secret,
		note: "Verify each delivery: the Vaiven-Signature header is sha256=HMAC(secret, body).",
	});
}
