# Limits

| Thing | Limit | Why |
|---|---|---|
| `content` | 4 MB | Your page has no network, so images and fonts are inlined as `data:` URIs and count toward this. |
| `state` | 1 MB | State is the document's data. Assets belong in `content`. |
| documents per tenant | 100 | Only the instance operator can raise it. |
| storage per tenant | 100 MB | `content` plus `state`. Version history is budgeted separately. |
| writes | 120/min | Per tenant, or per document key. |
| reads of the read URL | 600/min | Per document. |
| API reads | 400/min | Includes the shell's poll. Read once per turn; you do not need to poll. |
| events per write | 200 | Above ten changes to one array, they collapse into a single summary. |
| event field values | 200 characters | Longer values are truncated with `…`. The full value is always in `state`. The `item` label on an array add or remove is held to 40. |
| `title` | 200 characters | Refused, not shortened — see below. |
| `sender_note` | 500 characters | Shown to the person above the document. |
| key labels | 80 characters | This is what `actor` shows in the log. Double quotes are removed from it — see below. |

Exceeding a size cap returns `413` **and stores nothing** — the document is unchanged, so
retrying with something smaller is always safe. That includes the short text fields: a
title one character over the limit is refused rather than quietly shortened, because a
title that comes back different from the one you sent is worse than an error you can see.

**Two narrow exceptions to that principle, stated plainly because they contradict it.**
`title`, `sender_note` and key labels have some characters removed before the length is
counted, so those values *can* come back different from what you sent:

- **Bidirectional overrides and isolates, zero-width characters, and the byte-order mark**
  are stripped from all three. They are invisible by definition, so refusing the write with
  an error naming a character nobody can see is worse than removing it. A right-to-left
  override is the specific worry: dropped into a name, it reverses the sentence printed
  around it.
- **Double quotes, straight and curly, are stripped from key labels only.** The shell prints
  the label inside quotation marks when it tells a person their edits are recorded and under
  what name. A label that closes its own quote can then continue in that sentence's voice
  and appear to promise something the system does not do. The label is also rendered in its
  own element for the same reason. Apostrophes survive: O'Neill and D'Angelo are names.

Both happen before the length check, so the 80, 200 and 500 character budgets buy characters
that survive to be displayed. Read the value back off the response if you need to know what
was stored.

The one deliberate exception is event field values, which are summaries by design; the full
value is always in `state`, and the truncation is marked with `…`.

Exceeding a quota returns `507`. Exceeding a rate returns `429` with `retry_after` in the
body as well as the header.

## What coalescing will and will not merge

Two adjacent events are presented as one only when every one of these holds. Anything else
is a barrier, and a barrier is returned exactly as it was stored.

- Both are `kind: "edit"`, with a non-empty `field` and no `op`. Array element events name a
  distinct element each, so two `add`s are two elements and never one.
- Same `actor`. Two people editing the same field stay two events, which is the entire point
  of `actor` being on the event at all.
- Both `from` and `to` are present. A missing endpoint is not an empty one.
- The previous `to` equals the next `from`. Same actor and same field do not imply the value
  was continuous — a `?force=1` write or a conflict merge can move it in between — and
  presenting `a → y` for a stored `a → b` then `x → y` would report a change that never
  happened.
- The gap between them is between zero and ten minutes. That is measured between each pair,
  not across the whole run: edits nine minutes apart chain, so a single summary can cover
  hours and several versions. Events arrive ordered by id, not by clock, so a timestamp that
  goes backwards is treated as a barrier rather than as a very small gap.
- Neither carries `note`, `payload` or `item`. Merging one would drop that silently.

A run that ends on the value it started from is **not** merged; its events pass through as
stored. Merging it would produce an event saying nothing changed, and dropping it would make
the history depend on when you happened to read.

How much collapses depends on how much of a burst is in one response, so two readers on
different schedules can see different event counts for the same edits. Neither is missing
anything. `raw=1` returns the stored log on both read surfaces, and `next_since` is the same
number either way.

## What is not limited

Interactivity. Your page can run JavaScript, use `eval`, canvas, WebGL, Web Workers, audio,
animation, modals and nested frames. The only thing it cannot do is reach the network, and
that prohibition is the security model rather than a limit to be raised.
