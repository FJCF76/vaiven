// The database handle and the pragmas that have to be right on every connection.
//
// A5: two of these are silent correctness bugs when omitted, not performance tuning.
//   foreign_keys defaults OFF per connection, which makes every ON DELETE CASCADE in the
//   schema a no-op: deleting a document leaves its keys behind, and an orphaned key still
//   resolves and still authenticates.
//   busy_timeout defaults to 0, and bun:sqlite's db.transaction() opens DEFERRED, so a
//   read-then-write that upgrades after another connection committed raises
//   SQLITE_BUSY_SNAPSHOT — which the busy handler does not retry. There are three writers
//   on this file: the server, the CLI and the backup cron.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function open(path: string, { readonly = false } = {}): Database {
	const db = new Database(path, { readonly, create: !readonly, strict: false });

	// Persistent, but harmless to re-assert.
	db.exec("PRAGMA journal_mode = WAL");
	// Per-connection. Both of these are the bugs described above.
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA busy_timeout = 5000");
	// Durable enough for WAL, and an order of magnitude cheaper than FULL.
	db.exec("PRAGMA synchronous = NORMAL");
	// A5 / Phase 7: bound the WAL. A long-lived reader can otherwise starve the
	// checkpointer and the -wal file grows without limit.
	db.exec("PRAGMA wal_autocheckpoint = 1000");
	db.exec("PRAGMA journal_size_limit = 67108864");

	return db;
}

/** Idempotent: every statement in schema.sql is CREATE ... IF NOT EXISTS, so this runs on
 *  every boot and is the whole of the migration story for v1. */
export function migrate(db: Database): void {
	const sql = readFileSync(join(import.meta.dir, "..", "schema.sql"), "utf8");
	db.exec(sql);
}

/**
 * Every write path runs inside this.
 *
 * A5: BEGIN IMMEDIATE takes the write lock up front. The deferred transaction that
 * bun:sqlite gives you by default acquires it late, and the upgrade fails with
 * SQLITE_BUSY_SNAPSHOT that no busy handler will retry — surfacing as a 500 under
 * exactly the concurrency the system is built to expect.
 */
export function writeTx<T>(db: Database, fn: () => T): T {
	const run = db.transaction(fn);
	return run.immediate();
}

/** Bytes, not characters. `length()` in SQLite and `.length` in JS both count UTF-16
 *  code units, which understates a CJK or emoji document by up to 3x — so every "hard"
 *  cap would be wrong for exactly the users least able to guess why. */
export const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
