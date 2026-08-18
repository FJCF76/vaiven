-- Vaivén schema.
--
-- A5's corrections are applied here rather than retrofitted, because every one of them is
-- a ten-minute change now and a migration with live data later, in a system that puts
-- migrations out of scope.
--
-- Pragmas are NOT set here. journal_mode is persistent but foreign_keys and busy_timeout
-- are per-connection and silently default off, which is how every ON DELETE CASCADE below
-- becomes a no-op. They are set in db.ts, on every connection, including the CLI's.

CREATE TABLE IF NOT EXISTS tenants (
  id                  TEXT    PRIMARY KEY,          -- t_<26 chars of base32>
  name                TEXT    NOT NULL,
  key_hash            TEXT    NOT NULL UNIQUE,      -- SHA-256; the plaintext exists once
  -- A13: a document born with a read key is born with a permanent, public-if-leaked URL.
  -- That should be a choice, not a default.
  mint_read_key       INTEGER NOT NULL DEFAULT 0,
  max_docs            INTEGER NOT NULL DEFAULT 100,
  max_bytes           INTEGER NOT NULL DEFAULT 104857600,   -- 100 MB  (A4)
  max_versions_bytes  INTEGER NOT NULL DEFAULT 209715200,   -- 200 MB  (A2: accounted, not exempt)
  -- A5: counters, never scans. Summing 100 rows of 4 MB content on every state write
  -- would read hundreds of MB per keystroke burst.
  used_bytes          INTEGER NOT NULL DEFAULT 0,
  versions_bytes      INTEGER NOT NULL DEFAULT 0,
  -- No accounts means no email means no way to tell anyone about an outage, a breach or a
  -- leaked key. One nullable column keeps that possible.
  contact             TEXT,
  disabled            INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS docs (
  id              TEXT    PRIMARY KEY,              -- d_<26 chars>, >=128 bits (A5)
  tenant_id       TEXT    NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title           TEXT    NOT NULL DEFAULT '',
  -- A10: without provenance the recipient sees an unknown domain and a secret in the URL,
  -- which reads like phishing. Free now, a migration later.
  sender_note     TEXT    NOT NULL DEFAULT '',
  state           TEXT    NOT NULL DEFAULT '{}',
  state_bytes     INTEGER NOT NULL DEFAULT 2,
  version         INTEGER NOT NULL DEFAULT 0,
  versions_bytes  INTEGER NOT NULL DEFAULT 0,
  -- A3: computed at write time and stored, not recomputed by parsing 1 MB of JSON on
  -- every read at 600 reads/min.
  -- A3: what serving the CONTENT noticed (a stripped meta CSP, an added doctype).
  warnings        TEXT    NOT NULL DEFAULT '[]',
  -- A3: what the STATE looks like — fields with no `name`, which automatic mode has to
  -- key structurally. Kept apart because `warnings` is rewritten on every content serve.
  field_warnings  TEXT    NOT NULL DEFAULT '[]',
  webhook_url     TEXT,                             -- A15
  webhook_secret  TEXT,
  -- Idempotency. A network timeout AFTER the server committed would otherwise send the
  -- client down the conflict path, where it re-sends its annotations and the person who
  -- pressed "Done for now" is recorded as done twice.
  last_request_id TEXT,
  last_request_version INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- A5: the cursor is (updated_at, id) because updated_at alone is neither unique nor
-- stable during pagination, so pages skip and duplicate rows.
CREATE INDEX IF NOT EXISTS docs_tenant ON docs(tenant_id, updated_at DESC, id DESC);

-- A5: content lives in its own table. Sharing a row with state meant every 200-byte state
-- write rewrote up to 4 MB into the WAL, and `SELECT version` -- the hottest query in the
-- system, once per 3 s per open shell -- walked the overflow chain past the content blob.
CREATE TABLE IF NOT EXISTS doc_content (
  doc_id          TEXT    PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
  content         TEXT    NOT NULL DEFAULT '',
  content_version INTEGER NOT NULL DEFAULT 0,
  bytes           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS doc_keys (
  id         TEXT    PRIMARY KEY,                   -- k_<26 chars>
  doc_id     TEXT    NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  key_hash   TEXT    NOT NULL UNIQUE,
  label      TEXT    NOT NULL,                      -- source label, not identity (premise 3)
  role       TEXT    NOT NULL CHECK (role IN ('read', 'write')),
  last_seen  INTEGER,
  -- A13: a bearer URL in a path has no leak-detection story at all. A distinct-IP count
  -- is the cheapest thing that makes one observable.
  seen_ips   TEXT    NOT NULL DEFAULT '[]',
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS doc_keys_doc ON doc_keys(doc_id);

CREATE TABLE IF NOT EXISTS state_versions (
  doc_id  TEXT    NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  state   TEXT    NOT NULL,
  bytes   INTEGER NOT NULL,
  actor   TEXT    NOT NULL,
  ts      INTEGER NOT NULL,
  -- A2, from the E2 result: ten versions came out of 72 seconds of light editing, so a
  -- flat count cap holds about six minutes of history. Retention keeps the last N *and*
  -- one per editing session, so the net can still reach yesterday.
  session INTEGER NOT NULL,
  PRIMARY KEY (doc_id, version)
);

-- Pruning reads (version, bytes, ts, session) for every stored version of one document,
-- and `state` sits ahead of those columns in the record. A 1 MB state overflows onto
-- overflow pages, so reaching the columns after it means walking them — on every write.
-- Covering the prune with an index keeps it off the rows entirely.
CREATE INDEX IF NOT EXISTS state_versions_prune
  ON state_versions(doc_id, version, bytes, ts, session);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id     TEXT    NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  -- Stamped with the NEW version. `?since=v` returns version > v; if these carried the
  -- pre-increment version a reader would re-read the same batch forever (A8).
  version    INTEGER NOT NULL,
  actor      TEXT    NOT NULL,
  kind       TEXT    NOT NULL,                      -- edit | done | note | error | conflict | ...
  -- A11 prefers structured columns over prose: a tuple is harder to read as an
  -- instruction than a sentence is.
  field      TEXT,
  from_value TEXT,
  to_value   TEXT,
  op         TEXT,                                  -- add | remove, for array elements (A1)
  item       TEXT,                                  -- the element's label (A1)
  note       TEXT,
  payload    TEXT,
  ts         INTEGER NOT NULL
);

-- A5: `?since=` is the product and was the unindexed query. Ordering within a version is
-- by id, so the index carries it.
CREATE INDEX IF NOT EXISTS events_since ON events(doc_id, version, id);
-- Pruning by age scans without this.
CREATE INDEX IF NOT EXISTS events_prune ON events(doc_id, ts);
