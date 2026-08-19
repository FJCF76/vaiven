# Errors

Every error carries a `hint` saying what to do next. Branch on `code`, never on the message.

```json
{"error":{"code":"conflict","message":"Someone else wrote to this document first.",
          "hint":"Merge your change into the state returned here, then retry with If-Match
                  set to the version returned here. Your write was not applied.",
          "guide":"https://vaiven.owncompute.com/guide/errors.md"},
 "version":7, "state":{…}}
```

| code | status | what happened | what to do |
|---|---|---|---|
| `unauthorized` | 401 | No key, or the key is not valid | Check `~/.claude/skills/vaiven/config.json`. If it is missing, ask the human you are working with for a tenant key — there is no endpoint that issues one. |
| `revoked` | 401 | The key existed and was revoked | Ask for a new link. Nothing you do with this key will work again. |
| `read_only` | 403 | A read key tried to write, or a document key tried something tenant-scoped | Not a problem with the key. A document key may read, write `state` and append events; publishing `content`, version history, key management, deletion, the webhook and `?force=1` all need the tenant key. |
| `disabled` | 403 | The tenant is disabled | Ask the operator. Every key of that tenant is off. |
| `not_found` | 404 | No such document, key or route | Check the id. Ids look like `d_` plus 26 characters. |
| `conflict` | 409 | Someone wrote between your read and your write | **Your write was not applied.** The response contains the current `version` and `state`: merge into it and retry. This is routine, not an error to apologise for. |
| `precondition_required` | 428 | A state write with no `If-Match` | Send `If-Match: "<version>"` from your last read. Without it two writers silently overwrite each other. |
| `invalid` | 400 | Malformed body, or a field with the wrong shape | The `field` says which one. If you are building JSON in a shell, write it to a file and use `--data-binary @file`. |
| `too_large` | 413 | One object is over its cap | **Nothing was stored; the document is unchanged.** `limit` and `actual` are in the response. See `limits.md`. |
| `quota_exceeded` | 507 | The tenant is out of documents or storage | Delete a document with `DELETE /api/docs/<id>`. The cap itself can only be raised by the instance operator. |
| `rate_limited` | 429 | Too many requests this minute | `retry_after` is in the body as well as the header. If you are polling, read once per turn rather than on a timer. |

## The two that are routine

**409 is normal.** You and a person can write at the same time; that is the design working.
Merge and retry. Do not treat it as a failure.

**`read_only` usually means you have the wrong key, not a broken one.** A document has a
write key and, optionally, a read key. The read key is the one that goes in a URL.

## Warnings

`warnings` rides every read, and now the create and publish responses too. It is the server
telling you it had to alter what you published, or that your page will not render the way you
wrote it. An empty array means what it says. Branch on `code`, not on the message.

| Code | What happened |
|---|---|
| `added_doctype` | Your content did not start with `<!doctype html>`, so one was added. Without it the browser renders in quirks mode and your layout silently differs from what you wrote. |
| `stripped_meta_csp` | A `<meta http-equiv="Content-Security-Policy">` was removed. Policies compose as a union, so yours could only further restrict the page, including disabling the helper. |
| `stripped_base` | A `<base>` tag was removed. It changes how every relative URL resolves, including the helper's. |
| `dark_mode_no_background` | You have a `prefers-color-scheme: dark` block that never paints a background on `html`, `body` or `:root`. The frame is white in every theme and cannot read the viewer's, so dark rules that only set `color` produce light text on a white page. |
| `no_viewport` | Your CSS uses viewport height units, `position: fixed` or `position: sticky`. The frame is sized to your content, so there is no viewport that scrolls: `100vh` is circular and runs away until it is clamped. |

The last two are the ones you cannot check for yourself. You never see your page render; the
first person who does is the one you sent it to, and they have no way to tell you it was
unreadable. That is what these are for.

## Recovering a lost read URL

Read keys are stored hashed and shown once. If you lose one, mint another and revoke the
old one — do not leave both live. **The mint response hands you the URL already built**;
this is the page an agent reached before it built one by hand and sent a person a dead link:

```bash
curl -s -X POST "https://vaiven.owncompute.com/api/docs/d_YOUR_DOCUMENT_ID/keys" -H "Authorization: Bearer YOUR_TENANT_KEY" \
  -H 'content-type: application/json' -d '{"label":"reader","role":"read"}'
curl -s -X DELETE "https://vaiven.owncompute.com/api/docs/d_YOUR_DOCUMENT_ID/keys/k_YOUR_KEY_ID" -H "Authorization: Bearer YOUR_TENANT_KEY"
```

The mint answers with the key and every URL that key can open:

```json
{ "id": "k_...", "label": "reader", "role": "read",
  "key": "...",
  "view_url": "https://vaiven.owncompute.com/d/d_YOUR_DOCUMENT_ID#k=...",
  "read_url": "https://vaiven.owncompute.com/r/....json" }
```

## Recovering from a bad write

State is versioned. If you overwrote something you should not have:

```bash
curl -s "https://vaiven.owncompute.com/api/docs/d_YOUR_DOCUMENT_ID/state/versions" -H "Authorization: Bearer YOUR_TENANT_KEY"
curl -s -X POST "https://vaiven.owncompute.com/api/docs/d_YOUR_DOCUMENT_ID/state/restore" -H "Authorization: Bearer YOUR_TENANT_KEY" \
  -H 'content-type: application/json' -d '{"version":6}'
```

History is pruned by age and size, and keeps at least one version per editing session, so
yesterday is usually still reachable even after a busy afternoon.
