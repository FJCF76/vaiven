# Changelog

All notable changes to Vaivén are recorded here. Versions are `MAJOR.MINOR.PATCH.MICRO`.

## [0.3.4.0] - 2026-08-22

The author said what this is for, so three rules that measured the wrong thing are gone.

### Changed

- **The kill criterion is retired, the adoption-based success criteria are withdrawn, and the
  non-author-use freeze is lifted.** All three assumed success meant people other than the author
  using Vaivén. Asked what the project is for and what would count as finished, the author
  answered: **personal research, and possibly some personal use, finishing after a few more
  sprints.** A criterion counting humans who are not the author cannot measure that. It would
  have read zero at day 30 whether the work had succeeded or failed.

  Nothing counting anything replaces them. Anything that makes usage countable is solving for a
  goal this project does not have. In place of a completion test there is a time budget — a few
  more sprints — recorded as a budget rather than dressed up as a metric, because that is what it
  is. Lifting the freeze removed a block; it did not schedule the five onboarding items it held.

  The P1 that carried this closes. The instance-model question closes with it: it was only ever
  load-bearing as a way of counting users, so for personal research cloning is fine.

- **How it was resolved is recorded alongside what was resolved.** Two design documents disagreed
  about what success meant. They were left standing, unsettled by precedence, recency or
  specificity, until the person whose call it was made it — which is the resolution path the rule
  in the working notes exists to keep open.

  A draft of these edits took the author's one sentence about purpose and reported all three
  consequences as their decisions, captioned "retired by the author". They had decided none of
  them; they had answered a question about purpose. An adversarial review pass caught it, the
  documents were rewritten to separate what the author said from what was inferred, and then the
  author was actually asked. **Attributing an inference to the author does not resolve a recorded
  contradiction — it launders one**, and it is the same failure that once put a never-made
  instance-model decision into `docs/designs/agent-onboarding.md` as settled. The near-miss is
  left visible in `TODOS.md` and in both design docs rather than tidied away, because a guard is
  only worth anything if you can see it catching something.

## [0.3.3.0] - 2026-08-21

The site did not come back after a reboot, because the deploy had never enabled it.

### Fixed

- **`deploy/sync.sh` enabled the backup timer and never the service it backs up.** The unit
  file has carried `WantedBy=multi-user.target` since Phase 0, but `WantedBy` does nothing
  until `systemctl enable` creates the symlink, and the deploy only ever ran `restart`. So
  the unit sat at `disabled` on the production host from the first deployment onward.

  `Restart=always` hid it completely. It covers crashes, not boots, so the service recovered
  from everything that ever happened to it and looked healthy for as long as the box stayed
  up — which was every day between Phase 0 and 2026-08-20. On the first reboot, Caddy came
  back (its unit *is* enabled) and served 502 to an upstream that was never started.

  A deploy now enables the service and then refuses to claim success unless the unit really
  reports `enabled`.

### Changed

- **The deploy verifies what it claims, instead of asserting it.** Three checks that each
  looked fine and each accepted a broken host:

  `systemctl is-enabled` exits 0 for `static`, `enabled-runtime`, `indirect` and `generated`
  as well as `enabled`, and of those only `enabled` starts a unit at boot. Verified on this
  host: `vaiven-backup.service` has no `[Install]` section at all and `is-enabled --quiet`
  still exits 0 for it. The check compares the reported state now, rather than trusting an
  exit code that answers a different question.

  `is-active` says the process launched, not that it answers. `Type=simple` reports success
  the moment `ExecStart` execs. The deploy now fetches `/guide.md` from the bind address and
  requires HTTP 200 — `curl -f` alone exits 0 on a 3xx, so a redirect away from the app used
  to count as serving.

  One good response also proves very little, because `Type=simple` with `Restart=always`
  means a service that dies and respawns can be sampled while it happens to be up. The check
  asks twice, longer than `RestartSec` apart, and reports a restart loop if the second
  request fails.

- **A failed deploy is no longer written into the boot path.** `enable` runs only after the
  service has proved it serves, so a deploy that comes up broken is not also configured to
  come back broken. This does not cover the upgrade case, where the unit was already enabled;
  that needs staged releases and rollback, which `TODOS.md` now records as P1.

- **`restart` is guarded rather than left to `set -e`.** A failed start exited the script
  before the `journalctl` dump ran, so the one thing that said *why* never printed.

