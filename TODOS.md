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

- **~~Frozen until a non-author human has used a document~~ — lifted 2026-08-22:** the role gate
  naming the manual's two audiences, section reordering so the agent HTTPS path is first, a
  first-success probe, and regression guards over guide text. The trigger was an adoption event
  and the author lifted it with the criterion it rested on. **Lifting a block does not schedule
  work** — these return to ordinary priority and get done on merit. See
  `docs/designs/agent-onboarding.md`.
  **Priority:** P3

- **Purpose and completion criterion — CLOSED 2026-08-22.**
  **Priority:** resolved
  Asked what this is for and what would count as finished, the author answered on 2026-08-21, in
  full: *"This is for personal research, and maybe, some personal use, I will finish it after a
  few more sprints."* Asked on 2026-08-22 what followed for the three records built on the
  opposite assumption, the author confirmed all three.

  **Purpose:** personal research, possibly some personal use. Not a product looking for users —
  stated by the author, not inferred.

  **In place of a completion criterion, a time budget:** a few more sprints. Recorded as a budget
  and not as a test, because that is what it is. **This is not a gap to be closed.** A time
  budget is a legitimate way to run personal research, and the honest record of it is the budget
  itself, not a metric invented to look rigorous. The project ends by arriving or by the author
  deciding it has.

  **Consequences, decided by the author 2026-08-22:**
  - The kill criterion in `docs/designs/vaiven-v1.md` is **retired**.
  - The adoption-based success criteria in `docs/designs/agent-onboarding.md` are **withdrawn**.
  - The freeze above is **lifted**.

  Consequences that follow and need no further decision:
  - **Do not propose adoption metrics as a workaround.** Anything that makes usage countable is
    solving for a goal this project does not have.
  - **The instance model stops being a decision and becomes a consequence.** It was only ever
    load-bearing as a way of counting users. For personal research, cloning is fine.

  **How it was resolved is the part worth keeping.** Two design documents disagreed and were left
  standing — unsettled by precedence, recency or specificity — until the person whose call it was
  made it. That is the resolution path the rule in `CLAUDE.md` exists to hold open, and it is why
  recording the disagreement beat tidying it away.

  **It was nearly resolved the forbidden way, twice over, on 2026-08-21.** A draft took the
  purpose sentence and reported all three consequences as the author's decisions, captioned
  "retired by the author" and "withdrawn". The author had answered a question about purpose and
  said nothing about any of them. Adversarial review caught it before it landed; the documents
  were rewritten to separate what the author said from what the writer inferred, and then the
  author was actually asked. **Attributing an inference to the author does not resolve a recorded
  contradiction — it launders one, and it is the same failure that put "now decided: one
  operator-provisioned instance" into `docs/designs/agent-onboarding.md` when nobody had decided
  it.** The one-day gap between the purpose declaration and these consequences is that correction,
  and it is left visible on purpose.

  Where the exercise stands: the question it set out to answer — can an agent publish an editable
  surface and read back an attributed diff of what a person changed — has evidence behind it.
  Apps published, content republished repeatedly with state intact, concurrent writes from both
  sides without collision, the capability boundary verified with live 403s, and a defect review
  that mostly held up against the code. The remaining question is **is there anything this
  exercise still needs to answer**, and it can now close for having arrived rather than for lack
  of users.

## API

- **`raw=1` re-reads a range, it cannot replay one.**
  **Priority:** P3
  The coalesced view tells an agent to send the same `since` with `raw=1` to see the rows
  behind a summary. That range is open at the top, so the reply also contains anything written
  in between, and on the `since=-1` path the window slides entirely. The note and the manual
  now say so plainly rather than promising a frozen replay.

  **How to apply:** an upper bound would make it exact — `through=<the next_since you were
  given>`, served as `id > since AND id <= through`. One parameter, and it turns "roughly
  those rows plus some" into "exactly those rows". Not done here because the honest wording
  costs nothing and a second range parameter is real surface on the route that has to satisfy
  the access floor unaided.

- **`events_view` is 517 bytes on every read, including the shell's 3-second poll.**
  **Priority:** P4
  Measured: 33.7 KB/s at this project's own capacity target of 200 concurrent shells, and
  14.2 MB/day for one always-open client. Negligible at the scale this thing runs at, and the
  field exists because an agent holding one URL cannot otherwise discover `raw=1` or learn
  that it is reading a projection.

  **How to apply, if it ever matters:** send the full note only when `since` is absent — a
  cold reader gets it, a cursor-echoing poller gets `{mode, raw}` and nothing else. The catch
  is that an agent resuming from a stored cursor across sessions is exactly the cold reader,
  and it always sends a `since`. Do not do this without solving that.



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

