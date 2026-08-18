# Changelog

All notable changes to Vaivén are recorded here. Versions are `MAJOR.MINOR.PATCH.MICRO`.

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