- **An incomplete config names the missing key.** Previously a missing `VAIVEN_APP_HOST`
  produced `not serving http://:/guide.md as `, which names nothing.

### Added

- **`deploy/sync.sh --verify-only`** checks a host without deploying to it: is it serving,
  and will it come back after a reboot. It needs no `sudo` when the config is supplied
  through the environment, which is also what lets the checks be tested.

- **`test/deploy.test.ts`** executes those checks against a stub `systemctl` and `curl` on
  `PATH`, covering `enabled`, `disabled`, `static`, `enabled-runtime`, `indirect` and an
  empty state, non-200 responses, a service that answers once and then dies, an IPv6 bind
  address, each missing config key, and a junk retry budget. The `curl` stub records its own
  arguments, because a stub that ignores them passes just as happily when the script drops
  the URL or the `Host` header.

## [0.3.2.0] - 2026-08-20

Typing one word with corrections stored seven events. It now reads back as one.

### Changed

- **Adjacent edits collapse when they are READ, not when they are written.** In a real
  session `cliente` went `Clienet ` → `Clienet` → `Cliene` → `Clien` → `Clienter` →
  `Cliente` → `Cliente1`: seven stored events, six carrying nothing a reader wants. A1 already
  coalesces per field per flush, but the flush fires when the write pipeline builds a PUT, so
  any pause mid-word ends a batch. That works directly against `next_since`, which exists to
  stop histories crowding out an agent's context.

  Nobody reported it for two releases because **an agent reading its own diffs never types
  with backspaces**. Only a human does, and the human has no channel to report it.

  Read time rather than write time, deliberately. A1 chose eager flushing because people close
  tabs rather than tab out. Widening the flush window would trade log cleanliness against
  durability; collapsing on the way out trades nothing, and every history already stored
  benefits without anything being discarded at ingest.

  **What merges:** adjacent edits by one actor to one field, each no more than ten minutes
  after the one before — measured pairwise, so a run can cover an afternoon and several
  versions — and continuous in value. `from` is the value before the first; `to`, `id`,
  `version` and `at` come from the last; `stored_events` says how many it stands for. One
  summary is not one thing a person did.

  **What never merges:** annotations of any kind, array element events (two adds are two
  elements), different actors, different fields, missing endpoints, rows carrying `note`,
  `payload` or `item`, timestamps that go backwards, and any pair where the previous `to` is
  not the next `from` — merging that last one would report a transition that never happened.

  **A run that ends where it started is not merged at all**; its events pass through as
  stored. Dropping it made the observable history depend on read cadence: zero events for an
  agent reading afterwards, two for the shell, which polls every few seconds.

### Added

- **`?raw=1` returns the stored log**, on both read surfaces. It takes `raw=1` and nothing
  else; a different spelling is a `400` naming the field rather than a quiet projection,
  because an agent handed a summary when it asked for the record cannot tell.
- **`events_view` on every read** says which view you have, how to reach the other, and the
  cursor rule. An agent holding one URL cannot invent `?raw=1`, and a projection it cannot see
  is one it will mistake for the stored record. Same reasoning that made `untrusted` a
  sentence instead of a boolean.

### Fixed

- **The cursor query had no index that served it.** A5 added `events_since(doc_id, version,
  id)` when the cursor was a version; A8 made it an event id and nobody re-checked, so with
  `version` between the constrained prefix and the ordering key SQLite walked the rowid across
  every document's events and filtered. Measured on 40,000 events across 50 interleaved
  documents, this project's own capacity target: `?since=0` 1.996ms → 0.587ms, a recent cursor
  0.031ms → 0.009ms. Both 3.4x, entirely from no longer reading fifty documents to serve one.
  No gain at all on a single-document database.

### Notes for anyone integrating

`next_since` is computed from the stored rows before any collapse and is identical in both
views. Echo it; never build a cursor from an event's `id`. `raw=1` with the same `since` is a
re-read of an open range, not a frozen replay — it also returns anything written in between.

## [0.3.1.0] - 2026-08-20

A consent notice that could be rewritten by the person it protects the reader from, a CSS rule
that had been dead in production for two releases, and the guards that would have caught both.

### Fixed

