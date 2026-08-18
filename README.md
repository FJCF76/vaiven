# vaiven
Living documents between Claude and people: Claude publishes, the user edits, Claude reads back.

An agent publishes a small web app. A person opens a link and works in it. On any later turn
the agent reads back a diff of what they changed, with a name attached, from a plain URL that
needs no header, no SDK and no JavaScript.

Three layers, and separating them is the whole trick:

| Layer | What it is | Who writes it |
|---|---|---|
| `content` | the app's HTML | the agent |
| `state` | JSON holding the data | the person, and the agent |
| `events` | what changed, with a name attached | derived automatically |

The agent can rewrite the entire app without losing a single value, and the person's edits
come back as a diff rather than a snapshot.

**Writing an app against Vaivén?** You want [`guide.md`](guide.md), not this file. This file
is about running and developing the service.

## What you need

- **Bun 1.3+.** That is the whole toolchain for running and testing: `bun:sqlite` is the
  database driver, so there is no native build step and nothing to install for the server
  itself.
- **The `sqlite3` CLI, on a production host only.** `deploy/backup.sh` and
  `deploy/restore-drill.sh` shell out to it for `.backup` and `PRAGMA integrity_check`;
  `bun:sqlite` does not provide a command-line tool.
- **Two hostnames.** Model-authored HTML is served from a different host than the shell that
  holds the write key. The process refuses to start if the two hosts are equal, because a
  collapsed origin is exactly the failure the design exists to prevent.
- **Caddy** in front of it in production, terminating TLS. The app binds loopback by default,
  and refuses a wildcard bind (`0.0.0.0`, `::`) unless you set `VAIVEN_ALLOW_PUBLIC_BIND=1`.
- **Chromium**, for the live browser suites only. `bunx playwright install chromium` once.
  `bun test` does not need it.

## Run it locally

```bash
bun install
bun run dev
```

`bun run dev` listens on port 8080 and answers to both `http://vaiven.localhost:8080` and
`http://uc.vaiven.localhost:8080`, writing to `./dev.sqlite`. Browsers resolve any
`*.localhost` name to loopback on their own and treat the two names as separate origins, so
there is no hosts file to edit and no certificate to mint. `http` is refused outright unless
**both** hosts end in `.localhost`, because serving the shell over plaintext puts the write
key in the fragment of an interceptable page.

`bun run dev` also sets `VAIVEN_PUBLIC_PORT=8080`, which matters more than it looks. The
origins in `view_url` and `read_url` are built from the *public* port, and it defaults to 80
under `http`, so without it every link the API hands back points at a port nothing is
listening on. Anything else that builds those URLs needs it in its own environment too: the
CLI below, and the live suites further down.

`bun run start` runs the same server with nothing baked in, so you supply the whole
environment yourself. That is what production does, via an `EnvironmentFile` on the systemd
unit.

Mint yourself a tenant and a key. The CLI talks to the database directly, so it needs the
same `VAIVEN_*` environment the server runs with:

```bash
export VAIVEN_APP_HOST=vaiven.localhost VAIVEN_SANDBOX_HOST=uc.vaiven.localhost
export VAIVEN_SCHEME=http VAIVEN_PORT=8080 VAIVEN_PUBLIC_PORT=8080 VAIVEN_DB=./dev.sqlite
bun run cli tenant create "Your Name"
```

The key is printed once and stored hashed. The command also prints a one-line installer that
fetches `/guide.md` into `~/.claude/skills/vaiven/SKILL.md` and writes the host and key
alongside it as `config.json`, so an agent can pick the whole thing up with no further setup.
`bun run cli` with no arguments lists every command: tenant creation, quotas, enable, disable
and key rotation; per-document keys with labels, roles and revocation; and document listing,
inspection and deletion.

Administration is deliberately a CLI and not an API: everything here either mints credentials
or destroys data, and neither belongs behind a browser session on a host that also serves
model-authored HTML.

## Tests

```bash
bun test          # 235 unit tests, no server needed
bun run typecheck # tsc --noEmit
```

Six more suites run against a **live** server, because the things they check (headers, the
proxy, the certificate, cross-origin behaviour, real concurrency) cannot be proven by calling
functions. Each needs the same `VAIVEN_*` environment the server itself is running with, plus
`VAIVEN_TENANT_KEY` from `tenant create`. `gate.ts` is the exception: it runs without a key
and skips only the check that has to mint a document.

| Suite | What it proves |
|---|---|
| `bun run test/gate.ts` (`bun run gate`) | The Phase 0 blocking gates: opaque origin under direct navigation, the host partition, both CSP headers byte-exact, and the conformance canary. Run it against the **real deployment** before shipping: localhost proves the code, but only a real request proves the headers, the proxy and the certificate. |
| `bun run test/negatives.ts` | The security negatives. Also needs `VAIVEN_TENANT_KEY_B`, a **second** tenant's key, to prove cross-tenant isolation. |
| `bun run test/loop.ts` | The whole loop end to end: publish, edit in a browser, read back the diff. |
| `bun run test/fields.ts` | Every field type captures, restores and diffs correctly. |
| `bun run test/invariants.ts` | The database invariants hold under load. Needs the server's `VAIVEN_DB`. |
| `bun run test/repaint.ts` | The worked example **in `guide.md`** survives a real cursor. It reads the example out of the manual, publishes it, and types one character at a time. Two defects shipped in that example because the earlier fixture used `fill()`, which sets a value in one shot and never exercises the keystroke path. |

