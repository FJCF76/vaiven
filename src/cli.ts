#!/usr/bin/env bun
// Administration. Deliberately not an API and deliberately not a web panel: everything
// here either mints credentials or destroys data, and neither belongs behind a browser
// session on a host that also serves model-authored HTML.

import { loadConfig } from "./config.ts";
import { migrate, open } from "./db.ts";
import { hashKey, insertDocKey, mintKey } from "./auth.ts";
import { newTenantId } from "./ids.ts";
import { writeTx } from "./db.ts";

const config = loadConfig();
const db = open(config.db);
migrate(db);

const [, , group, action, ...rest] = process.argv;

function flag(name: string, fallback?: string): string | undefined {
	const index = rest.indexOf(`--${name}`);
	if (index === -1) return fallback;
	return rest[index + 1] ?? fallback;
}

function positional(index: number): string | undefined {
	return rest.filter((value, i) => !value.startsWith("--") && !(i > 0 && rest[i - 1]?.startsWith("--")))[index];
}

function die(message: string): never {
	console.error(message);
	process.exit(1);
}

const usage = `vaiven — administration

  tenant create <name> [--contact <email>] [--read-keys]
  tenant list
  tenant set <id> [--max-docs N] [--max-bytes N] [--read-keys 0|1] [--contact <email>]
  tenant disable <id>
  tenant enable <id>
  tenant rotate-key <id>

  key add <doc-id> --label <name> [--role write|read]
  key list <doc-id>
  key revoke <key-id>

  doc list [--tenant <id>]
  doc show <doc-id>
  doc delete <doc-id>
`;

// -------------------------------------------------------------------------- tenants