- **A key label could rewrite the consent notice that renders it.** The label is chosen by
  whoever holds the tenant key — the same party the notice tells the reader can read their edits
  back — and it was interpolated into the sentence inside quotation marks with nothing but a
  length clamp. A label of `Alice”. Your edits are private and are not recorded. “` rendered, in
  the shell's trusted chrome, as a promise this system does not make. `textContent` and the CSP
  stop script; neither stops meaning.

  Three changes, because the first two only make it visible: the name renders in its own
  element, so anything smuggled in stays inside the name; `requireLabel` removes the
  double-quote characters the notice is delimited with, straight and curly, so a name cannot
  close its own quote; and `requireWithin` strips bidi overrides, isolates, zero-width
  characters and the BOM from **every** human-facing string, before the length check rather than
  after.

  **Observable to callers:** a label you send may not be the label you get back. `say "hi"`
  stores as `say hi`. Apostrophes are untouched — O'Neill and D'Angelo are names. This is why
  the release takes a version line rather than a patch number.

- **A deleted selector had been silently discarding the rule below it since 0.3.0.0.** Removing
  the Done dialog took `.panel-body textarea {` with it and left ten declarations with no
  selector. That is not inert: the parser consumes forward to the next `{`, folds what it passed
  into an invalid prelude, and drops that rule. `.panel-body > p` was underneath, so the
  "What's recorded" panel's own explanatory paragraph rendered at the wrong size for two
  releases. The file carried a brace depth of -1 the whole time and nothing was counting.

- **Two of the three consent strings still named a sender the reader may not have.** The first
  person to use the system opened their own document and answered "nobody sent me a link". That
  fix reached the write notice and stopped; the read-only notice and the panel kept the reported
  phrasing. They were also wrong rather than merely confusing — `last_seen` and the event log
  are tenant-scoped, so the party who can see them is the document's creator, not whoever
  forwarded a link. All three now name the creator.

- **An 80-character unbroken name scrolled the whole shell sideways on a phone.** The notice
  interpolates a caller-chosen label clamped only at 80 characters, and a flex item will not
  shrink below its min-content width. Measured at 375px: 812px of scroll before, none after.

### Changed

- **The consent notice runs the full width of the bar.** The `60ch` cap tried in 0.3.0.0 fixed
  the line length and left two thirds of the row empty, which read as a layout fault. Reverted
  by decision; the long measure is a known, accepted trade.

- **The brand mark anchors to the end of its line at every width.** `align-self: flex-end` only
  positioned it while the notice wrapped. Above 1050px the notice fits one line, flex-end *is*
  that line, and the mark went back to trailing the sentence with 220px of empty bar at 1280 and
  540px at 1600. `margin-inline-start: auto` fixes it in both directions, including RTL.

### Added

- **`test/disclosure.test.ts`** pins all three consent strings together, bounded at both ends and
  checked for uniqueness, plus a whole-file scan for a fourth string reintroducing the retired
  phrasing. The first draft of this guard was picked apart by an adversarial pass — it matched
  the first occurrence of a phrase without proving uniqueness, sliced to the next newline rather
  than the end of the sentence, and compared case-sensitively.

- **`test/stylesheet.test.ts`** checks brace balance, top-level orphaned declarations, empty
  preludes and unterminated comments. Verified against `df7a319:src/shell/shell.css`, the commit
  that introduced the defect, rather than asserted: that file trips two of the four checks.
  Strings are blanked alongside comments so `content: "{"` is not a false positive.

### Documentation

- **An instance-model claim asserted as decided was withdrawn.** `agent-onboarding.md` said the
  question at `vaiven-v1.md:953` was "now decided: one operator-provisioned instance". It was
  not. The question stays open.

- **The P1 became "purpose and completion criterion are undeclared".** The recorded kill
  criterion counts documents used by non-author humans, which assumes adoption is the measure of
  this project. It is not. That document's success criteria and the P1 now contradict each
  other, and the contradiction is written down in both rather than settled by precedence.

## [0.3.0.1] - 2026-08-20

Documentation catch-up for 0.3.0.0, and one gap that release created.

### Added

- **The warning vocabulary is documented, in `guide/errors.md`.** 0.3.0.0 started emitting
  `dark_mode_no_background` and `no_viewport` on every read, and named neither anywhere an
  agent could look. The manual says to branch on `code` rather than on the message, which is
  only possible if the codes are written down. All five are now listed, including the three
  that predate this release and had never been documented either.

### Fixed

