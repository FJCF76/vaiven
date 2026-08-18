# Design: well-formed URLs in the manual

## Problem

`guide.md` and `guide/errors.md` store every URL as `$HOST/api/docs/...`. `serveGuide`
substitutes `$HOST` for the configured origin, so the *served* manual is correct — verified,
zero `$HOST` in the live bytes.

The stored file is not a build input. It is the artifact people and agents actually
encounter, through three routes the substitution never touches:

1. GitHub's rendered view of a public repo — the most likely place a human or an agent
   reads it first
2. `raw.githubusercontent.com` — fetchable by any agent, returns the raw file
3. any clone or vendored copy

Through all three, the manual instructs the reader to call `$HOST/api/docs`.

Two distinct failures follow:

- **In a shell, `$HOST` is not a syntax error.** An unset variable expands to empty, so the
  copy-pasted command becomes `curl -s /api/docs`. No diagnostic, just a confusing failure
  far from its cause.
- **`$HOST/guide/errors.md` is not a URL.** An agent's fetch tool cannot open it. This has
  already happened once in production: an agent reading the manual could not reach the
  app-mode page and stopped to ask a human.

A self-hoster reading the repo rather than their own server gets the same broken text.

## Design: the canonical URL *is* the placeholder

Store the real production origin in the file. At serve time, replace the canonical origin
with the configured one.

```
guide.md on disk:   curl -s https://vaiven.owncompute.com/api/docs
production:         no-op (already correct)
local dev:          -> http://vaiven.localhost:8080/api/docs
self-host:          -> https://docs.example.com/api/docs
```

Why this and not the alternatives:

- **It makes the stored file correct on its own.** Every URL in it is complete, absolute and
  fetchable with no preprocessing. That is the property the manual claims to have.
- **It keeps local dev and self-hosting working** (A12 requires both), which is the whole
  reason a placeholder existed.
- **It inverts the failure mode.** If the substitution ever breaks or is bypassed, the reader
  gets the production URL — which *works* — instead of a malformed path. Fail-safe rather
  than fail-broken. The current design's worst case is silent corruption; this design's worst
  case is pointing at the canonical instance.
- Hardcoding with no substitution was rejected: it breaks local development, which A12 lists
  as a requirement, and would make the guide wrong for every self-hoster.

## The other placeholders

`$KEY`, `$DOC`, `$READ_URL`, `$LAST`, `$OLD_KEY_ID` stay. They are values only the caller
has, and the server must not pretend to know them. The distinction is the point: everything
the server can answer is answered; everything it cannot is visibly a blank.

But an unset variable fails silently in a shell exactly as `$HOST` does. So every bash
example gains its assignments, making each snippet self-contained and runnable:

```bash
KEY=...            # your tenant key
DOC=d_...          # the id the create call returned
curl -s "https://vaiven.owncompute.com/api/docs/$DOC/content" -H "Authorization: Bearer $KEY"
```

## Implementation

- `CANONICAL_ORIGIN` exported from one module; `serveGuide` does
  `replaceAll(CANONICAL_ORIGIN, () => config.appOrigin)` — a replacer *function*, because a
  string replacement interprets `$&`, `` $` ``, `$'` and `$$` and an origin containing one
  would rewrite the manual. This preserves the existing lock.
- `$HOST` -> the canonical origin throughout `guide.md` and `guide/errors.md`.
- Assignments added to every bash example.

## Verification

- The file on disk contains no `$HOST`, and every URL in it parses as absolute.
- Serving under a non-canonical origin rewrites every one of them.
- Serving under the canonical origin is a byte-level no-op.
- Mutation-checked: deleting the substitution must fail a test.
- The live manual is fetched and every URL in it resolved.

## Risks

- **Prose mentions of the canonical host get rewritten too.** Intended: a self-hoster should
  see their own host named. Needs a check that no sentence depends on naming the *canonical*
  instance specifically.
- **A shorter origin is a substring risk** if any origin were a prefix of another string in
  the doc. `https://vaiven.owncompute.com` is specific enough that this cannot collide, but
  the test should assert the substituted output contains no leftover canonical reference.

## Outcome

Implemented on branch `well-formed-urls`, shipped as v0.2.3.0.

The user's call on the remaining placeholders was **strip every `$`**: literal values
everywhere, including the key, so nothing in the manual looks like shell syntax. The trade
raised in the decision brief — a credential typed inline lands in shell history — was
accepted, then mitigated in the `/cso` pass with an explicit instruction to keep the key in
an environment variable, which preserves the literal format.

Review found and fixed, beyond the original design:

- The version stamp put the URL flush against a closing `*`, so a regex URL extractor took
  the `*` and got a 404 on the one address whose entire job is to be re-fetchable.
  Restructured so the URL sits mid-sentence.
- `guide/errors.md` showed a sample error body with the origin elided as `…/guide/errors.md`.
  Real responses carry an absolute URL, so the sample misrepresented the API. Now matches
  what `errorResponse` emits.
- `k_YOUR_OLD_KEY_ID` was used but the legend defined `k_YOUR_KEY_ID`. Caught by the new
  legend guard on its first run.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | resolved | 4 (2 P1 test-drift, 2 P2) |
| Security | `/cso --diff` | Touches a route and the content-serving path | 1 | resolved | 1 MEDIUM, mitigated |
| QA | live, against production | Observable to any agent using the product | 1 | pass | 0 |
| Design Review | not run | No shell CSS, chrome or front-door markup in the diff | 0 | n/a | — |

**VERDICT:** CLEARED. 231 unit tests, typecheck clean, six integration harnesses green
against production, every guard mutation-checked in both directions.

NO UNRESOLVED DECISIONS
