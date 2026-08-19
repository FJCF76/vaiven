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

## API

All three below were reported by a third-party agent after building two documents against
v0.2.5.1 on 2026-08-19, then verified against the source.

- **`POST /api/docs/:id/keys` returns no URL, so the agent has to build one — and got it
  wrong.** It returns `{id, label, role, key}`. `view_url` is assembled in `src/urls.ts:30`
  as `${appOrigin}/d/${docId}#k=${encodeURIComponent(key)}` and attached only at document
  creation. The reporter wrote `#<key>` instead of `#k=<key>` and **sent a person a dead
  link**.

  **Why:** A12 states the invariant outright — *never make the agent construct a URL* — and
  `guide.md` actively routes agents here for the mint-a-named-key-per-person workflow, which
  is the one place the invariant has no enforcement. This is the third instance of the same
  defect class in three releases (`$HOST` in the instructions, `vaiven tenant create` in the
  error hints, now `#k=` at key-mint), and the first where the failure reached a human rather
  than an agent.

  **How to apply:** return `view_url` from the mint response, then add a guard that fails the
  build when any response body containing a key lacks a matching URL. The guard is the point —
  it converts a stated invariant into a checked one. Without it there will be a fourth.
  **Priority:** P1

- **`/r/<read_key>.json` sends no ETag.** `src/routes/read.ts` has no ETag logic;
  `GET /api/docs/:id` does, and the composite `W/"<version>.<content_version>"` round-trips
  directly as `If-Match` (measured: echoed verbatim, HTTP 200). `/r/` is the I2 floor endpoint
  — bare GET, no headers, nothing installed — so an agent polling it re-transfers the whole
  payload every time with no conditional path.

  Lower urgency than it sounds: `mint_read_key` defaults to 0 per A13, so `/r/` is off for
  every tenant on this instance today and is not the read an agent actually calls.
  **Priority:** P3

- **`Vaiven.log(kind, payload)` takes a `kind` that is not the kind.** `src/shell/shell.js:409`
  hardcodes `{kind: "note", note: label}`, so the caller's `kind` arrives as note *text*.
  `guide.md:113-115` documents the wart honestly, but an API whose first parameter lies is a
  trap documentation can only mitigate.

  **How to apply:** add `Vaiven.note(text, payload)` as the honest name, keep `log()` as an
  alias, document only `note()`. Do **not** rename outright — `content` is served from the
  database rather than rebuilt, so a rename breaks every published document already calling
  `log()`. Do **not** honour arbitrary kinds either: that widens `ANNOTATION_KINDS`
  (`src/events.ts:335`) and changes what `?since=` consumers can rely on.
  **Priority:** P3

- **`postKey` does not honour `mint_read_key`.** The tenant switch reads as "no public URLs
  for this tenant" and is enforced at document creation only (`src/routes/api.ts:258`);
  `POST /api/docs/<id>/keys` with `{"role":"read"}` mints a working public read key on a
  flag-off tenant, measured. As of this release the response also hands back the resulting
  `/r/` URL, so the gap is now advertised rather than merely present.

  **How to apply:** decide which it is. Either `postKey` refuses when the flag is 0 and the
  role is read, with a hint naming the CLI switch, or the flag is documented as a
  creation-time default and not tenant policy. Do not leave it reading as policy while one of
  the two paths ignores it.
  **Priority:** P2

- **`loadConfig(env)` accepts an `env` parameter and ignores it.** `required()`
  (`src/config.ts:66`) reads `process.env` directly, so the parameter is decoration. A caller
  that passes an env object gets the ambient one and no error. Found while writing
  `test/urls.test.ts`, which now builds a `Config` literal instead — mutating `process.env`
  from a test file would leak into every other file in the same bun process.
  **Priority:** P3

- **The two rendering warnings read prose as CSS.** `dark_mode_no_background` and
  `no_viewport` scan the whole published document, so a tutorial that shows
  `position: fixed` inside a `<pre>`, or an article about dark mode, earns a warning it does
  not deserve. Accepted deliberately for now: a false positive costs an agent one confusing
  sentence, and missing the real thing costs a person an unreadable page. The asymmetry
  favours warning.

  **How to apply, if it becomes noise:** scan only inside `<style>` elements and `style=`
  attributes rather than the whole document. That is a narrower scan, not a smarter one, and
  it would miss CSS injected by script — which is why it was not done first.
  **Priority:** P3

