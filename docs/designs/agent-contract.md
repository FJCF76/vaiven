# Design: the agent contract — everything an agent is told or handed

Cycle 1 of three, from a third-party agent's first build against v0.2.5.1 on 2026-08-19.
Cycles 2 (shell copy) and 3 (read-time event coalescing) are scoped separately and are
**not** in this one.

## Problem statement

`POST /api/docs/:id/keys` returns `{id, label, role, key}` and no URL. An agent that needed
to send a person a link had nothing to send, built one by hand, wrote `#<key>` instead of
`#k=<key>`, and **a human received a dead link**.

`src/urls.ts` opens with the invariant this violates:

```
// A12: never make the agent construct a URL.
// Every response that mentions a document carries the URLs for it.
```

The helper that implements it, `docUrls()`, already exists and already handles both key
kinds. Document creation calls it. The mint route never did.

**This is the third instance of one defect class in three releases:**

| Release | Defect | Who absorbed it |
|---|---|---|
| 0.2.3.0 | `$HOST` placeholder in the instructions | agent |
| 0.2.5.0 | error hints named a CLI the caller could not run | agent |
| this one | `#k=` hand-built at key-mint | **a person** |

The first two were fixed reactively, one at a time. The invariant was already written down
before any of them shipped. So the deliverable here is not the one-line fix; it is the
**guard that makes the invariant checked rather than merely stated**.

## What the live probes settled

Two facts were measured against production rather than assumed, and both change the fix.

**1. `/r/<key>.json` resolves against `doc_keys`** — the same table the mint route writes to
(`src/routes/read.ts:88`). A minted key is therefore a `/r/` key, not only a shell key.

**2. The role gates it.** `read.ts:106` returns the opaque miss unless `role === "read"`:

```
role=read   →  GET /r/<key>.json  →  HTTP 200
role=write  →  GET /r/<key>.json  →  HTTP 404
```

So the correct response is **role-dependent**:

| Minted role | `view_url` | `read_url` |
|---|---|---|
| `write` | yes — `/d/<id>#k=<key>` | no; a write key is not a read key |
| `read` | yes — same link, read-only in the shell | **yes** — `/r/<key>.json` |

An outside review proposed `docUrls(config, docId, { write: key })` for all cases. That emits
`view_url` and omits `read_url` for read-role keys, leaving the agent to hand-build
`/r/<key>.json`. It is the same defect class inside the fix for the defect class, and it is
recorded here because it was one review pass away from shipping.

## Approaches considered

**A — fix it, live test only.** Smallest diff. Rejected: its bypass, named by the reviewer
that proposed it, is "a new endpoint returns `{key}` without URLs but is not in the tested
matrix." That bypass *is* the failure mode. A fourth instance arrives in new code, which by
definition no existing test covers.

**B — two guards, no chokepoint.** Adds a source scan that greps route files for a `json({…})`
literal mentioning `key` and asserts a URL nearby. Rejected on brittleness the same reviewer
enumerated: `json(payload)` with the body built elsewhere, nested braces defeating the regex,
`key` renamed or computed, `Response.json` instead of `json()`.

**C — chokepoint plus both guards. Chosen.** Move key serialization into `src/urls.ts`, the
file whose header states the invariant, so the rule and its only use site cannot drift apart.
The static guard then stops parsing JSON literals and asserts a structural property instead.

## The design

**One serializer, in the file that states the rule.**

```ts
// src/urls.ts
export function mintedKeyResponse(config: Config, docId: string, minted: MintedKey) {
  return {
    id: minted.id,
    label: minted.label,
    role: minted.role,
    key: minted.plaintext,
    ...docUrls(
      config,
      docId,
      minted.role === "read"
        ? { write: minted.plaintext, read: minted.plaintext }
        : { write: minted.plaintext },
    ),
  };
}
```

`docUrls`'s `keys.write` parameter means "a key that opens the `/d/` shell", not "a key with
role write" — a read-role key opens the same shell in read-only mode (A10). The parameter name
is misleading and is left alone deliberately: renaming it touches the document-creation call
site, which is out of scope for a cycle whose whole point is not widening. Recorded in
`TODOS.md` instead.

**Guard 1, live.** Mint both roles against a running server. Assert every URL equals what
`docUrls()` produces, and specifically that
`new URL(view_url).hash === '#k=' + encodeURIComponent(key)` — the exact byte the agent got
wrong. Assert a read-role key's `read_url` answers 200 and a write-role key has no `read_url`.

**Guard 2, static.** Assert `minted.plaintext` is serialized in **exactly one file**, and that
file is `src/urls.ts`. No regex over JSON literals, so reformatting, spreads, renames and
helper indirection cannot fool it. A new route that serializes a plaintext key fails the build
until it goes through the chokepoint.

Guard 1 proves today is correct. Guard 2 provides the forward coverage guard 1 structurally
cannot.

## Also in this cycle

Documentation, all verified absent rather than assumed absent:

- **The iframe canvas is white in every theme** (`src/shell/shell.css:205`), documented in a
  file no agent reads and mentioned zero times in `guide.md`. An author wrote a dark-mode media
  query, left the background, and shipped near-white text on white to a real person. **P1, not
  cosmetic:** the author cannot self-detect it — they test in light mode, it looks right, and
  the person who suffers it has no channel back. `/r/` exists to close that asymmetry and does
  not cover rendering.
- **No curl example for `PUT /state`**, the endpoint called most often and the only one with an
  `If-Match` precondition. Its absence made a careful reviewer report "no ETag on reads" as a
  finding when the ETag exists and round-trips. The example shows `-H "If-Match: $ETAG"`
  echoing the header, closing both gaps at once.
- **The iframe has no viewport**, so `position: sticky`, `position: fixed`, `100vh` and
  scroll-driven effects silently do nothing. Same category as the no-network warning: a
  capability an author would reasonably assume.
- **The array-label rule is unstated** — `labelOf` (`src/events.ts:162`) takes the element's
  first string-valued property, truncated to 40 characters. That rule is why a log stays
  readable a week later, and authors should know it so they put the human-meaningful field
  first when shaping state.
- **`Vaiven.note(text, payload)`** added as the honest name for `Vaiven.log(kind, payload)`,
  whose `kind` is hardcoded to `"note"` at `shell.js:409`. `log()` stays as an alias:
  `content` is served from the database rather than rebuilt, so a rename breaks every published
  document already calling it. Arbitrary kinds are **not** honoured — that would widen
  `ANNOTATION_KINDS` and change what `?since=` consumers can rely on.
- **`/r/` sends no ETag.** Real, and lowest urgency here: `mint_read_key` defaults to 0 per
  A13, so `/r/` is off for every tenant on this instance and is not the read an agent calls.

## Explicitly not in this cycle

Cutting the Done button, simplifying the consent disclosure, and the malformed-fragment
message are cycle 2 — they share one chrome surface and one design review. Read-time event
coalescing is cycle 3; it changes what every existing history reads back as and deserves its
own design pass. Signup and self-service tenancy stay closed, decided separately.

Cycles 1 and 2 both edit `guide.md`, so they run sequentially, never in parallel.

## Verification

- Both guards above, in CI (`bun test`) and against the live server.
- Existing suites stay green: `gate`, `negatives`, `loop`, `fields`, `repaint`, `invariants`.
- `guide.md` guards already assert no shell placeholders, no relative pointers, and that the
  sandbox origin survives the serve-time rewrite; the four new sections inherit them.
- A live mint of both roles, with the resulting `view_url` opened, before the cycle closes.