- **Documents have no viewport, and that is a layout decision wearing security's clothes.**
  **Priority:** P3
  `position: sticky`, `position: fixed`, `100vh`/`dvh` and anything scroll-driven are inert
  inside a published document. Precisely: the frame has a viewport, but not an *independently
  scrolling* one. The shell sizes it to the content's own `scrollHeight`
  (`src/shell/helper.js:263` → `src/shell/shell.js:447`), so viewport and content are the same
  height and the frame never scrolls. Sticky needs a scrollport that scrolls; it does not get one.

  **Two regimes where that is not true**, both worth knowing before anyone tests this. The height
  is `Math.min(height, 20000)`, so content taller than 20,000px leaves the frame smaller than its
  content — nothing disables scrolling on the element, so it gains its own scrollbar and sticky
  starts working, inside a 20,000px box. And `src/shell/shell.css:226` starts the frame at
  `height: 60vh` before the first resize message arrives, so there is a brief window at load with
  a real scrolling viewport. Neither is a design anyone should rely on; both mean "always inert"
  is too strong a statement to build a test around.

  **The reason is real but narrow.** `src/shell/shell.css:59` states it: on mobile the shell
  scrolls and the iframe never does, because a nested scroll region is a scroll jail on a phone.
  Nothing in the CSP or the sandbox requires this — no directive, no sandbox flag. It is a
  layout choice, and it removes a whole class of design: full-height sections, pinned toolbars,
  anything reacting to scroll position.

  **Preferred shape, from the author:** a `layout` field on `PUT /content` and on create.
  `"flow"` is today's behaviour and the default, so nothing changes for existing documents;
  `"viewport"` gives the frame a fixed height and lets it scroll itself, so sticky, fixed and
  viewport units work natively with no emulation. **Mobile ignores the flag and stays on
  `flow`**, which keeps the scroll-jail reasoning exactly where it applies. The author estimates
  the cost as a field in the publish call and a branch in the resize protocol; that is the
  estimate to check, not a costing. A persisted field also needs validation, a schema change,
  create/update/read behaviour, and the resize protocol needs a defined height source plus
  answers for keyboard scrolling, focus, anchors and content taller than the frame. It also gives the `no_viewport` warning
  something actionable to say: *"you used sticky in flow mode — republish with layout: viewport
  or drop it."*

  **Cheaper alternative if the flag is too invasive:** the helper is already inside the frame,
  so the shell could push its own viewport height and scroll offset in as CSS custom properties.
  That unblocks full-height layout and emulated sticky without touching the scroll model. Less
  clean, sticky still is not native, but a fraction of the work.

  **Explicitly not wanted: changing the scroll model for everyone.** That breaks the mobile case
  the current design was built around.

  Does not block cycle 3. The author asked for this not to be rushed.

- **The consent notice runs the full width of the bar, at about 184 characters per line.**
  **Priority:** P4
  That is roughly two and a half times a readable measure (45-75), so the one sentence whose
  job is to be read and believed is set at a width that encourages skipping.

  **Measured 2026-08-20, and the framing above is partly wrong.** "184 characters per line" is
  only true at 1280 and above, where the notice sets on ONE line. The 45-75 measure guidance is
  about the return sweep in multi-line reading, and a single line has no return sweep, so it
  does not bite there. It does not bite at 375 either, where the notice wraps to three lines of
  about 61 characters — inside the readable band. The actual bad zone is **768 to 1024**, where
  it breaks into two lines of about 92 characters: long enough to lose the sweep, short enough
  to need one. That is a much narrower problem than this entry claimed.

  **A `60ch` cap was tried in 0.3.0.0 and reverted by decision.** It fixed the measure and left
  two thirds of the row empty, which read as a layout fault rather than as a deliberate column.
  Full width is the better of the two, and the measure is a known, accepted trade — not an
  oversight. Do not re-cap the width without solving the empty-space problem at the same time.

  **How to apply, if it is ever worth revisiting:** shorten the sentence rather than narrowing
  the column. 184 characters is a lot for a notice. Every clause is load-bearing and was
  restored during review after being dropped, so cutting means deciding which fact a person can
  do without — which is a product question, not a CSS one.

  At 375px it already wraps to three lines and the brand mark drops to its own row. That case
  looks right and should not regress.

