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

## What is not limited

Interactivity. Your page can run JavaScript, use `eval`, canvas, WebGL, Web Workers, audio,
animation, modals and nested frames. The only thing it cannot do is reach the network, and
that prohibition is the security model rather than a limit to be raised.