- **`README.md` said the CLI has `enable` and `disable` verbs.** It does not, and never has —
  the schema has the `disabled` column and the resolver honours it, but nothing in the CLI can
  set it. The README now describes what is actually there; the missing verbs stay recorded in
  `TODOS.md`.
- The unit-test count said 235 against a 270-test suite, and the docs table was missing
  `docs/designs/agent-contract.md`.

## [0.3.0.0] - 2026-08-20

A third-party agent built two documents against this instance and wrote up what broke. Most
of what follows is not what it reported. It is what the reviews found while fixing what it
reported.

### Fixed

- **A minted key came back with no URL, so an agent built one and a person got a dead link.**
  `POST /api/docs/<id>/keys` answered with `{id, label, role, key}`. The agent needed a link
  to send someone, wrote `#<key>` instead of `#k=<key>`, and sent it. The response now carries
  the URLs the key can open: `view_url` for both roles, and `read_url` too for a read key,
  which really does answer at `/r/`. A write key deliberately gets no `read_url` — it is not
  a read key and that URL would 404.

  `src/urls.ts` has said *"never make the agent construct a URL"* at the top since the first
  release, and that did not stop three instances of exactly this. Review found a fourth, in
  the CLI. So the rule is now the type system: minted secrets are a `KeyMaterial` with a `#`
  private field, `tsc` rejects putting one where a string belongs, and if one ever does reach
  a response body `toJSON` emits `"[redacted]"` rather than the key.

- **An unauthenticated request could stall the whole instance for about two and a half
  minutes.** Content is scanned when it is published and when it is served, and the scan was
  quadratic on unterminated `<style>` tags: 200,000 of them is 1.4 MB, inside the 4 MB cap,
  and took 148 seconds. `GET /c/<id>` needs no credential and the process is single threaded,
  so that is not a slow read for one person, it is downtime for every tenant, repeatable.
  Measured after the fix on the same payload: **7 ms**.

  Two earlier versions of that scan were also quadratic, on two other shapes. All three shapes
  are now regression tests.

- **`vaiven key add --role admin` silently minted a WRITE key.** Any unrecognised role fell
  through to write. The HTTP route rejected it properly; the CLI, which is how an operator
  hands a real person a link, failed open toward more privilege.

- **The consent notice named a sender who often does not exist.** It said edits were "shared
  with whoever sent you this link". The first person to actually use this system opened their
  own document and answered: *nobody sent me a link.* Every clause now holds for a stranger
  with a write link, a stranger with a read link, and the author opening their own document.
  It also stopped claiming that nothing a read-only viewer does is recorded, which was never
  true: opening a read link records a time and a coarse address, so a leaked link is
  observable at all.

### Added

- **The server now tells you when your page will render badly**, in `warnings`, at publish
  time. Two things an author cannot see for themselves: a dark-mode block that never paints a
  background, which ships light text on a white canvas; and viewport units, `position: fixed`
  or `position: sticky`, in a frame that has no viewport and is grown to your content instead.
  `100vh` there is circular and runs away until it is clamped.

  These were going to be sentences in the manual. The manual is fetched once, before any HTML
  is written, and these bugs are found by the person who opens the document — who has no way
  to tell you. A warning arrives where the agent is already looking.

- **`Vaiven.note(text, payload)`**, the honest name for `Vaiven.log(kind, payload)`, whose
  first argument was never a kind: it travelled as note text and the event always read back as
  `kind: "note"`, so filtering on what you passed never matched. `log()` is kept and works
  forever — published `content` is served as written and never rebuilt, so every document
  already calling it must keep working.

- **`warnings` on the create and publish responses.** The manual promised the server tells you
  at publish time. It did not; warnings only appeared on a later read, so an agent that
  published and saw a clean response concluded it was clean.

### Removed

- **"Done for now".** It appended `{kind:"done"}` to the log and nothing else: nothing reads
  that kind, and the route it called never fires a webhook, so pressing it notified nobody. It
  also disabled itself permanently, so the person who pressed it and kept typing could not
  mark a second checkpoint. `kind: "done"` is still accepted by the API and old histories are
  unaffected.

  The idea survives. An intent note is the one thing auto-diff cannot recover, since "added
  extra budget" and "cut 6000 to 900, added a 5000 line" describe the same edit. It comes back
  wired to the webhook, so it actually notifies.

### Documentation