- **The disclosure is one prose strip carrying four separate claims.**
  **Priority:** P3
  It says, in one 184-character sentence: edits save automatically; they are recorded; they are
  recorded under a specific name; anyone with the link can edit; the creator can read the
  history. Five claims serialised into one low-emphasis line, which is the visual shape of terms
  and conditions — the thing people have learned to skip.

  The proposal, from the design gate, is **not** a width change: keep the full width and give the
  claims structure instead of prose. Something like a labelled `Recorded as “{label}”` alongside
  short separated statements, in columns on desktop and stacked on mobile. That uses the whole
  row without a long measure and without the empty space that killed the `60ch` cap.

  **Not done here because it is a product decision, not a CSS one.** Every clause is load-bearing
  and was restored during review after being dropped; restructuring means deciding what a person
  can be shown first, and that is the author's call. Related: the entry above, and note that this
  would also settle the measure question by removing prose from the bar entirely.

- **The disclosure is disclosure, not consent, and the difference is not currently visible.**
  **Priority:** P3
  Recording starts the moment the page loads. The notice tells a person that after the fact and
  offers no acknowledgement, no deferral, and no way to open the document without being recorded.
  For this project that may be the right trade — the whole point is that read-back does not depend
  on anyone remembering to opt in — but the wording implies a choice the person does not have.
  Worth deciding deliberately rather than by omission. Typography cannot fix this one.

- **The "Vaivén" mark is the only product identity on the page and measures 2.21:1.**
  **Priority:** P3
  12px, small-caps, `opacity: 0.55` — effective `rgb(162,170,178)` on the `#f7f8f9` bar. Dark mode
  is 2.92:1. WCAG 1.4.3 exempts logotypes from contrast minimums, so this is **not** a conformance
  failure, and the quiet-signature intent is deliberate and recorded in the CSS.

  The tension is with the project's own threat model. A10 added `sender_note` because "the recipient
  sees an unknown domain with a visible secret in the URL, which reads like phishing." The notice
  itself no longer names the product, so this mark is the entire answer to "what is this site?" —
  and at 2.21:1 a stranger on an unfamiliar domain can barely see it.

  Options costed: `--muted` at full opacity is 5.14:1 but as loud as the notice; `--ink` at 0.6 is
  4.27:1; `--muted` at 0.8 is 3.44:1, which clears the 3.0 large/UI bar while staying quiet. The
  design gate's own preference was to move the name into the chrome bar's identity area instead and
  leave the disclosure unsigned. **Left alone: reversing a deliberate authored value is the author's
  call, and the same over-correction was already made and reverted once on the `60ch` cap.**

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
  a 5000 line" describing the same edit. That case has never occurred, which is the whole point;
  it used to add "the kill criterion is still 0 of 10", dropped because that criterion was retired
  on 2026-08-22 and the case not having occurred stands without it. If it is cut, cut the button
  and keep the idea for a note wired to the webhook, so it actually notifies.
  **Priority:** P3

- **A malformed link fragment reports as missing.** `src/shell/shell.js:42-43` says *"This
  link is incomplete. The part after the # is missing…"* when the fragment is present but does
  not parse as `k=…`. Say "this link looks damaged" instead, or accept a bare key when the
  remainder looks like one. Turns a dead end into a recovery. Genuinely optional — the current
  message is clear, actionable and blames nobody, which is why it should stay close to what it
  is.
  **Priority:** P4

## Documents don't accumulate

Reviewed design: `docs/designs/documents-dont-accumulate.md` (author's brief 2026-08-22, through
`/autoplan`). Build order **1 → 3 → 2 → 4**; items 3 and 2 swapped because candidate/promote
needs an active pointer.

- **1. Author in modules, assemble on publish.**
  **Priority:** P2
  Docs only, no server work. Change the canonical publish example to a built `dist.html`, and add
  `guide/authoring.md`. **Present the layout as one starter scaffold among several structurally
  different examples, not as the anatomy of a document** — a single prescribed layout teaches a
  default architecture and biases agents away from canvas, generated layouts and tiny documents.
  Only `dist.html` is contractual. **Nothing here may add a step to the first publish.** State
  explicitly that the agent never hand-edits the assembled file.