With `bun run dev` already serving and the exports above still in your shell:

```bash
export VAIVEN_TENANT_KEY=...       # from `tenant create`
export VAIVEN_PUBLIC_PORT=8080     # the suites follow the URLs the API returns
bun run gate
```

## Configuration

Everything is environment. The two hosts are the only variables with no default, because
guessing a hostname is how the two origins silently become one. Everything else falls back to
the production-shaped value in the table.

| Variable | Default | What it does |
|---|---|---|
| `VAIVEN_APP_HOST` | none, required | The shell's host. Holds the write key. |
| `VAIVEN_SANDBOX_HOST` | none, required | The content host. Serves model-authored HTML under `Content-Security-Policy: sandbox`. Must differ from `VAIVEN_APP_HOST`. |
| `VAIVEN_DB` | `/var/lib/vaiven/db.sqlite` | SQLite file. |
| `VAIVEN_SCHEME` | `https` | `http` is refused unless **both** hosts end in `.localhost`. |
| `VAIVEN_PORT` | `8080` | The port this process listens on, behind the proxy. |
| `VAIVEN_PUBLIC_PORT` | `443`, or `80` under `http` | The port the world reaches you on. It is the one that belongs in an origin, so CSP host-sources match. |
| `VAIVEN_BIND` | `127.0.0.1` | The interface to listen on. |
| `VAIVEN_ALLOW_PUBLIC_BIND` | unset | Set to `1` to permit a wildcard bind (`0.0.0.0`, `::`). Only those two are guarded; a specific public address is accepted without it. |
| `VAIVEN_TRUSTED_PROXY_HOPS` | `1` | How many proxies to count back through for the client IP. `0`-`4`. |

### The manual is rewritten for your origin

`guide.md` and the pages under `guide/` are written against the canonical origin,
`https://vaiven.owncompute.com`. That is deliberate, and it matters if you self-host: the file
you read in this repo is a **working manual**, not a template. Every URL in it is complete and
fetchable as it stands.

When your server serves those pages it substitutes the canonical origin for whatever
`VAIVEN_APP_HOST` and `VAIVEN_SANDBOX_HOST` resolve to, so your readers get *your* host. On the
canonical instance the substitution is a no-op.

Two consequences worth knowing:

- **Do not edit the origin out of `guide.md`.** You would be fighting the substitution and
  carrying a merge conflict forever. Set the environment variables instead.
- **Read the manual from your own server, not from the repo**, if you want to see exactly what
  your agents receive: `curl https://your-host/guide.md`.

The failure mode is deliberately safe. If the substitution is ever bypassed, a reader gets the
canonical URL, which works, rather than a broken path. That is why the file stores a real URL
instead of a placeholder like `$HOST` — a placeholder is not a URL, an agent's fetch tool cannot
open it, and in a shell an unset variable silently expands to nothing.

## Deploying

`deploy/` holds everything the production host needs, and each file explains itself:

- `Caddyfile` — both hostnames terminate at one upstream. Caddy deliberately does **not**
  route by host; that partition is a security boundary and lives in `src/index.ts`, where it
  is gate-tested. Path logging is off, because `/r/<read_key>.json` puts a secret in a path.
- `vaiven.service` — the systemd unit, hardened.
- `vaiven-backup.service` / `vaiven-backup.timer` — a verified hot backup every six hours,
  with an integrity check and a WAL checkpoint.
- `backup.sh`, `restore-drill.sh`, `sync.sh` — the backup, the rehearsed restore, and the
  deploy sync. The backup reads `VAIVEN_BACKUP_DIR` (default `/var/lib/vaiven/backups`) and
  `VAIVEN_BACKUP_KEEP` (default 14). At the six-hourly cadence 14 copies is three and a half
  days of history, so raise it if you want to be able to reach further back.

## Where the docs are

| File | For whom |
|---|---|
| [`guide.md`](guide.md) | The agent-facing manual. Served live at `/guide.md`, so an agent can bootstrap from one fetch. |
| [`guide/app-mode.md`](guide/app-mode.md) | Depth on app mode, for when the person can add, remove or reorder rows. `guide.md` already covers this well enough to build from; this page is the longer version. |
| [`guide/errors.md`](guide/errors.md) | Every error code and what to do about it. |
| [`guide/limits.md`](guide/limits.md) | Size limits, quotas and rate limits. |
| [`docs/designs/vaiven-v1.md`](docs/designs/vaiven-v1.md) | The reviewed design doc: why it is built this way, and the amendments layered on the spec. |
| [`docs/designs/well-formed-urls.md`](docs/designs/well-formed-urls.md) | Why the manual stores real URLs rather than a placeholder, and how the serve-time rewrite works. |
| [`docs/designs/agent-onboarding.md`](docs/designs/agent-onboarding.md) | Why the error hints stopped naming a CLI, and what a keyless agent is told instead. |
| [`CHANGELOG.md`](CHANGELOG.md) | What shipped, per version. |
| [`TODOS.md`](TODOS.md) | What is known to be missing, with priorities. |
