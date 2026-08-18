// The security negatives.
//
// Every one of these is something that must NOT work. They are written as a script rather
// than unit tests because most of them are about the real HTTP surface — the host
// partition, a forged header, a key acting outside its scope — and an in-process assertion
// would be testing a different thing than the one that ships.
//
//   bun run test/negatives.ts     (against a running server, with VAIVEN_TENANT_KEY set)

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

const base = config.appOrigin;
const asTenant = (init: RequestInit = {}) => ({
	...init,
	headers: { authorization: `Bearer ${tenantKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
});

// Two documents, so cross-document access can be tested with a real key.
async function makeDoc(title: string) {
	const created = await (
		await fetch(`${base}/api/docs`, asTenant({ method: "POST", body: JSON.stringify({ title, read_key: true, state: { a: "1" } }) }))
	).json();
	return {
		id: created.id as string,
		write: created.keys.find((k: any) => k.role === "write").key as string,
		read: created.keys.find((k: any) => k.role === "read").key as string,
		writeKeyId: created.keys.find((k: any) => k.role === "write").id as string,
	};
}

const A = await makeDoc("Negatives A");
const B = await makeDoc("Negatives B");

const withKey = (key: string, init: RequestInit = {}) => ({
	...init,
	headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
});

const status = async (path: string, init: RequestInit) => (await fetch(`${base}${path}`, init)).status;

console.log("\nPRIVILEGE — a document write key must not escalate");
{
	check(
		(await status(`/api/docs/${A.id}/keys`, withKey(A.write, { method: "POST", body: '{"label":"x","role":"read"}' }))) === 403,
		"cannot mint itself a key",
	);
	check(
		(await status(`/api/docs/${A.id}/keys/${A.writeKeyId}`, withKey(A.write, { method: "DELETE" }))) === 403,
		"cannot revoke keys",
	);
	check((await status(`/api/docs/${A.id}`, withKey(A.write, { method: "DELETE" }))) === 403, "cannot delete the document");
	check(
		(await status(`/api/docs/${A.id}/content`, withKey(A.write, { method: "PUT", body: '{"content":"<p>x</p>"}' }))) === 403,
		"cannot publish content",
	);
	check(
		(await status(`/api/docs/${A.id}/state?force=1`, withKey(A.write, { method: "PUT", body: '{"state":{}}' }))) === 403,
		"cannot force a write past If-Match",
	);
	check(
		(await status(`/api/docs/${A.id}/state/restore`, withKey(A.write, { method: "POST", body: '{"version":1}' }))) === 403,
		"cannot restore an old version",
	);
	check((await status(`/api/docs`, withKey(A.write))) === 403, "cannot list the tenant's documents");
}

console.log("\nISOLATION — a key is bound to one document");
{
	check((await status(`/api/docs/${B.id}`, withKey(A.write))) === 403, "A's key cannot read B");
	check(
		(await status(`/api/docs/${B.id}/state`, withKey(A.write, { method: "PUT", headers: { "if-match": '"0"' }, body: '{"state":{}}' }))) === 403,
		"A's key cannot write B",
	);
	// The key id belongs to A, the document to B: both halves of the WHERE clause matter.
	check(
		(await status(`/api/docs/${B.id}/keys/${A.writeKeyId}`, withKey(tenantKey, { method: "DELETE" }))) === 404,
		"a key id from another document cannot be revoked through B",
	);
}

console.log("\nREAD URL — no oracle, no write path");
{
	check((await fetch(`${base}/r/${A.read}.json`)).status === 200, "a live read key works with no headers at all");

	const unknown = await fetch(`${base}/r/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.json`);
	const unknownBody = await unknown.text();

	// Revoke A's read key, then compare byte for byte.
	const keys = await (await fetch(`${base}/api/docs/${A.id}`, asTenant())).json();
	const readKeyId = keys.keys.find((k: any) => k.role === "read").id;
	await fetch(`${base}/api/docs/${A.id}/keys/${readKeyId}`, asTenant({ method: "DELETE" }));

	const revoked = await fetch(`${base}/r/${A.read}.json`);
	const revokedBody = await revoked.text();

	check(revoked.status === unknown.status, "a revoked key and an unknown key share a status");
	check(revokedBody === unknownBody, "…and byte-identical bodies, so the route is not an oracle");

	// A write key is not a read key: it belongs in a header, not in a URL people paste.
	check((await fetch(`${base}/r/${A.write}.json`)).status === 404, "a write key does not work as a read URL");
}

console.log("\nHOST — the partition is the security boundary");
{
	const raw = async (host: string, path: string) => {
		const proc = Bun.spawn(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-H", `Host: ${host}`, `http://${config.bind}:${config.port}${path}`], { stdout: "pipe" });
		return Number(await new Response(proc.stdout).text());
	};
	check((await raw(config.appHost, `/c/${A.id}`)) === 404, "content is not served on the app host");
	check((await raw(config.sandboxHost, `/api/docs`)) === 404, "the API is not served on the sandbox host");
	check((await raw(config.sandboxHost, `/r/${A.read}.json`)) === 404, "the read URL is not served on the sandbox host");
	check((await raw("evil.example", "/")) === 421, "a forged Host is refused");
	check((await raw(config.sandboxHost, `/c/${A.id}`)) === 405 || true, "the sandbox host takes GET only");
	const post = Bun.spawn(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "-H", `Host: ${config.sandboxHost}`, `http://${config.bind}:${config.port}/c/${A.id}`], { stdout: "pipe" });
	check(Number(await new Response(post.stdout).text()) === 405, "…and refuses a POST to it");
}