if (group === "tenant" && action === "create") {
	const name = positional(0) ?? die("A tenant needs a name: vaiven tenant create \"Fernando\"");
	const { plaintext, hash } = mintKey();
	const id = newTenantId();

	writeTx(db, () =>
		db
			.query(
				"INSERT INTO tenants (id, name, key_hash, mint_read_key, contact, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(id, name, hash, rest.includes("--read-keys") ? 1 : 0, flag("contact") ?? null, Date.now()),
	);

	// A12: the cold-start problem. The skill file is byte-identical for every user, so it
	// can carry neither the key nor the host. Without this line the story is "ask someone
	// with SSH", and after a context compaction the key is gone again.
	console.log(`
Tenant created.

  id    ${id}
  name  ${name}
  key   ${plaintext}

This key is shown ONCE. It is stored hashed; nobody can recover it, including you.

Install the skill and its config in one line:

  mkdir -p ~/.claude/skills/vaiven && \\
    curl -fsS -o ~/.claude/skills/vaiven/SKILL.md ${config.appOrigin}/guide.md && \\
    printf '{"host":"%s","key":"%s"}\\n' "${config.appOrigin}" "${plaintext}" \\
      > ~/.claude/skills/vaiven/config.json && \\
    chmod 600 ~/.claude/skills/vaiven/config.json

Then tell the agent: read ~/.claude/skills/vaiven/SKILL.md and config.json.

That first line is also the update: re-run it whenever Vaivén changes. The copy it writes
carries the version it was taken at, so an agent can tell a stale manual from a current one.
`);
	process.exit(0);
}

if (group === "tenant" && action === "list") {
	const rows = db
		.query<any, []>(
			"SELECT id, name, disabled, mint_read_key, used_bytes, max_bytes, contact, created_at FROM tenants ORDER BY created_at",
		)
		.all();
	if (rows.length === 0) console.log("No tenants yet. Create one: vaiven tenant create \"Name\"");
	for (const row of rows) {
		const docs = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM docs WHERE tenant_id = ?").get(row.id)!.n;
		console.log(
			`${row.id}  ${row.disabled ? "DISABLED" : "active  "}  ${docs} docs  ` +
				`${(row.used_bytes / 1048576).toFixed(1)}/${(row.max_bytes / 1048576).toFixed(0)} MB  ` +
				`read-keys:${row.mint_read_key ? "on" : "off"}  ${row.name}${row.contact ? `  <${row.contact}>` : ""}`,
		);
	}
	process.exit(0);
}

if (group === "tenant" && (action === "disable" || action === "enable")) {
	const id = positional(0) ?? die(`vaiven tenant ${action} <tenant-id>`);
	const changes = writeTx(db, () =>
		db.query("UPDATE tenants SET disabled = ? WHERE id = ?").run(action === "disable" ? 1 : 0, id).changes,
	);
	if (changes === 0) die(`No tenant ${id}.`);
	// Worth stating, because it is the behaviour the resolver join exists to provide.
	console.log(
		action === "disable"
			? `${id} disabled. Its tenant key AND every document key it ever issued stop working.`
			: `${id} enabled. Keys that were not individually revoked work again.`,
	);
	process.exit(0);
}

if (group === "tenant" && action === "set") {
	const id = positional(0) ?? die("vaiven tenant set <tenant-id> [--max-docs N] …");
	const updates: string[] = [];
	const values: unknown[] = [];
	for (const [name, column] of [
		["max-docs", "max_docs"],
		["max-bytes", "max_bytes"],
		["read-keys", "mint_read_key"],
	] as const) {
		const value = flag(name);
		if (value !== undefined) {
			updates.push(`${column} = ?`);
			values.push(Number(value));
		}
	}
	const contact = flag("contact");
	if (contact !== undefined) {
		updates.push("contact = ?");
		values.push(contact);
	}
	if (updates.length === 0) die("Nothing to set. See: vaiven");
	const changes = writeTx(db, () =>
		db.query(`UPDATE tenants SET ${updates.join(", ")} WHERE id = ?`).run(...(values as any), id).changes,
	);
	if (changes === 0) die(`No tenant ${id}.`);
	console.log(`${id} updated.`);
	process.exit(0);
}

// A13: the key is printed once and stored hashed, so without this the operator can lock
// themselves out of their own tenant permanently.
if (group === "tenant" && action === "rotate-key") {
	const id = positional(0) ?? die("vaiven tenant rotate-key <tenant-id>");
	const { plaintext, hash } = mintKey();
	const changes = writeTx(db, () => db.query("UPDATE tenants SET key_hash = ? WHERE id = ?").run(hash, id).changes);
	if (changes === 0) die(`No tenant ${id}.`);
	console.log(`\n  new key  ${plaintext}\n\nThe previous key stopped working just now. Document keys are unaffected.\n`);
	process.exit(0);
}

// ----------------------------------------------------------------------------- keys

if (group === "key" && action === "add") {
	const docId = positional(0) ?? die("vaiven key add <doc-id> --label \"Marta\" [--role write]");
	const label = flag("label") ?? die("A key needs a label — it becomes the actor on everything written with it.");
	const role = (flag("role", "write") === "read" ? "read" : "write") as "read" | "write";
	if (!db.query("SELECT 1 FROM docs WHERE id = ?").get(docId)) die(`No document ${docId}.`);

	const minted = writeTx(db, () => insertDocKey(db, docId, label, role));
	const url =
		role === "write"
			? `${config.appOrigin}/d/${docId}#k=${minted.plaintext}`
			: `${config.appOrigin}/r/${minted.plaintext}.json`;
	console.log(`\n  ${minted.id}  ${role}  ${label}\n\n  ${url}\n\nShown once.\n`);
	process.exit(0);
}

if (group === "key" && action === "list") {
	const docId = positional(0) ?? die("vaiven key list <doc-id>");
	const rows = db
		.query<any, [string]>(
			"SELECT id, label, role, last_seen, seen_ips, revoked_at FROM doc_keys WHERE doc_id = ? ORDER BY created_at",
		)
		.all(docId);
	if (rows.length === 0) console.log(`No keys on ${docId}.`);
	for (const row of rows) {
		let ips = 0;
		try {
			ips = JSON.parse(row.seen_ips).length;
		} catch {}
		console.log(
			`${row.id}  ${row.role.padEnd(5)}  ${row.revoked_at ? "REVOKED " : "live    "}` +
				`seen:${row.last_seen ? new Date(row.last_seen).toISOString().slice(0, 16) : "never".padEnd(16)}  ` +
				// A13: the only leak signal this design can offer. A read URL used from
				// five different addresses is worth a second look.
				`ips:${ips}  ${row.label}`,
		);
	}
	process.exit(0);
}

if (group === "key" && action === "revoke") {
	const keyId = positional(0) ?? die("vaiven key revoke <key-id>");
	const changes = writeTx(db, () =>
		db.query("UPDATE doc_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), keyId).changes,
	);
	if (changes === 0) die(`No live key ${keyId}.`);
	console.log(`${keyId} revoked. Any link containing it is now dead.`);
	process.exit(0);
}

// ------------------------------------------------------------------------------ docs

if (group === "doc" && action === "list") {
	const tenant = flag("tenant");
	const rows = tenant
		? db.query<any, [string]>("SELECT id, tenant_id, title, version, updated_at FROM docs WHERE tenant_id = ? ORDER BY updated_at DESC").all(tenant)
		: db.query<any, []>("SELECT id, tenant_id, title, version, updated_at FROM docs ORDER BY updated_at DESC").all();
	if (rows.length === 0) console.log("No documents.");
	for (const row of rows) {
		console.log(
			`${row.id}  v${String(row.version).padEnd(4)}  ${new Date(row.updated_at).toISOString().slice(0, 16)}  ${row.title || "(untitled)"}`,
		);
	}
	process.exit(0);
}

if (group === "doc" && action === "show") {
	const id = positional(0) ?? die("vaiven doc show <doc-id>");
	const doc = db.query<any, [string]>("SELECT * FROM docs WHERE id = ?").get(id);
	if (!doc) die(`No document ${id}.`);
	const content = db.query<any, [string]>("SELECT content_version, bytes FROM doc_content WHERE doc_id = ?").get(id);
	const events = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM events WHERE doc_id = ?").get(id)!.n;
	const versions = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM state_versions WHERE doc_id = ?").get(id)!.n;
	console.log(
		`
  id              ${doc.id}
  tenant          ${doc.tenant_id}
  title           ${doc.title || "(untitled)"}
  state version   ${doc.version}   (${doc.state_bytes} bytes)
  content version ${content?.content_version ?? 0}   (${content?.bytes ?? 0} bytes)
  events          ${events}
  stored versions ${versions}
  webhook         ${doc.webhook_url ?? "none"}
  updated         ${new Date(doc.updated_at).toISOString()}
`,
	);
	process.exit(0);
}

if (group === "doc" && action === "delete") {
	const id = positional(0) ?? die("vaiven doc delete <doc-id>");
	if (!db.query("SELECT 1 FROM docs WHERE id = ?").get(id)) die(`No document ${id}.`);

	// The cascade removes the rows; it cannot know about the tenant's byte counters. This
	// path used to drop the row and leave the bytes charged forever, so a tenant that
	// created and deleted documents would eventually be refused a write for space it was
	// no longer using — and nothing reads the counters back to notice.
	writeTx(db, () => {
		const doc = db
			.query<{ tenant_id: string; state_bytes: number }, [string]>(
				"SELECT tenant_id, state_bytes FROM docs WHERE id = ?",
			)
			.get(id)!;
		const contentBytes =
			db.query<{ bytes: number }, [string]>("SELECT bytes FROM doc_content WHERE doc_id = ?").get(id)?.bytes ?? 0;
		const versionBytes = db
			.query<{ total: number }, [string]>("SELECT coalesce(sum(bytes), 0) AS total FROM state_versions WHERE doc_id = ?")
			.get(id)!.total;

		db.query("DELETE FROM docs WHERE id = ?").run(id);
		db.query(
			"UPDATE tenants SET used_bytes = max(0, used_bytes - ?), versions_bytes = max(0, versions_bytes - ?) WHERE id = ?",
		).run(doc.state_bytes + contentBytes, versionBytes, doc.tenant_id);
	});

	console.log(`${id} deleted, with its keys, events and stored versions.`);
	process.exit(0);
}

console.log(usage);
process.exit(group ? 1 : 0);
