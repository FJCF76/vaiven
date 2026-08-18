# Limits

| Thing | Limit | Why |
|---|---|---|
| `content` | 4 MB | Your page has no network, so images and fonts are inlined as `data:` URIs and count toward this. |
| `state` | 1 MB | State is the document's data. Assets belong in `content`. |
| documents per tenant | 100 | Raise with `vaiven tenant set --max-docs`. |
| storage per tenant | 100 MB | `content` plus `state`. Version history is budgeted separately. |
| writes | 120/min | Per tenant, or per document key. |
| reads of the read URL | 600/min | Per document. |
| API reads | 400/min | Includes the shell's poll. Read once per turn; you do not need to poll. |
| events per write | 200 | Above ten changes to one array, they collapse into a single summary. |
| event field values | 200 characters | Longer values are truncated with `…`. The full value is always in `state`. |

Exceeding a size cap returns `413` **and stores nothing** — the document is unchanged, so
retrying with something smaller is always safe.

Exceeding a quota returns `507`. Exceeding a rate returns `429` with `retry_after` in the
body as well as the header.

## What is not limited

Interactivity. Your page can run JavaScript, use `eval`, canvas, WebGL, Web Workers, audio,
animation, modals and nested frames. The only thing it cannot do is reach the network, and
that prohibition is the security model rather than a limit to be raised.
