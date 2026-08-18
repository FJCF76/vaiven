# TODOS

What is known to be missing, from the audits that ran during `/ship`. Grouped by area,
then priority. Completed items move to the bottom.

## Verification

- **The Phase 4 human gate.**
  **Priority:** P0
  Hand the write URL to someone who has never seen the system, with no explanation. They
  must say unprompted what the document is, that their changes saved, and that their edits
  are recorded under a name. No test can stand in for this, and the plan makes it a
  blocking gate.

- **The cold-surface test on `guide.md`.**
  **Priority:** P0
  A fresh agent, one URL, nothing installed. It must state what the document is, what
  changed and who changed it. Sharper half: hand it the `/r/` URL first and require the
  `guide` field alone to bootstrap it. Every retry is a guide bug.

- **Chaos harness (T14).**
  **Priority:** P1
  `test/invariants.ts` checks the invariants and passes; nothing kills the server
  underneath it. Needs N virtual clients, a process that SIGKILLs the server every ~20s, a
  backup loop and CLI churn, with the invariants asserted continuously.

- **Capacity measurement.**
  **Priority:** P2
  The plan's target is 200 concurrent open shells across 50 documents at p95 under 200 ms.
  Never measured.

- **Coalescing edge cases.**
  **Priority:** P2
  IME composition, paste, autofill, `type=range` drag, type-then-undo, interleaved edits
  across two fields. IME matters most: every composition update fires `input`.

- **Concurrency at the DB layer.**
  **Priority:** P2
  Two connections forcing `SQLITE_BUSY_SNAPSHOT`. The current concurrency coverage is at
  the HTTP layer only.

## Tests

- **`cli.ts` has no test at all.**
  **Priority:** P1
  The only admin surface: it mints credentials, destroys data and adjusts tenant counters.
  A `doc delete` counter leak was already found and fixed here once, by reading.

- **Webhook delivery is untested.**
  **Priority:** P1
  The SSRF address table is thorough; the delivery half is not. Needs a local receiver
  asserting `Vaiven-Signature: sha256=<hmac>` over the exact bytes sent, the retry count,
  the `webhook_failed` event, and the in-flight guard.

- **Read-only enforcement is not tested in a browser.**
  **Priority:** P1
  No test opens a document with a read key in Chromium. A regression hands a read-key
  holder a live form whose every keystroke is silently discarded.

- **Version and event pruning are untested.**
  **Priority:** P2
  `invariants.ts` only asserts the counters agree. Pruning that kept nothing but the newest
  version would keep them perfectly balanced while destroying the safety net.

- **`request_id` replay has no test.**
  **Priority:** P2
  The path was unreachable until this release and is now live. Same id twice must return
  the same version and must not duplicate annotations.

- **`touchKeyById` is untested.**
  **Priority:** P3
  The throttle, the 20-marker cap, and that no raw address is ever stored.

- **`inject.ts` is only half covered.**
  **Priority:** P3
  The no-doctype path, meta-CSP stripping and `<base>` stripping are unguarded, and A14
  exists because a shortcut once put every document into quirks mode.

## Known, from the pre-landing review

- **A replay can return a version that is no longer current.**
  **Priority:** P2
  `last_request_version` is only written when a `request_id` is present, so an intervening
  write without one leaves the slot stale, and a replay then answers with an old version
  and an ETag naming a representation that no longer exists. Recoverable via the conflict
  path, and unreachable from the shell; it bites an API client that reuses an id correctly,
  which is the audience the feature was written for.

- **A 304 hides events appended at an unchanged version.**
  **Priority:** P2
  `postEvents` deliberately does not bump the version, and the ETag is built from version
  plus content_version, so a conditional reader can be told "not modified" while a "Done
  for now" note is waiting. The shell is unaffected today because every edit event
  coincides with a version bump, and the guide never tells agents to send `If-None-Match`.
  It is a correctness gap waiting for the first agent that does.

- **An event appended without a version bump is invisible to a conditional reader.**
  **Priority:** P2
  `postEvents` deliberately does not bump the version and the ETag is built from version
  plus content_version, so a poll sending `If-None-Match` gets a 304 and the appended
  event is never delivered to that client at all — not merely late. Closing it properly
  means adding the newest event id to the ETag, which changes a documented contract.
  Found independently by the pre-landing review and by Codex.

- **A 64-character `request_id` prefix collision would replay the wrong write.**
  **Priority:** P3
  `putState` truncates the id at 64 characters, so two long ids sharing a prefix collide.
  Unreachable from the shell, which sends a UUID.

