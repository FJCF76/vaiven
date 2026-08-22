# Design: agent-authored documents don't accumulate

Author's brief 2026-08-22, reviewed by `/autoplan` (CEO + design + eng + DX, Codex
`gpt-5.6-sol` at high reasoning as the outside voice on three of four phases).
Branch: `documents-accumulate` · Status: REVIEWED · Mode: SELECTIVE EXPANSION

## Context

A Vaivén document is one file, regenerated whole by a model, with no modules, no tests, and no
way to refactor incrementally. Version 1 is a superpower. Version 9 is unverifiable: nobody,
model or human, can confirm that this regeneration did not break what worked in the last one.

This is the ceiling that gets worse the more useful the product becomes. Everything else on the
backlog is a wart.

**The principle applied throughout: a component is code that has stopped changing.** Code a model
regenerates every time is not a component no matter how it is factored. Every item below is about
letting parts of a document stop being rewritten.

## Premises, verified against the code

| # | Premise | Verdict |
|---|---|---|
| P1 | Regeneration is unverifiable past a few versions | Accepted |
| P2 | State has version history and restore; content has neither | **Verified.** `schema.sql:94` defines `state_versions` with its own prune index at `:112`; `doc_content` at `:68` carries only a `content_version` counter |
| P3 | The reconciliation section is a missing abstraction written as prose | **Verified.** `guide.md:160-232` is a 47-line worked example plus three warnings; line 214 reads "breaks in two ways that look like browser bugs" |
| P4 | Nothing in the CSP constrains how content is *authored*, only what is *served* | Accepted |
| P5 | `guide.md` is the skill, so behavioural text there is standing instruction | **Verified.** `README.md:304` fetches `/guide.md` into the installed `SKILL.md`; the file carries YAML frontmatter |
| P6 | Publishing should render the document headless **on the server** | **REJECTED.** See A1 |

Corroborating evidence found during the audit: `guide.md` is the most-touched non-release file of
the last 30 days (14 commits). The manual is churning, which is what a missing abstraction
maintained as prose looks like.

## Amendments

### A1. Validation runs in the client sandbox, not on the server

The goal of P6 — catch a first-paint throw before a person sees it — is kept. The mechanism is
replaced. Both the primary reviewer and the outside voice reached this independently.