- `guide.md` now says the canvas is white in every theme, that the frame has no viewport, that
  `Vaiven.state` is null until the document loads, and that `read_key: true` is what creates
  `read_url` — without which section 3, the read-back loop this product exists for, silently
  does not work. It also carries a read-write-merge example using `version`, which is the
  value every response actually returns.
- **Never tell the person to use a control in the shell.** A real document was found
  instructing its reader to press Done for now, twice, after that button was gone. Content is
  served as written and never rebuilt; the chrome around it is ours and it changes.

## [0.2.5.1] - 2026-08-19

Documentation catch-up for 0.2.5.0.

### Fixed

- **`README.md` claimed 233 unit tests when the suite has 235.** The number had been wrong
  across two releases. Nothing guards it: a static count of the source says 172, because
  several tests are generated inside `for` loops, so the source cannot answer the question.
  Recorded in `TODOS.md` as P4 with the two files that prove it, rather than shipped as a
  guard that would be wrong on the first read.
- **The README docs table did not list `docs/designs/agent-onboarding.md`**, the design doc
  that 0.2.5.0 added.

## [0.2.5.0] - 2026-08-19

The manual was fixed twice for pointing agents at a CLI they cannot run. The API was still
doing it, in the one place a cold agent meets first.

### Fixed

- **Six error hints named `vaiven tenant create`**, a binary that has never been published and
  that only works on the machine serving the instance. The 401 body is what a keyless agent
  reads *before* it reads any documentation. One followed it, probed six plausible install
  paths, and correctly gave up — without a tenant key `POST /api/docs` can only answer 401.
  Every hint now says what is true: document keys arrive in the link, tenant keys are minted
  only on the server host, **no request you can make will produce one**, and here is who to
  ask. Closing the search needs that explicit negative; omitting the CLI just invites more
  searching.
- **One of them was worse than undocumented.** The revoked-key hint said "mint one with
  `vaiven key add`" for something `POST /api/docs/<id>/keys` already does over HTTP — and if
  the revoked key *was* the tenant key, minting was impossible anyway.
- **Six quota hints told the reader to raise a limit only the operator can raise**, and
  suggested deleting a document without saying deletion needs a tenant key.
- **The front-door JSON said nothing about keys at all** — the first object a discovering
  agent reads. It now states there is no self-service path.
- **`guide.md` §1 and the sub-pages** carried the same instruction. Corrected.

### Added

- **A trust-model line in the manual: never publish your key into `content`.** The agent
  authors the HTML, so a key pasted into a page is served to everyone who opens the document.

### Notes

Scope was cut during review, from a full manual restructure to this hygiene fix. The kill
criterion stands at 0 of 10 — all 50 production documents are test fixtures — and polishing
onboarding for third-party agents does not move it. Eleven error-shape findings (no
machine-readable retry semantics, `not_found` covering four cases, 405 returning code
`invalid`, recovery data outside the `error` object) are recorded in `TODOS.md` rather than
fixed here. The frozen items and the instance-model decision are recorded too.

## [0.2.4.0] - 2026-08-18

The guards added in 0.2.3.0 did not cover what they claimed to. Found by running the review
gate that release skipped.

### Fixed

- **A regression guard that could not see new files.** All four guide guards iterated a
  hardcoded `SUB_PAGES` list of three names, while the server serves any `guide/<name>.md`
  matching its own pattern. Measured: a new page carrying a shell placeholder, a relative
  link **and** a URL glued to a markdown emphasis marker was served with HTTP 200 while all
  38 tests passed. The list is read from disk now, and throws if it comes back empty so it
  cannot pass vacuously either.
- **`${HOST}` walked straight past the placeholder guard.** It matched `$[A-Z_]{2,}`, which
  misses both `${HOST}` and `$Host` — and `${HOST}` is the more idiomatic shell form, so it
  was the likelier way the original bug returned.
- **The sandbox origin was never rewritten.** `serveGuide` substituted only the app origin.
  The moment anyone documented `uc.vaiven.owncompute.com` — the host that serves untrusted
  model-authored HTML, and a natural thing to explain — a self-hoster's manual would have
  sent their readers to the canonical production sandbox. No page names it yet; closed before
  it could bite.
- **The canonical origin was matched without a boundary.** `…owncompute.com:443/x` would have
  been rewritten from the middle into a double-port URL.
