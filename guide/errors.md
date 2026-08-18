# Errors

Every error carries a `hint` saying what to do next. Branch on `code`, never on the message.

```json
{"error":{"code":"conflict","message":"Someone else wrote to this document first.",
          "hint":"Merge your change into the state returned here, then retry with If-Match
                  set to the version returned here. Your write was not applied.",
          "guide":"…/guide/errors.md"},
 "version":7, "state":{…}}
```

| code | status | what happened | what to do |
|---|---|---|---|
| `unauthorized` | 401 | No key, or the key is not valid | Check `~/.claude/skills/vaiven/config.json`. Ask the user to run `vaiven tenant create` if it is missing. |
| `revoked` | 401 | The key existed and was revoked | Ask for a new link. Nothing you do with this key will work again. |
| `read_only` | 403 | A read key tried to write, or a document key tried something tenant-scoped | Not a problem with the key. Key management, deletion, publishing content and `?force=1` need the tenant key. |
| `disabled` | 403 | The tenant is disabled | Ask the operator. Every key of that tenant is off. |
| `not_found` | 404 | No such document, key or route | Check the id. Ids look like `d_` plus 26 characters. |
| `conflict` | 409 | Someone wrote between your read and your write | **Your write was not applied.** The response contains the current `version` and `state`: merge into it and retry. This is routine, not an error to apologise for. |
| `precondition_required` | 428 | A state write with no `If-Match` | Send `If-Match: "<version>"` from your last read. Without it two writers silently overwrite each other. |
| `invalid` | 400 | Malformed body, or a field with the wrong shape | The `field` says which one. If you are building JSON in a shell, write it to a file and use `--data-binary @file`. |
| `too_large` | 413 | One object is over its cap | **Nothing was stored; the document is unchanged.** `limit` and `actual` are in the response. See `limits.md`. |
| `quota_exceeded` | 507 | The tenant is out of documents or storage | Delete a document, or ask the operator to raise it with `vaiven tenant set`. |
| `rate_limited` | 429 | Too many requests this minute | `retry_after` is in the body as well as the header. If you are polling, read once per turn rather than on a timer. |

## The two that are routine

**409 is normal.** You and a person can write at the same time; that is the design working.
Merge and retry. Do not treat it as a failure.

**`read_only` usually means you have the wrong key, not a broken one.** A document has a
write key and, optionally, a read key. The read key is the one that goes in a URL.

## Recovering a lost read URL

Read keys are stored hashed and shown once. If you lose one, mint another and revoke the
old one — do not leave both live:

```bash
curl -s -X POST "$HOST/api/docs/$DOC/keys" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"label":"reader","role":"read"}'
curl -s -X DELETE "$HOST/api/docs/$DOC/keys/$OLD_KEY_ID" -H "Authorization: Bearer $KEY"
```

## Recovering from a bad write

State is versioned. If you overwrote something you should not have:

```bash
curl -s "$HOST/api/docs/$DOC/state/versions" -H "Authorization: Bearer $KEY"
curl -s -X POST "$HOST/api/docs/$DOC/state/restore" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"version":6}'
```

History is pruned by age and size, and keeps at least one version per editing session, so
yesterday is usually still reachable even after a busy afternoon.
