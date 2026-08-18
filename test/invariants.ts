// Storage invariants across the whole document lifecycle.
//
// The byte counters are the thing most likely to drift silently: they are updated by
// delta on six different paths (create, state write, content write with seeding, restore,
// prune, delete) and nothing reads them back until a quota check refuses a write that
// should have been allowed, or allows one that should not.
//
// So this recomputes them from the rows and compares. It is the "tenant byte counters
// match a full recomputation" invariant from the design doc's chaos test, in a form that
// runs in a few seconds against a live server.
//
//   bun run test/invariants.ts     (needs VAIVEN_TENANT_KEY and the server's VAIVEN_DB)

import { Database } from "bun:sqlite";
import { loadConfig } from "../src/config.ts";

const config = loadConfig();
const tenantKey = process.env.VAIVEN_TENANT_KEY;
if (!tenantKey) {
	console.error("Set VAIVEN_TENANT_KEY.");
	process.exit(2);
}

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? `\n         ${detail}` : ""}`);
};

const api = (path: string, init: RequestInit = {}) =>
	fetch(`${config.appOrigin}${path}`, {
		...init,
		headers: { authorization: `Bearer ${tenantKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
	});

const db = new Database(config.db, { readonly: true });

interface Drift {
	tenantId: string;
	storedUsed: number;
	realUsed: number;
	storedVersions: number;
	realVersions: number;
}

/** Recompute every counter from the rows that are actually there. */
function recompute(): Drift[] {
	return db
		.query<any, []>("SELECT id, used_bytes, versions_bytes FROM tenants")
		.all()
		.map((tenant) => {
			const real = db
				.query<{ total: number }, [string]>(
					`SELECT coalesce(sum(d.state_bytes), 0) + coalesce((
					   SELECT sum(c.bytes) FROM doc_content c
					    JOIN docs dd ON dd.id = c.doc_id WHERE dd.tenant_id = ?), 0) AS total
					   FROM docs d WHERE d.tenant_id = ?`,
				)
				.get(tenant.id, tenant.id)!.total;

			const realVersions = db
				.query<{ total: number }, [string]>(
					`SELECT coalesce(sum(v.bytes), 0) AS total FROM state_versions v
					   JOIN docs d ON d.id = v.doc_id WHERE d.tenant_id = ?`,
				)
				.get(tenant.id)!.total;

			return {
				tenantId: tenant.id,
				storedUsed: tenant.used_bytes,
				realUsed: real,
				storedVersions: tenant.versions_bytes,
				realVersions,
			};
		});
}

function assertNoDrift(label: string): void {
	const drifts = recompute().filter(
		(d) => d.storedUsed !== d.realUsed || d.storedVersions !== d.realVersions,
	);
	check(
		drifts.length === 0,
		label,
		drifts
			.map(
				(d) =>
					`${d.tenantId}: used ${d.storedUsed} stored vs ${d.realUsed} real; versions ${d.storedVersions} vs ${d.realVersions}`,
			)
			.join("\n         "),
	);
}

console.log(`\nStorage invariants against ${config.db}\n`);

const CONTENT = `<!doctype html><html><head></head><body><input name="fee" value="18400"></body></html>`;

// 1. create
const created = await (
	await api("/api/docs", { method: "POST", body: JSON.stringify({ title: "Invariants", content: CONTENT, state: {} }) })
).json();
const id: string = created.id;
assertNoDrift("counters agree after create");

// 2. several state writes, enough to exercise version retention
let version = 0;
for (let i = 1; i <= 6; i++) {
	const response = await api(`/api/docs/${id}/state`, {
		method: "PUT",
		headers: { "if-match": `"${version}"` },
		body: JSON.stringify({ state: { fee: String(18400 - i * 100), note: "x".repeat(i * 50) } }),
	});
	version = (await response.json()).version;
}
assertNoDrift("counters agree after six state writes");

// 3. a republish that introduces a new field, which seeds state
await api(`/api/docs/${id}/content`, {
	method: "PUT",
	headers: { "content-type": "text/html" },
	body: `${CONTENT.replace("</body>", '<input name="deadline" value="14 November"></body>')}`,
});
// This is the path that drifted: seeding writes state_bytes but the tenant counter was
// only being adjusted for the content delta.
assertNoDrift("counters agree after a republish that seeds a new field");

const seeded = await (await api(`/api/docs/${id}`)).json();
check(seeded.state.deadline === "14 November", "the republished field was seeded into state");
check(seeded.state.fee === "17800", "…without touching a value the person had already changed");

// 4. restore
const versions = await (await api(`/api/docs/${id}/state/versions`)).json();
check(versions.versions.length > 0, "versions are retained and readable");
const target = versions.versions[versions.versions.length - 1].version;
const before = (await (await api(`/api/docs/${id}`)).json()).state;
await api(`/api/docs/${id}/state/restore`, { method: "POST", body: JSON.stringify({ version: target }) });
assertNoDrift("counters agree after a restore");

// The state that a restore replaces must itself be recoverable: restoring is a
// destructive write, and the safety net should cover the operation that exists to use it.
const afterRestore = await (await api(`/api/docs/${id}/state/versions`)).json();
const preserved = afterRestore.versions.some((v: any) => v.version === seeded.version + 1);
check(preserved, "the state that the restore replaced was itself snapshotted");

// 5. delete
await api(`/api/docs/${id}`, { method: "DELETE" });
assertNoDrift("counters agree after delete");

const orphans = db
	.query<{ n: number }, [string]>(
		`SELECT (SELECT count(*) FROM doc_keys WHERE doc_id = ?)
		      + (SELECT count(*) FROM events WHERE doc_id = ?)
		      + (SELECT count(*) FROM state_versions WHERE doc_id = ?)
		      + (SELECT count(*) FROM doc_content WHERE doc_id = ?) AS n`,
	)
	.get(id, id, id, id)!.n;
check(orphans === 0, "no orphan rows survive a delete", `${orphans} left behind`);

console.log(failures === 0 ? "\nAll invariants hold." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