- **The sub-page existence guard only scanned `guide.md`**, so a sub-page could link to a
  page that no longer existed.

### Changed

- **`package.json` was stuck at 0.2.1** and had silently missed both 0.2.2.0 and 0.2.3.0,
  because those two releases skipped `/ship` and therefore skipped its version gate. Resynced
  to 0.2.4. The gate found it the first time it ran again.

### Documentation

- **README never explained that the manual is rewritten for your origin.** It documented every
  environment variable, local development and deploying, but a self-hoster cloning the repo
  would open `guide.md`, see the canonical origin throughout, and have no way to know their
  own server substitutes it. New section under Configuration, including the two things that
  actually trip people: do not edit the origin out of the file, and read the manual from your
  own server to see what your agents receive.
- Corrected two stale facts: the unit-test count (212 → 233) and the number of live suites
  (five → six). Added `test/repaint.ts` and `docs/designs/well-formed-urls.md` to their
  tables, and softened the `guide/app-mode.md` row now that `guide.md` is self-sufficient.

## [0.2.3.0] - 2026-08-18

Every URL in the manual is now complete and usable as it stands.

### Fixed

- **The manual stored URLs as `$HOST/api/docs`.** The served bytes were correct — the server
  substituted at request time — but the file is not a build input. It is the artifact people
  actually meet: on GitHub, through `raw.githubusercontent.com`, and in every clone. Through
  all three it told the reader to call `$HOST/api/docs`, and in a shell an unset variable
  expands to empty, so a copy-pasted command silently became `curl -s /api/docs`. Worse,
  `$HOST/guide/errors.md` is not a URL at all, so an agent's fetch tool could not open it —
  which happened in production. The manual is written against the canonical origin now and
  rewritten to whichever origin the instance serves, so the stored file is correct standalone
  and the failure mode inverts: bypass the substitution and you get a URL that works.
- **Every remaining `$` placeholder is gone.** `$KEY`, `$DOC`, `$READ_URL`, `$LAST` and
  `$OLD_KEY_ID` are literal now, with a legend table naming where each value comes from, so
  nothing in the manual can be mistaken for shell syntax. A blank left unfilled returns a
  clean 401 or 404 with a hint rather than a malformed request.
- **The version stamp made its own URL unfetchable.** It ended `…/guide.md*`, flush against
  the closing markdown emphasis. A renderer closes the emphasis; a regex URL extractor takes
  the `*` and 404s — on the single address whose entire purpose is to be re-fetched.
- **A sample error body in `guide/errors.md` elided the origin** as `…/guide/errors.md`. Real
  responses carry an absolute `guide` URL, so the sample misrepresented the API.
- **`guide/errors.md` used `k_YOUR_OLD_KEY_ID` where the legend defined `k_YOUR_KEY_ID`.**

### Added

- Four regression guards over every served guide page, each mutation-checked in both
  directions: no shell placeholder on disk, no relative pointer to another guide page, no URL
  flush against a markdown emphasis marker, and every blank an example asks you to fill in
  must appear in the legend. The last one caught a real inconsistency on its first run.

### Security

- The manual is installed verbatim as `~/.claude/skills/vaiven/SKILL.md`, so it is executable
  prompt code rather than documentation. With the key now shown literally in examples, it
  carries an explicit instruction to keep the key in an environment variable — a key typed
  inline survives in shell history, in scrollback and in any saved script.

## [0.2.2.0] - 2026-08-18

One URL is now enough. An agent handed only `https://vaiven.owncompute.com` can reach the
manual, and the manual alone carries everything needed to build, publish and recover.

### Fixed

- **The worked example in the manual did not work.** It is the copy-paste starting point
  for every app-mode document, so its defects propagate into every app built from it, and
  it had two. Typing into a row dropped everything after the first character and lost
  focus, because `render` re-runs synchronously inside `mutate` and the painter rebuilt the
  input being typed into. Mutating on `change` instead moved the bug rather than fixing it:
  the *next* click was swallowed, since moving focus fires `change`, which repaints and
  re-inserts the button before the click lands on it. Re-using the node is not sufficient
  either — re-inserting a node cancels a click in flight over it. The example now keys rows
  by an id of its own, updates values in place, skips the field holding focus, and rewrites
  the list only when rows are added, removed or reordered.
- **The same example in `guide/app-mode.md` referenced an undefined `row`** — a
  `ReferenceError` for anyone who copied it. Both pages now carry the same working example.