- **There is no `vaiven tenant disable` or `tenant enable` verb.** The schema has the
  `disabled` column, `resolveWithReason` honours it, and `test/negatives.ts` proves a disabled
  tenant's document keys stop working — but nothing in the CLI can set it. `tenant set` covers
  only `max-docs`, `max-bytes` and `read-keys`. A13 in `docs/designs/vaiven-v1.md` listed
  `tenant enable` among the CLI gaps and it was never filled.

  Found while cleaning up after a QA run that had minted two throwaway tenants and could not
  turn them off. Pre-existing, not from this release.
  **Priority:** P3

## Shell

- **The consent disclosure presupposes a sender who often does not exist.** `src/shell/shell.js:508`
  reads: *"Edits here are recorded as "Fernando" and shared with whoever sent you this link.
  Anyone who has the link can edit it too. Vaivén."* Reported by the first person to actually
  use a document, 2026-08-19, whose reaction was **"nobody sent me a link"** — they had opened
  their own document. The sentence names a party the reader cannot identify, so the one claim
  whose entire job is to be believed is the one they cannot check.

  Three separate claims are welded into one line (who you are recorded as, who receives it,
  who else can edit), and the bare "Vaivén." trailing the third reads as a fragment rather
  than a signature. The read-only variant on line 509 packs the same way, though without the
  false presupposition.

  **Why:** this is the consent notice. Design decision 18 accepted it as "cheap now, worst
  thing to retrofit" — the person never chose the name they are labelled with, their
  *corrections* are retained (`from` holds the value they thought better of), and in
  automatic mode the agent never knows the disclosure is happening, so the shell is the only
  thing that can make it. A disclosure that confuses its reader has not disclosed anything.

  **How to apply:** simplify, but do not simplify into a lie — the constraint that produced
  this sentence is that every clause must stay true for a read-key holder, a write-key
  holder, and the author opening their own document. Likely shape: drop the sender, name the
  audience the reader can verify (anyone with the link, plus the agent that made the
  document), and split the claims. Re-check the read-only variant in the same pass.
  **Priority:** P2

- **Event coalescing leaves keystroke residue in the log.** Typing one word with corrections
  produced seven events in the 2026-08-19 session: `cliente` went `Clienet ` → `Clienet` →
  `Cliene` → `Clien` → `Clienter` → `Cliente` → `Cliente1`. A1 already coalesces per field per
  flush, but the flush fires when the write pipeline builds a PUT, so a pause mid-word ends a
  batch. This works directly against `next_since`, whose reason for existing is to stop
  histories crowding out an agent's context.

  Nobody reported it for two releases because **an agent reading its own diffs never types
  with backspaces**. Only a human does, and the human has no channel to report it.

  **How to apply — coalesce at READ time, not write time.** The tempting fix is a wider flush
  window, and it is wrong: A1 chose eager flushing deliberately because people close tabs
  rather than tab out, which is why `pagehide` and `sendBeacon` exist. Widening the window
  trades log cleanliness against durability. Read-time collapse dissolves that — persist
  eagerly, present coalesced — and existing histories benefit with nothing discarded at ingest.

  Collapse consecutive events sharing `actor` and `field`, keeping the **original `from`** and
  the **final `to`**; intermediates carry nothing. Precedent exists: >10 array changes already
  collapse to one summary event.

  **Boundary: use A2's editing session (a gap of 10+ minutes), NOT a `done` event.** A third
  party proposed the `done` boundary; it makes log readability depend on a button people do
  not reliably press. In the session that produced this finding the button was pressed once,
  with an empty note, and editing continued afterwards — the boundary would have landed
  mid-session. The session gap is time-based, needs no human cooperation, and is already an
  accepted concept here.

  Known edge, worth stating so nobody files it later as a bug: a burst spanning two polls
  collapses into two coherent events rather than one. No information lost, no duplication,
  just less compression.
  **Priority:** P2