Server-side headless rendering would execute untrusted, model-authored JavaScript on the host
that holds the database and every tenant key. Vaivén's entire security posture is that model code
runs only in an opaque origin with `connect-src 'none'`, where it cannot reach server secrets,
the database, or the network. (Not that it is harmless — A5 notes it can freeze its own renderer.
The claim is containment, not safety.) Running it host-side inverts that. It also collides with the deployment: the service has **no runtime
dependencies** by design (`deploy/sync.sh` excludes `node_modules` — "the service needs no
packages"), and the unit sets `MemoryMax=768M` with `RestrictNamespaces=true`, which blocks
Chromium's own sandbox.

**Decided: candidate/promote.** `PUT /content` creates a candidate that does not become active.
A bounded static pass at publish rejects the syntax class outright. The candidate is validated by
rendering it in the sandboxed iframe the shell already owns; on success it is promoted, on
failure it is marked failed and the previous active release keeps serving.

### A2. Content becomes releases, and item 3 becomes a prerequisite of item 2

"Candidate" and "active" are only meaningful if content rows are versioned with one marked
current. That is a release model, so **the build order changes: content history ships before
validation, not after.**

A release is not just a blob:

| Field | Why |
|---|---|
| blob, bytes, `status` (candidate/active/superseded/failed) | What promotion moves between |
| validation result + timestamp | Why it was promoted, or why it was not |
| runtime contract marker | Restoring old content against a newer injected runtime can reintroduce the failure restore exists to cure |
| state shape marker | Same hazard against independently-evolved state |
| idempotency key | A lost response plus a retry otherwise creates a duplicate 4 MB candidate charged twice |

### A3. `content_version` is a promotion-only activation counter — this is the A8 trap

**The single highest-risk implementation error in this plan.** ("A8", "A5", "A12" below refer to
amendments in `docs/designs/vaiven-v1.md`, not to this document's own A1-A10.)
The natural move is to bump
`content_version` when the candidate is created, because the release needs a version immediately.
That rebuilds the **v1 A8** bug exactly: a shell polling during the pending interval caches the *old
active body* under the *candidate's future ETag*, promotion becomes unobservable, and the open
page runs the old application indefinitely.

```
  WRONG                                  RIGHT
  publish -> content_version = N+1       publish -> release row, NO version bump
  poll    -> shell caches OLD body       poll    -> ETag still N, body still active
             under ETag N+1              promote -> content_version = N+1   <-- only here
  promote -> nothing observable          restore -> content_version = N+2
```

**Blobs live in `content_releases` only.** `doc_content` loses its `content` column and keeps
`active_release_id`, `content_version` and `bytes`. This resolves what would otherwise be a
contradiction: if both tables held the blob, promotion would copy 4 MB and A10's "zero byte
delta" would be false, and the active content would be stored twice.

It is also strictly better than today for the reason **v1 A5** split these tables at all. Right
now `doc_content` is `(doc_id, content, content_version, bytes)` — `content_version` is stored
*after* a 4 MB column in the same row, so the hottest query in the system still risks walking an
overflow chain. Removing the blob makes that row tiny. Serving `/c/:id` gains one lookup by
`active_release_id`, which is not the hot path; the 3-second poll never touches a blob again.

### A4. One pending candidate per document, promotion by CAS

| Race | Resolution |
|---|---|
| Two shells validate and both promote | Promotion is a compare-and-set on the active generation; the loser gets `409 stale_candidate` |
| Publish lands mid-promotion | At most one pending candidate; a new publish atomically supersedes it |
| Restore runs while a candidate is pending | Restore atomically invalidates candidates based on the previous generation, or returns 409 |
| A stale iframe answers | Every callback carries the candidate id **and** a shell-generated attempt id. **This solves staleness, not authenticity** — see the open question below |

### A5. Declared assertions are mandatory, not optional

Validation collapses without them. `load` fires before later promise rejections; `window.onerror`
misses layout and most resource failures; a timer can throw immediately after promotion; an
infinite loop can freeze the renderer and prevent the timeout meant to catch it; and **the
candidate can spoof `ready`** — the artifact being validated is the thing certifying itself. A
document that wraps its own init in `try`/`catch` passes.

Without assertions, promotion means only "did not throw uncaught." Minimum bar: bootstrap
complete, two animation frames, a bounded stability window, no observed errors, plus a
server-side expiry for frozen or closed tabs. **Even then it is a smoke test, not proof the
application works.**

### A6. Runtime components return controllers over author-owned DOM, never nodes

The author's rule — "components own behaviour and never appearance" — is right, and returning
nodes does not hold it. A component that creates DOM has already chosen element types, nesting
and order, and therefore semantics and accessibility. Styling freedom is not structural freedom.

```
  Vaiven.list(listEl, { create: item => authorMakesTheNode(item),
                        update: (node, item, ctx) => { /* author */ } })
```

The component owns identity, focus and selection preservation, pending pointer activation, and
move/remove. The author owns every element that exists. Field binding is `Vaiven.bind(el, …)`
over an element the author made. **Enum handling is a value utility, not a `<select>` generator** —
the moment it generates a control it has picked a widget.

Accessibility splits accordingly. Universal infrastructure (identity, focus, pointer-in-flight)
invents **no** ARIA roles and no keyboard model. Pattern-specific behaviour, if shipped at all,
ships under named APIs with documented roles and overrides — never implicitly inside
reconciliation.

The existing surface is six members — `state`, `readonly`, `render`, `mutate`, `note`, `log` —
and `note`/`log` are already behaviour helpers, so this extends an established pattern.

### A7. The authoring layout is one scaffold among several, not the canonical anatomy

Only `dist.html` is contractual. A single prescribed layout teaches agents a default
*architecture* — CSS-driven pages, a fixed component taxonomy, DOM-oriented JS, a build pipeline
— biasing them away from canvas documents, generated layouts, and deliberately tiny ones. Design
freedom is a stated product value and this is the item most able to erode it.

**Nothing in this plan may add a step to the first publish.** The build step is opt-in for
documents that have earned it: app mode, or an expectation of republishing.

The page must also state that the agent never hand-edits the assembled file. The moment it does,
the sources lie and it is a monolith again without anyone noticing.

### A8. Acceptance is adversarial tests, not a deleted manual section

Deleting `guide.md:160-232` is a good smell but a bad acceptance test — it rewards hiding
complexity as much as removing it. What replaces it is a behavioural contract: stable identity,
focus and selection preservation, pointer-in-flight, create/update/move/destroy, who owns
accessibility, escape hatches, cleanup.

Acceptance is: focused inputs, IME composition events, rapid deletion, reorder during pointer
activation, duplicate keys, screen-reader-relevant mutations. Several already sit open in
`TODOS.md` under coalescing edge cases. **The deletion lands with item 4, never before it**, or
the manual teaches an API that does not exist — the exact defect `agent-onboarding.md` was
written to correct.

### A9. The publish response must say what happened

Today `200` means live. After A1 it means *accepted*, and if the response does not change the
agent cannot tell the difference — a silent failure by construction.

**Two distinct responses, which must not be conflated.** `PUT /content` can only ever return
`candidate` (or a 4xx from the static pass), because validation has not happened yet. `active`
and `failed` are terminal states an agent learns from a *later* status read.

```
  PUT /content    -> { "release": "…", "status": "candidate", "status_url": "…" }
                     accepted, NOT serving; a 4xx instead if the static pass rejected it

  GET status_url  -> { "release": "…", "status": "candidate" }  still awaiting a viewer
                  -> { "release": "…", "status": "active"    }  validated and serving
                  -> { "release": "…", "status": "failed", "error": … }  previous still serving
```

`warnings` carries the pending state; per **v1 A12** (never make the agent construct a URL) the
response carries the status URL rather than making the agent build one.

### A10. Quota counts releases; logical quota does not protect physical disk

Every retained release counts against doc and tenant quotas at insert, in the same transaction.
Promotion is metadata only: zero byte delta. Independent limits for pending candidates per
document, total release bytes, retained release count, validation lease duration, and
failed/superseded retention. Prune order: expired pending → failed → superseded-never-active →
history beyond retention. **Never** prune the active release, a leased candidate, or a retained
restore point; a pruned restore target returns `410 Gone`.

A 4 MB candidate is roughly one full blob write into the WAL plus another at checkpoint. Deletion
moves pages to the freelist rather than shrinking the file, backups keep carrying the high-water
mark, and `VACUUM` needs substantial temporary space. Returning 507 only once SQLite reports
`SQLITE_FULL` is too late to protect other tenants' writes.

The static pass must be **bounded** (CPU, memory, nesting depth, token count) and must run before
the blob is inserted. A pathological 4 MB HTML can stall a single-threaded Bun process without
executing any JavaScript — the same class as the quadratic scans already fixed twice in
`src/inject.ts`.

## Error registry

| # | Failure | Rescue | Code |
|---|---|---|---|
| R1 | Candidate never validates because nobody opens the document | Publish response and `warnings` must name the pending state | **needs a name** |
| R2 | Candidate fails first paint | Active release stays live; candidate marked failed with the captured error | reuses `kind:"error"` |
| R3 | Promotion attempted without capability | Explicit denial, never a silent no-op | `read_only` (v1 A9) |
| R4 | ETag tracks candidate rather than active | ETag follows the active pointer | v1 A8 regression |
| R5 | Restore to a release the runtime outgrew | Refuse or warn on contract mismatch | **needs a code** |
| R6 | Failed candidates accumulate | Prune policy; 507 path exists | partial |

R1 is a silent failure by construction until it is named. Prime Directive 1 forbids it.

## Build order

```
  1. Author in modules (docs only — guide.md example + guide/authoring.md)
  3. Content as releases: versioned rows, active pointer, restore     <-- MOVED UP
  2. Candidate/promote validation, built on that pointer
  4. Runtime components (controllers), then delete guide.md:160-232
```

Item 1 stays first: it is docs-only and touches no server code. It is **not** independent of
item 4 — both edit `guide.md`, item 1 adding the authoring pointer and item 4 deleting
`160-232`. Different regions of the same artifact, so they must not land concurrently.
Items 3 and 2 swapped because candidate/promote requires an active pointer.

## What this does not fix

None of it gives an agent architecture for a large application. It moves the ceiling rather than
removing it. The author's illustration — "a tool that needs 5,000 lines today would need 500, and
500 regenerates safely" — is an estimate offered to convey the shape of the gain, not a measured
result, and nothing here has measured it.
Anything genuinely large needs modules at runtime, which means a repository, which means Vaivén
stops being "you publish a file." That is an identity limit, like documents having no
cross-document queries, and it is deliberately not crossed.

## Cross-phase themes

**Implicit contracts.** Flagged independently in design (who owns keyboard and screen-reader
semantics), eng (the candidate certifies itself), and DX (a `200` that no longer means live).
Three phases, one shape: the plan leaves the contract implicit wherever something untrusted or
invisible is on the other side. High-confidence signal.

**Item 1 persuades but does not enforce.** Vaivén only ever receives `dist.html`, so "the sources
are on disk and git covers the why" describes a machine Vaivén cannot see. An optional source
bundle would close this; it is deferred to `TODOS.md` because it changes the storage model.

## Decision Audit Trail

| # | Phase | Decision | Class | Rationale |
|---|-------|----------|-------|-----------|
| 1 | CEO | Mode = SELECTIVE EXPANSION | Mechanical | 0F default for iteration on an existing system |
| 2 | CEO | P1-P5 accepted; P2, P3 and P5 verified against specific lines | Mechanical | Checked, not assumed |
| 3 | CEO | P6 rejected; validation moves to the client sandbox | **User Challenge → accepted** | Both voices independently; author decided |
| 4 | CEO | Item 3 becomes a prerequisite of item 2 | Mechanical | Consequence of #3, not a preference |
| 5 | CEO | Warnings backfill folded into the release row | Mechanical | In blast radius; closes an existing P2 |
| 6 | CEO | Source bundle deferred | Taste | Answers the strongest item-1 objection but changes storage |
| 7 | Design | Controllers, not nodes | **User Challenge → accepted** | Returning nodes fixes markup, semantics and a11y |
| 8 | Design | Scaffold, not anatomy | **User Challenge → accepted** | Prescribes a default architecture |
| 9 | Design | Adversarial tests replace deletability as acceptance | Mechanical | Deletability rewards hiding complexity |
| 10 | Eng | `content_releases` separate; `content_version` promotion-only | Mechanical | Bumping at creation rebuilds A8 |
| 11 | Eng | One pending candidate per document | Mechanical | No deterministic winner otherwise |
| 12 | Eng | Assertions mandatory | **User Challenge → accepted** | Validation otherwise means "did not throw uncaught" |
| 13 | DX | Publish response distinguishes active/candidate/failed | Mechanical | R1 is otherwise silent by construction |

## GSTACK REVIEW REPORT

| Review | Runs | Status | Findings |
|--------|------|--------|----------|
| CEO Review | 1 | clean | P6 rejected; 3 expansions triaged; 2/6 consensus confirmed |
| Design Review | 1 | clean | 5/5 confirmed; API shape changed |
| Eng Review | 1 | clean | 6/6 confirmed; A8 trap found; 8 issues |
| DX Review | 1 | clean `[single-voice]` | Response shape, 2 missing codes, TTHW guard |

**CROSS-MODEL:** three findings reached independently by both voices — server-side execution
inverts the threat model; returning nodes cannot hold "behaviour not appearance"; item 1
persuades but enforces nothing.

**DEGRADATION:** all phases ran `[codex-only]`; no Claude subagents were dispatched (standing
session constraint). DX ran `[single-voice]` and is the least validated of the four.

**VERDICT: CEO + DESIGN + ENG CLEARED. DX cleared at single-voice confidence.**
All four user challenges resolved by the author.

**NOT "no unresolved decisions" — the list below is open by design.** A fidelity pass over this
document caught the earlier draft claiming otherwise while the text itself contained four
unresolved "or"s. These are design questions the implementation phase must close, not gaps in the
review:

| # | Open question | Where |
|---|---|---|
| O1 | **What authenticates a validation callback?** The candidate can spoof `ready`. Candidate and attempt ids solve staleness, not authenticity. Until this is answered, promotion trusts the artifact it is validating. **This is the most important open item.** | A4, A5 |
| O2 | **What is a declared assertion?** A5 makes them mandatory but does not define their format, who executes them, or the pass criteria. An implementer could ship only the generic smoke test and believe they had satisfied this document. | A5 |
| O3 | Does restore **invalidate** pending candidates or **refuse** with 409? | A4 |
| O4 | Does a restore across a changed runtime contract **refuse** or **warn**? | R5 |
| O5 | Names for R1 (candidate never validated) and R5 (restore across contract). R6's prune policy is sketched, not specified. | Error registry |
| O6 | Adversarial acceptance names scenarios, not pass/fail outcomes. Duplicate keys and required focus/selection behaviour need normative answers. | A8 |

O1 and O2 together decide whether item 2 is worth building: without them, promotion means "the
document said it was fine."