- **Three facts needed to recover from a mistake lived only in sub-pages**, so the page
  claiming to be sufficient was not: the body shape for minting a key (`role` is required),
  the body shape for restoring a version, and the character caps on `title`, `sender_note`
  and key labels — which refuse the write with 413 rather than shortening it.
- **The manual overstated `untrusted`.** Error bodies do not carry it; successful reads do.
- Documented two behaviours that fail silently when guessed: calling `Vaiven.render` turns
  automatic capture off, and `Vaiven.log(kind, …)` records `kind` as the note *text* while
  the event itself reads back as kind `note`.

### Added

- **`test/repaint.ts`** — reads the worked example out of `guide.md`, publishes it, and
  drives it in Chromium the way a person does: one keystroke at a time, clicking without
  blurring first. Verified against both shipped-broken versions of the example, which it
  fails, and the fix, which it passes. `test/fields.ts` could not have caught either bug —
  it is an automatic-mode fixture, which never repaints, and it drove inputs with `fill()`,
  which sets a value once. Its comment said otherwise; that comment is corrected.
- **The manual's inlined error table and limits are now pinned to the code.** Statuses are
  asserted against `STATUS`, and every size, rate and cap against `LIMITS`, `RATES`,
  `CLAMP` and `COLLAPSE_AT`, so the duplication cannot drift in either direction.

### Changed

- `test/loop.ts` reports what the server said when a document cannot be created. A
  quota-exhausted tenant used to surface as a failure of the loop itself.

## [0.2.1.0] - 2026-08-18

Everything here came from one agent using Vaivén for real and reporting back, and from
running the review gates over the fixes that feedback produced.

### Fixed

- **The manual named an API it never defined.** `Vaiven.render` and `mutate` were mentioned
  and documented nowhere, behind a link written as `$HOST/guide/app-mode.md` — a shell
  placeholder nothing could fetch. An agent building against it had to either invent the
  signatures or stop and ask. Every URL the guide points AT is absolute now — `$KEY`,
  `$DOC` and `$READ_URL` remain for the caller to fill in, which is the distinction — and
  the whole app-mode API is in the manual itself, so it cannot be invented.
- **An installed manual could never be corrected.** The guide is distributed by copy into
  `~/.claude/skills/vaiven/SKILL.md`, and nothing on that copy said which version it was.
  A correction made today stayed wrong forever for anyone who installed yesterday, and
  neither the agent nor the person could tell. Every page carries its version and the
  address of the current one.
- **`state` has its own 1 MB cap** and the guide only ever mentioned content's 4 MB, so the
  natural inference — "well under 4 MB, so size is not my problem" — was wrong for the one
  thing that grows as a document is used. Said where the 4 MB is said.
- **A field the person deleted came back** if the agent edited it at the same moment, with
  the save status showing "Saved". Delete-vs-edit is a real conflict; the person's deletion
  wins, which is what the merge policy always claimed.
- **Overlapping polls could rewind the event cursor**, re-announcing changes already seen.
- **A terminal "not saving" warning could be destroyed** by a lower-priority notice and
  never return, taking the only escape hatch for unsaved work with it.
- **Plaintext was permitted with one real host.** The check only refused when *neither* host
  was `.localhost`, so the shell could be served in the clear with a write key in its URL
  fragment.
- **Hostnames were never validated**, and the origin built from them is spliced into
  `frame-ancestors` and `frame-src`, where a malformed value fails open.
- **`bun run dev` handed back URLs on a port nothing was listening on.**

### Added

- A README that documents how to run, test, configure and deploy the service.
- `test/config.test.ts` — the startup refusals, in real subprocesses. `appHost ===
  sandboxHost` is the invariant the whole security design rests on and nothing had ever
  executed that branch.
- `test/guide.test.ts` — the manual's claims, checked against the code that serves them.

### Changed

- 169 to 212 unit tests. The guide tests invoke the real handler; the first version of them
  reimplemented its logic, so deleting the code under test left them all passing.

### Compatibility

Two configurations that used to start now refuse to. Both are deliberate, and both are the
fix rather than a side effect of it:

- `VAIVEN_SCHEME=http` with only one host on `.localhost`.
- A hostname containing anything outside `[a-z0-9.-]` (or a bracketed IPv6 literal).

