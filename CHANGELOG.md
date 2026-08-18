# Changelog

All notable changes to Vaivén are recorded here. Versions are `MAJOR.MINOR.PATCH.MICRO`.

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