- **Verified: `kind: "done"` reaches no consumer, and pressing the button notifies nobody.**
  `src/events.ts:335` lists it in an allowlist and `src/routes/writes.ts` stores it. Nothing
  else in the codebase reads it. `postEvents` — the route the button calls — never queues a
  webhook, so the one thing that could justify a control ("the human is finished, look now")
  is the one thing it does not do. `writer.flush("done")` is not unique either; `pagehide` and
  the debounce both flush anyway.

  The button also disables itself permanently (`shell.js:641-642`), so a person who keeps
  editing — as happened on 2026-08-19 — cannot mark a second checkpoint, and the agent reads a
  `done` marker mid-log with fresh edits trailing it. The note is `placeholder = "Optional"`
  and was left empty, so what reached the agent was a bare flag carrying no more than the
  timestamp already did.

  **Recorded as a finding, not a decision.** The case it was built for (A10, decision 19) is
  the two-party asynchronous one: the editor is not the agent's principal, and only a note
  recovers intent the diff cannot — E2 showed "added extra budget" and "cut 6000 to 900, added
  a 5000 line" describing the same edit. That case has never occurred; the kill criterion is
  still 0 of 10. If it is cut, cut the button and keep the idea for a note wired to the
  webhook, so it actually notifies.
  **Priority:** P3

- **A malformed link fragment reports as missing.** `src/shell/shell.js:42-43` says *"This
  link is incomplete. The part after the # is missing…"* when the fragment is present but does
  not parse as `k=…`. Say "this link looks damaged" instead, or accept a bare key when the
  remainder looks like one. Turns a dead end into a recovery. Genuinely optional — the current
  message is clear, actionable and blames nobody, which is why it should stay close to what it
  is.
  **Priority:** P4

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

- **The unit-test count in `README.md` is a hand-maintained number.** It said 233 when the
  suite had 235; it had drifted across two releases before anyone read that line. A static
  guard would be wrong, because many tests are generated inside loops (172 literal `test(`
  calls produce 235 tests) — `test/config.test.ts:66` wraps one `test()` in a `for` over
  five bad hostnames, and `test/guide.test.ts:52` does the same over five helper members.
  Counting the source does not answer the question. Either parse `bun test` output in a
  guard, or drop the number.
  **Priority:** P4

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

- **`guide.md` never says the iframe canvas is white.** `src/shell/shell.css:205` sets
  `background: #fff` and explains why; no agent will ever read that file, and `guide.md`
  mentions it zero times. The reporter wrote `@media (prefers-color-scheme: dark)` to lighten
  the text, left the background alone, and shipped near-white text on white to a real person.

  **P1, not cosmetic.** The author cannot self-detect this: they test in light mode, it looks
  correct, and the person who suffers it has no channel back. `/r/` exists to close exactly
  that asymmetry and does not cover rendering. In the 2026-08-19 session it surfaced only
  because the human typed "el contraste está mal" into a notes field; had they closed the tab,
  the agent would have kept shipping unreadable pages.

  One sentence in section 2: the frame you publish into is always white, in every theme; if
  you want a dark page, paint `html` and `body` yourself.
  **Priority:** P1

- **No curl example for `PUT /api/docs/:id/state`.** The four blocks in `guide.md` cover
  create (53), content (73), `/r/` (211) and webhook (245). State is the endpoint an agent
  calls most and the only one with an `If-Match` precondition; the reporter guessed
  `{"state": {…}}` and said so.

  The absence caused a second, worse failure: the same reviewer reported "no ETag on reads" as
  a finding, having read the JSON body and never the response headers. The ETag is there and
  round-trips. **A missing example made a careful reviewer misdiagnose a working feature.**
  Show `-H "If-Match: $ETAG"` echoing the header verbatim, which closes both gaps in four
  lines.
  **Priority:** P2

- **`guide.md` does not say the iframe has no viewport.** `shell.css:61-62` records that the
  shell scrolls and the frame never does, sized to content height. The consequence is stated
  nowhere: `position: sticky`, `position: fixed`, `100vh` and scroll-driven effects do not work
  inside a document. The reporter shipped a sticky table header that pins to nothing. One line
  in the "two things to know" block, beside the no-network warning — same category, a
  capability an author would reasonably assume and silently does not have.
  **Priority:** P2

- **The array-label rule is undocumented.** `guide.md:199` and `:337` tell authors to leave
  `_vid` alone, but never state how an event gets its name: `labelOf` (`src/events.ts:162`)
  takes the element's **first string-valued property**, truncated to 40 characters. That rule
  is why a log stays readable a week later, and authors should know it so they put the
  human-meaningful field first when designing their state shape.
  **Priority:** P2

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