If Vaivén stops booting after this upgrade, the startup message says which one and why.

### Known issues

Carried forward, all tracked in `TODOS.md`:

- An event appended without a version bump is invisible to a client sending `If-None-Match`,
  because the ETag has no event component. Affects any agent using conditional reads.
- A replay can return a version that is no longer current, if a write without a
  `request_id` landed in between.
- A `request_id` longer than 64 characters is truncated, so two ids sharing a prefix
  collide.
- No one who has not seen the system has used it yet, and no cold agent has bootstrapped
  from `guide.md` alone. Those two gates are still open.

## [0.2.0.0] - 2026-08-18

The first working version. An agent publishes a small web app, a person edits it, and the
agent reads back a diff of what they changed from a plain URL.

### Added

- **The read-back channel.** `GET /r/<read_key>.json` returns the document's state and an
  event log naming every change, with no headers, no key in a header, and no JavaScript.
  Anything that can issue a GET can read it.
- **Automatic mode.** Ordinary HTML with `name` attributes is enough. Values are captured,
  restored on reload, and diffed into events. Radio groups, same-name checkboxes,
  `<select multiple>`, textareas and named `contenteditable` regions all behave correctly;
  passwords, file inputs, hidden fields, `autocomplete="off"` and `data-vaiven-ignore` are
  never captured, on the server as well as in the browser.
- **App mode.** `Vaiven.render()` and `Vaiven.mutate()` hand a document that adds, removes
  and reorders rows to the author, with `Vaiven.log()` for notes and `Vaiven.readonly` for
  read-key viewers.
- **Identity-keyed array diffing.** Array elements carry a server-stamped `_vid`, so the log
  says `items[Travel time].days: 4 → 6` and `add "Extra budget"` instead of index noise
  that means nothing a day later.
- **Two-origin isolation.** Model-authored HTML is served from a separate host under
  `Content-Security-Policy: sandbox` with `connect-src 'none'`, so it cannot reach the
  network, the shell's origin, or the key on the page. Routes are partitioned by `Host`
  before any path matching.
- **The shell.** Title, who you are editing as, live save status, a persistent disclosure of
  what is recorded, a panel showing the person their own event log, and a "Done for now"
  button that closes the loop with a note.
- **Webhooks.** A document can push its state on every change, HMAC-signed, with an SSRF
  guard that re-resolves before every delivery attempt.
- **Version history.** Retained per editing session as well as by count, listable and
  restorable, so the safety net can reach yesterday and not just the last few keystrokes.
- **Multitenancy and administration.** Tenant and per-person document keys, byte and
  document quotas, rate limits on every surface, and a CLI for tenants, keys and documents.
- **The manual.** `guide.md` plus sub-pages for errors, limits and app mode, served as
  markdown, carried as an absolute URL on every error so a stuck agent can bootstrap from
  one fetch.
- **Backups.** A verified hot backup every six hours with an integrity check, WAL
  checkpointing, and a restore drill that has been rehearsed and timed.

### Fixed

Found by putting the product in front of a browser rather than reading the code.

- The document was unreadable in dark mode: authored HTML sets a text colour and leaves the
  background alone, and the frame was painting the shell's dark surface underneath it.
- The primary action was illegible in dark mode at 2.28:1 contrast.
- The chrome bar collapsed at phone widths, rendering the title as a single character.
- The agent-response toast and the republish offer were created and destroyed in the same
  tick by a routine save, so nobody ever saw either of them.
- `Vaiven.log()` payloads were dropped between validation and storage on the only code path
  the product actually uses.
- "Copy my changes", the escape hatch when saves are failing, gave no feedback at all.
- The retry-dedupe key was minted, passed to the transport, and never sent, so a write the
  server had committed came back as a conflict on retry.
- The webhook advertised a cursor in the wrong number space, so a receiver following the
  documented pattern would skip or replay events.
- An unauthenticated request to the content host performed a write on an arbitrary tenant's
  row.
- Storage quotas could be driven past their limits by concurrent writes reading the counter
  before the transaction.
- Publishing had no working lost-update guard: the precondition compared the wrong half of
  the ETag and the write had no compare-and-set.
- `revoked` and `disabled` were documented error codes that nothing ever returned, so an
  agent holding a well-formed but revoked key was told to go re-check its key.
- Raw IP addresses were retained indefinitely for a signal that only ever needed a count.