- **The stamp regex is fence-unaware.**
  **Priority:** P3
  It attaches after the first `^#\s` line. Every guide page today has a real H1 first and
  no fenced block containing one, so this is latent — but a future sub-page whose first
  `# ` line sits inside a ```bash block would get the stamp injected into the code.

- **`VERSION` is read once at module load; guide files are read per request.**
  **Priority:** P3
  Editing a guide file on the box without restarting serves new content under the old
  version stamp — the inversion of what the stamp is for. Moot on the supported path,
  since `deploy/sync.sh` restarts the service.

- **`render` repaints synchronously inside `mutate`, including for the app's own change.**
  **Priority:** P2  ·  *documented and worked around in guide.md; the burden is still on the author*
  That is what makes the natural painter — rebuild the list on every render — destroy the
  field being typed into. Documented as a rule the author must follow, which works but puts
  the burden in the wrong place. Worth considering whether the helper should skip the
  repaint for a mutation the app itself just made, or expose the focused element so a
  painter can preserve it.

- **A guard that iterates a hardcoded file list stops covering the moment a file is added.**
  **Priority:** P2
  Fixed for the guide guards in 0.2.4.0 by reading the directory. Worth a sweep: any other
  test that enumerates files by name has the same shape, and the failure is silent — the
  suite goes green while coverage quietly shrinks.

- **Error shape gives an agent no machine-readable retry semantics.**
  **Priority:** P1
  `unauthorized` (retry with another key), `revoked` (never), `disabled` (never), `conflict`
  (retry after merge), `rate_limited` (retry after N), `quota_exceeded` (only after deleting)
  are six different behaviours, and the only way to tell them apart is parsing English out of
  `hint`. `guide/errors.md` says "branch on `code`, never on the message" and then leaves the
  retry decision in the message. Add a boolean to the error object. Surfaced by /autoplan DX.

- **`resolve_by` would encode who can actually fix an error.**
  **Priority:** P2
  Four parties exist — the agent, the human in its conversation, whoever sent the link, the
  instance operator — and which one applies is carried only in prose. `resolve_by: "self" |
  "user" | "sender" | "operator"` is the structural version of the CLI-misdirection bug just
  fixed, and would survive future copy drift.

- **Auth runs before routing, so a typo'd path reports as an auth failure.**
  **Priority:** P2
  `requireScope` is called at `src/routes/router.ts:26`, before dispatch. An unauthenticated
  request to a nonexistent path returns 401 asserting "This route needs a key" — naming a
  route that may not exist. This is believed to be part of what sent the reporting agent
  hunting for credentials rather than checking its URL.

- **405 returns `code: "invalid"`, which means "malformed body" everywhere else.**
  **Priority:** P2
  `methodNotAllowedWith` (`src/routes/router.ts:98`) sets status 405 but code `invalid`. An
  agent following "branch on code" cannot tell a bad verb from bad JSON. Needs its own code.

- **No `WWW-Authenticate` header on 401.** **Priority:** P3
  RFC 9110 requires it; some HTTP client wrappers surface a challenge-less 401 as a transport
  error rather than an auth error. One line.

- **Recovery data sits outside the `error` object.** **Priority:** P2
  `retry_after`, and `version`/`state` on 409, land at the body top level via `extra`. An agent
  parsing `body.error.*` uniformly — the obvious read given the shape — misses every piece of
  recovery data. Either move them inside or say so explicitly in the guide.

- **`not_found` covers four different things** (route, document, key, version) with an unused
  `field` slot already in `ErrorDetail`. **Priority:** P3

- **`guide` is the same URL for 8 of 12 codes**, so it reads like a per-error deep link and is
  not. Anchor it or stop implying specificity. **Priority:** P3

- **`upstream_error` is declared and never thrown**, and appears in neither error table, while
  guide.md claims "every code, so you never have to fetch anything to recover". Delete it or
  document it. **Priority:** P2

- **Frozen until a non-author human has used a document:** the role gate naming the manual's two
  audiences, section reordering so the agent HTTPS path is first, a first-success probe, and
  regression guards over guide text. Unfrozen by evidence, not by preference. See
  `docs/designs/agent-onboarding.md`.

- **The instance-model decision must not ride in on a docs branch.**
  **Priority:** P1
  `docs/designs/vaiven-v1.md:950` ("self-hostable by others, or one instance?") needs its own
  one-page decision. Note for whoever takes it: "self-hosting by cloning" makes adoption
  **unobservable**, and the kill criterion is a count — if usage cannot be counted the criterion
  can never fire, and the project neither succeeds nor stops. Alternatives never costed:
  invite-gated `POST /api/tenants`; a public demo tenant with short expiry and tiny quota (the
  10x reframe — the sandbox host, CSP and quota machinery that makes it safe already exists);
  publishing the CLI.

## Product

- **The sender is never named.**
  **Priority:** P1
  The disclosure says "whoever sent you this link" because no field can say more. For a
  stranger opening a secret URL on an unfamiliar domain, "who is this from" is the first
  question. A `sender_name` column is small; it is a product decision about what the API
  asks for.

- **`POST /api/docs` will not accept raw `text/html`.**
  **Priority:** P2
  `PUT /content` does. So the *first* publish still has to JSON-encode a whole document,
  which A12 names as the highest-probability agent failure in the flow.

- **The webhook only fires from `putState`.**
  **Priority:** P2
  `putContent` and `restoreVersion` both bump the version and deliver nothing. A change
  arriving during an in-flight delivery is dropped rather than coalesced.

## Documentation

- **The README's test count is written by hand and has drifted twice.**
  **Priority:** P3
  Every time tests are added it becomes a lie, and it is the kind of lie that makes a reader
  distrust the rest of the file. Generate it, drop the number, or assert it in a test.

- **`upstream_error` (502) is declared and never thrown.**
  **Priority:** P3
  `src/errors.ts` defines it; nothing raises it. `guide/errors.md` correctly omits it, so the
  documentation is right and the code carries a dead branch — but the two can drift apart
  silently, which is the pattern this release spent its time on.

- **The design doc describes an older authorization model than the code implements.**
  **Priority:** P2
  A13 in `docs/designs/vaiven-v1.md` names key mint/revoke, delete and `?force=1` as tenant
  scope. `auth.ts` is narrower: a document key has exactly three capabilities — `doc.read`,
  `state.write`, `events.append` — and everything else is tenant scope. guide.md,
  guide/errors.md and the code now agree; the design doc does not.

- **`gstack-version-bump` rewrites package.json with 2-space indentation.**
  **Priority:** P3
  The repo uses tabs, so a one-field version change arrives as a 42-line diff. Worked around
  by hand this release; worth a `.gstack/package-json-path` pin or a formatting guard.

- **The design doc does not record the architecture divergences.**
  **Priority:** P2
  Server-derived events replacing the shadow cache, server-side `_vid` stamping, a
  hand-rolled diff instead of microdiff, Playwright instead of Puppeteer, `state`
  deliberately exempt from A11 clamping. Each is reasoned in a source comment and a commit
  message; the doc still asserts the opposite. The ops divergences are recorded properly
  and are the model to follow.
- **CORS on `/r/` is still listed as an open question** and was decided and shipped.

## Completed

- Two-origin deployment with blocking gates. **Completed:** v0.2.0.0 (2026-08-18)
- Schema, ids, and one authorization decision. **Completed:** v0.2.0.0 (2026-08-18)
- The API and the read-back. **Completed:** v0.2.0.0 (2026-08-18)
- The shell, the helper, and administration. **Completed:** v0.2.0.0 (2026-08-18)
- The manual and ops. **Completed:** v0.2.0.0 (2026-08-18)
- Security audit findings, design audit findings, QA findings. **Completed:** v0.2.0.0 (2026-08-18)
- `config.ts` startup refusals, tested in a subprocess (13 checks). Found and fixed a real
  hole while writing them: `http` was refused only when NEITHER host was `.localhost`, so
  one `.localhost` host paired with a real one served the shell in the clear.
  **Completed:** v0.2.1.0 (2026-08-18)
- `bun run dev` handed back URLs on a port nothing was listening on. **Completed:** v0.2.1.0 (2026-08-18)
- The manual named `Vaiven.render` and `mutate` and defined them nowhere, behind a link
  nothing could fetch. **Completed:** v0.2.1.0 (2026-08-18)
- An installed manual carried no version, so a correction could never reach anyone who had
  already installed it. **Completed:** v0.2.1.0 (2026-08-18)
- The guide tests reimplemented the code they were meant to test. **Completed:** v0.2.1.0 (2026-08-18)
- A deleted field lost to a concurrent edit, silently. **Completed:** v0.2.1.0 (2026-08-18)
- `README.md` documents install, `bun run dev`, the `.localhost` recipe, the environment,
  the test tiers and where every other doc lives. **Completed:** v0.2.0.0 (2026-08-18)