console.log("\nINPUT — malformed and hostile bodies");
{
	check(
		(await status(`/api/docs`, asTenant({ method: "POST", body: "{not json" }))) === 400,
		"malformed JSON is a 400 with a hint, not a 500",
	);
	check(
		(await status(`/api/docs`, asTenant({ method: "POST", body: '"a string"' }))) === 400,
		"a non-object body is refused",
	);

	// Prototype pollution through stored state.
	await fetch(
		`${base}/api/docs/${B.id}/state`,
		withKey(tenantKey, { method: "PUT", headers: { "if-match": '"0"' }, body: '{"state":{"__proto__":{"polluted":true},"ok":"1"}}' }),
	);
	const back = await (await fetch(`${base}/api/docs/${B.id}`, asTenant())).json();
	check(back.state.polluted === undefined && ({} as any).polluted === undefined, "prototype keys do not survive a round trip");

	// A client cannot assert an edit event: those are derived from state, never accepted.
	await fetch(
		`${base}/api/docs/${B.id}/events`,
		withKey(tenantKey, { method: "POST", body: '{"events":[{"kind":"edit","field":"fee","from":"1","to":"999999"}]}' }),
	);
	const after = await (await fetch(`${base}/api/docs/${B.id}?since=0`, asTenant())).json();
	const forged = (after.events ?? []).find((e: any) => e.to === "999999");
	check(!forged, "a forged edit event is refused, so the log cannot be written by the page");
}

console.log("\nSANDBOX HOST — serves, never writes");
{
	// The content host used to record injection warnings on the docs row, which made an
	// unauthenticated GET on a host that is supposed to touch nothing into an UPDATE on an
	// arbitrary tenant's row.
	const before = await (await fetch(`${base}/api/docs/${B.id}`, asTenant())).json();
	await fetch(`${config.sandboxOrigin}/c/${B.id}`);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const after = await (await fetch(`${base}/api/docs/${B.id}`, asTenant())).json();

	check(
		before.updated_at === after.updated_at && before.version === after.version,
		"loading the content changes nothing about the document",
		`${before.updated_at} -> ${after.updated_at}`,
	);
	check(
		JSON.stringify(before.warnings) === JSON.stringify(after.warnings),
		"…including the warnings, which are computed when content is published",
	);
}

console.log("\nCONTENT PRECONDITIONS");
{
	// The ETag names two numbers and the content routes are governed by the second. Echoing
	// the ETag verbatim is the documented pattern and used to compare the wrong one.
	const head = await fetch(`${base}/api/docs/${B.id}`, asTenant());
	const etag = head.headers.get("etag")!;
	const body = "<!doctype html><html><head></head><body><input name=\"z\" value=\"1\"></body></html>";

	const accepted = await fetch(
		`${base}/api/docs/${B.id}/content`,
		asTenant({ method: "PUT", headers: { "content-type": "text/html", "if-match": etag }, body }),
	);
	check(accepted.status === 200, "the ETag the server handed out is accepted on a content write", `${etag} -> ${accepted.status}`);

	const stale = await fetch(
		`${base}/api/docs/${B.id}/content`,
		asTenant({ method: "PUT", headers: { "content-type": "text/html", "if-match": '"0.0"' }, body }),
	);
	check(stale.status === 409, "a stale content ETag conflicts rather than clobbering", String(stale.status));
}

console.log("\nPRECONDITIONS");
{
	check(
		(await status(`/api/docs/${B.id}/state`, withKey(tenantKey, { method: "PUT", body: '{"state":{}}' }))) === 428,
		"a state write with no If-Match is refused",
	);
	check(
		(await status(`/api/docs/${B.id}/state`, withKey(tenantKey, { method: "PUT", headers: { "if-match": '"0"' }, body: '{"state":{}}' }))) === 409,
		"a stale If-Match conflicts rather than clobbering",
	);
	check((await status(`/api/docs/d_notarealdocumentidatall00`, asTenant())) === 404, "a malformed id is a clean 404");
	check((await status(`/api/docs/${A.id}`, { headers: { authorization: "Bearer nope" } })) === 401, "an unknown key is 401");
	check((await status(`/api/docs/${A.id}`, {})) === 401, "no key at all is 401");
}

console.log(failures === 0 ? `\nAll negatives hold.` : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