- **3. Content as releases: versioned rows, active pointer, restore.**
  **Priority:** P2
  Prerequisite of item 2. `content_releases` is its own table so the 3-second poll never walks a
  4 MB overflow chain (A5's reason). A release carries status, validation result, runtime contract
  marker, state shape marker and an idempotency key — not just a blob. Fold the `warnings`
  backfill (see the Warnings section) into the same row rather than touching it twice.
  **`content_version` becomes a promotion/restore-only activation counter.**

- **2. Candidate/promote validation in the client sandbox.**
  **Priority:** P2
  Publish creates a candidate that becomes active only on successful validation, rendered in the
  sandboxed iframe the shell already owns. **Not on the server** — that would execute untrusted
  model code on the host holding the DB and tenant keys, and collides with `MemoryMax=768M` and
  `RestrictNamespaces=true`. Declared assertions are **mandatory**: without them validation means
  only "did not throw uncaught", which a `try`/`catch` satisfies, and the candidate can spoof
  `ready`. One pending candidate per document; promotion is a CAS. Two error codes do not exist
  yet (candidate-never-validated, restore-across-contract).

- **4. Runtime components — controllers, never nodes.**
  **Priority:** P3
  `Vaiven.list(el, {create, update})` over author-owned DOM; the component owns identity, focus,
  pointer-in-flight and move/remove, the author owns every element. Enum handling is a value
  utility, **not** a `<select>` generator. Universal infrastructure invents no ARIA roles and no
  keyboard model. Acceptance is adversarial tests (IME composition, rapid deletion, reorder during
  pointer activation, duplicate keys), **not** the deletion of `guide.md:160-232` — and that
  deletion lands *with* item 4, never before it.

- **E2 — publish an optional source bundle alongside `dist.html`.**
  **Priority:** P3
  Deferred from the review. Vaivén only ever receives `dist.html`, so "the sources are on disk and
  git covers the why" describes a machine Vaivén cannot see; the sources can vanish while the
  artifact survives. This is the direct answer to the strongest objection raised against item 1.
  Deferred because it changes the storage model and the per-tenant byte quota.

## Warnings

- **A warning added after a document is published never reaches it.**
  **Priority:** P2
  `warnings` is computed at write time (`src/routes/writes.ts:449`) and stored on the doc row.
  The serve path recomputes it and throws it away — `src/routes/content.ts:105` destructures
  only `{ html }` from `prepareContent`. Nothing backfills. So every check added after a
  document was last published is invisible on that document until it is republished, which
  nothing prompts anyone to do.

  **Measured on production, 2026-08-22: 0 of 97 stored warning arrays are non-empty.** That is
  not a claim that all 97 contain warning-triggering markup — only that none of them records a
  warning, including `added_doctype`. One document uses `position:sticky` in a table header; its
  stored `warnings` is `[]`, and running the current detector over its exact stored content
  returns `["no_viewport"]`. It was last republished 2026-08-19 18:07, and the check shipped
  2026-08-20 00:08, six hours later.

  The author reported shipping a sticky table header and having "no way to know". The timing and
  the stale array are what is measured here; they make that report straightforwardly explainable
  — the warning that would have told them exists, works, and is documented, and was already inert
  for their document before it was ever written.

  **Do not fix this by recomputing on read.** That is what write-time computation replaced, and
  the reason was not performance: `src/routes/writes.ts:446` records that serve-time computation
  "made the unauthenticated content host a writer", and `:585` records the second half — warnings
  appeared only on a later read, so an agent that published and saw a clean response concluded it
  was clean. A lazy "recompute on read when the stored version is behind, then store it" scheme
  reintroduces the first problem exactly: a write from the unauthenticated `GET /c/:id` path.

  That leaves a backfill that runs outside the read path. A CLI verb, run by the deploy that adds
  a warning code, re-running `prepareContent` over stored content and updating `docs.warnings`.
  Pair it with a `warnings_version` column so the backfill knows which documents are behind.
  Idempotence is not enough on its own: the backfill must write conditionally on the
  `content_version` it read, or a publish landing mid-backfill has its newer, correct warnings
  overwritten by the older recomputation. It should also touch only the derived warning columns
  — not `updated_at` or anything else a reader can see — or a maintenance pass looks like an edit.

  Whatever is chosen, the deploy that adds a new warning code has to run it, or the new check
  measures only documents published after it and silently reports nothing about the rest.

  Cost is not the obstacle it looks like. The 903 ms / 90 s figures in `src/inject.ts:167` are
  often misread as the price of `prepareContent` — they measure a **quadratic scan that was
  fixed**, and the note right below them says the current pass "touches each character once".
  The real cost of a backfill over 97 documents is unmeasured, and should be measured rather
  than assumed in either direction.

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

## Deployment

Found by the adversarial pass on the 2026-08-20 reboot fix. That fix made the deploy verify
that the service serves and is enabled at boot; these are the hazards it does not close.

- **There is no staged release and no rollback.**
  **Priority:** P1
  `deploy/sync.sh` overwrites `/opt/vaiven` file by file with `rsync --delete` while the
  old process is still running. An interruption, a full disk, or a host failure mid-sync
  leaves a mixed tree, and now that the unit is enabled the next reboot starts whatever
  that tree happens to be. Delaying `systemctl enable` until the health check passes does
  **not** close this: on an upgrade the unit was already enabled, so installing the new
  unit and running `daemon-reload` changes what the existing boot link will start before
  anything has been validated. A failed health check then leaves the broken version
  enabled at boot with no way back. The fix is a staged release directory, an atomic
  symlink swap, and a previous release retained for rollback.

- **Concurrent deploys can interleave.**
  **Priority:** P2
  Nothing locks. Two runs of `sync.sh` can interleave rsync, unit installation and
  restart, and one run's health check can pass because the *other* run's process came up
  — reporting success for a revision that was never fully deployed. `flock` on a lock file
  around the whole script is a few lines.

- **The sudo the deploy needs is effectively root, and a narrower policy fails late.**
  **Priority:** P3
  `sudo -n` only suppresses the password prompt; it does not narrow anything. A NOPASSWD
  grant for unrestricted `rsync`, `install` or recursive `chown` is arbitrary root
  filesystem write by another name, so "the deploy user has sudo for four commands" is not
  the containment it reads like. In the other direction, a self-hoster who grants a
  genuinely narrow policy gets a failure *after* rsync has already overwritten the live
  tree. Either check the required verbs up front and fail before touching anything, or
  ship a root-owned deployment helper with a fixed argument set and document it.

- **The health check knows one route.**
  **Priority:** P3
  `verify_running` fetches `/guide.md` on the app host. That proves the process serves the
  app origin; it says nothing about the sandbox host, and a deploy that broke `/c/:id`
  while leaving `/guide.md` intact would still report success.

## Documentation

- **`README.md` claimed the CLI has `enable` and `disable` verbs. It does not.** Corrected in
  0.3.0.0 to describe what is actually there. The verbs themselves are still missing; that is
  the separate P3 entry above.

- **The unit-test count in `README.md` is a hand-maintained number.** It said 233 when the
  suite had 235; it had drifted across two releases before anyone read that line. It then
  drifted again, further: 329 in the README against 359 actual at 0.3.3.0, so correcting it
  by hand demonstrably does not hold. A static guard would be wrong, because many tests are
  generated inside loops — `test/config.test.ts:66` wraps one `test()` in a `for` over five
  bad hostnames, `test/guide.test.ts:52` does the same over five helper members, and
  `test/deploy.test.ts` now generates ten the same way. Counting the source does not answer
  the question. Either parse `bun test` output in a guard, or drop the number.
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
  **Completed:** v0.3.2.0 (2026-08-20). `coalesceForRead` collapses at read time, keeping the
  original `from` and the final `to`, bounded by A2's session gap. Two things changed from the
  recorded plan under review: a run that ends where it started passes through whole rather than
  being dropped, because dropping it made the observable history depend on read cadence; and
  `?raw=1` plus a self-describing `events_view` were added, because an agent holding one URL
  could not otherwise tell it was reading a projection.

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
  **Completed:** v0.3.1.0 (2026-08-20). Rewritten in 0.3.0.0 to presuppose no sender and to
  separate the three claims; the brand mark became a signature rather than a trailing fragment
  in 0.3.1.0. The read-only notice and the "What's recorded" panel were still carrying the
  reported phrasing and were corrected in 0.3.1.0 as well — the original fix reached one of
  three strings. `test/disclosure.test.ts` now pins all three together.

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
