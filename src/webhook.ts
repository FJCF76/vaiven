// A15: the push half of the read-back channel.
//
// As designed, Vaivén is a mailbox someone has to remember to check — and a human
// remembering to check is the same failure mode the project exists to fix. The server is
// our code and can make outbound calls, so it does.
//
// This is the ONLY outbound network surface in the system. It does not get to inherit the
// "we make no outbound calls" posture it removes, so it carries its own guard rails.

import type { Database } from "bun:sqlite";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const TOTAL_TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

/** One in flight per document, so a slow endpoint cannot pile up. */
const inFlight = new Set<string>();

/**
 * SSRF containment. The webhook URL is attacker-influenced in the sense that whoever can
 * create a document chooses it, and this process sits on a VPS with a metadata endpoint
 * and a loopback-bound database server.
 *
 * Parse to BYTES and test range membership. The first version matched textual prefixes,
 * which let `fec0::` (site-local), `64:ff9b::` (NAT64, whose low 32 bits are an ordinary
 * IPv4 address — including 127.0.0.1) and the expanded spelling `0:0:0:0:0:0:0:1` all pass
 * as public, while blocking every `::ffff:` address outright including public ones.
 */
function ipv4Forbidden(a: number, b: number): boolean {
	return (
		a === 0 || // "this network"
		a === 10 || // private
		a === 127 || // loopback
		(a === 169 && b === 254) || // link-local, including the 169.254.169.254 metadata endpoint
		(a === 172 && b >= 16 && b <= 31) || // private
		(a === 192 && b === 168) || // private
		(a === 192 && b === 0) || // IETF protocol assignments + 192.0.2.0/24 documentation
		(a === 198 && (b === 18 || b === 19)) || // benchmarking
		(a === 198 && b === 51) || // documentation
		(a === 203 && b === 0) || // documentation
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
		a >= 224 // multicast, reserved, broadcast
	);
}

/** Expand an IPv6 address to its sixteen bytes, or null if it will not parse. */
function ipv6Bytes(address: string): number[] | null {
	let text = address.toLowerCase();
	// A trailing dotted quad (::ffff:127.0.0.1, 64:ff9b::8.8.8.8) becomes two groups.
	const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (dotted) {
		const quad = dotted[1]!.split(".").map(Number);
		if (quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
		const hi = ((quad[0]! << 8) | quad[1]!).toString(16);
		const lo = ((quad[2]! << 8) | quad[3]!).toString(16);
		text = `${text.slice(0, -dotted[1]!.length)}${hi}:${lo}`;
	}

	const halves = text.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
	const groups =
		halves.length === 2
			? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
			: head;
	if (groups.length !== 8) return null;

	const bytes: number[] = [];
	for (const group of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
		const value = Number.parseInt(group, 16);
		bytes.push(value >> 8, value & 0xff);
	}
	return bytes;
}

function isForbiddenAddress(address: string): boolean {
	if (isIP(address) === 6) {
		const bytes = ipv6Bytes(address);
		if (!bytes) return true; // unparseable is not a reason to allow it

		const isZero = bytes.every((byte) => byte === 0);
		const isLoopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
		if (isZero || isLoopback) return true;

		// Anything carrying an embedded IPv4 address is judged on that address. There are
		// four such forms and the first version of this handled two of them:
		//   ::ffff:a.b.c.d   v4-mapped
		//   64:ff9b::a.b.c.d NAT64
		//   ::a.b.c.d        v4-compatible, deprecated by RFC 4291 but still parsed
		//   2002:AABB:CCDD:: 6to4, where the v4 address is bytes 2-5
		const v4Mapped =
			bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
		const nat64 =
			bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b;
		const v4Compatible = bytes.slice(0, 12).every((byte) => byte === 0);
		if (v4Mapped || nat64 || v4Compatible) return ipv4Forbidden(bytes[12]!, bytes[13]!);

		// 6to4 embeds the v4 address one word in.
		if (bytes[0] === 0x20 && bytes[1] === 0x02) return ipv4Forbidden(bytes[2]!, bytes[3]!);

		return (
			(bytes[0]! & 0xfe) === 0xfc || // fc00::/7 unique local
			(bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) || // fe80::/10 link local
			(bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) || // fec0::/10 site local (deprecated, still routed)
			bytes[0] === 0xff || // multicast
			(bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) // 2001:db8::/32 documentation
		);
	}

	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	return ipv4Forbidden(parts[0]!, parts[1]!);
}

/**
 * Resolve a hostname and refuse it if ANY answer is non-public.
 *
 * Returned so the delivery path can repeat the check rather than trusting a verdict
 * reached when the webhook was configured — see the note on queueWebhook.
 */
async function resolvesPublicly(hostname: string): Promise<{ ok: true } | { ok: false; reason: string }> {
	// A bare literal never goes to DNS, so check it directly.
	if (isIP(hostname) !== 0) {
		return isForbiddenAddress(hostname)
			? { ok: false, reason: "That address is private, loopback or link-local. Webhooks may only reach the public internet." }
			: { ok: true };
	}

	try {
		const resolved = await lookup(hostname, { all: true });
		if (resolved.length === 0) return { ok: false, reason: "That hostname does not resolve." };
		for (const { address } of resolved) {
			if (isForbiddenAddress(address)) {
				return {
					ok: false,
					reason: "That hostname resolves to a private or link-local address. Webhooks may only reach the public internet.",
				};
			}
		}
	} catch {
		return { ok: false, reason: "That hostname does not resolve." };
	}
	return { ok: true };
}

export async function validateWebhookUrl(raw: string): Promise<{ ok: true } | { ok: false; reason: string }> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: "That is not a URL." };
	}

	if (url.protocol !== "https:") {
		return { ok: false, reason: "Webhooks must be https. Plaintext would put the document's contents on the wire." };
	}

	return await resolvesPublicly(url.hostname);
}

/**
 * Fire and forget, after the transaction has committed.
 *
 * A failure is recorded as an event on the document rather than swallowed: a dead endpoint
 * should be visible in the log the agent already reads, not discovered by its absence.
 */
export function queueWebhook(
	db: Database,
	doc: { id: string; webhook_url: string | null; webhook_secret: string | null },
	payload: unknown,
): void {
	if (!doc.webhook_url || !doc.webhook_secret) return;
	if (inFlight.has(doc.id)) return;
	inFlight.add(doc.id);

	void (async () => {
		// Re-check at DELIVERY time, not only at configuration time. The stored verdict was
		// reached against whatever DNS answered then; a record with a short TTL can answer
		// public once and 127.0.0.1 or 169.254.169.254 for every call after.
		//
		// The check runs before EVERY attempt, not once for the whole loop. Validating once
		// and then retrying three times with backoff authorises about thirty seconds of
		// attacker-timed connections on the strength of a single resolution — three chances
		// to be handed the private answer instead of one.
		//
		// It is still not closed. Bun's fetch does its own resolution and offers no seam to
		// pin the connection to the address we vetted; measured here, the validating lookup
		// does not even populate the cache the fetch uses. A TTL-0 record that alternates
		// answers wins the race. What holds after that is the platform layer: https only, so
		// the target must complete a TLS handshake for the attacker's hostname, and the
		// unit's IPAddressDeny puts the metadata endpoint and every RFC1918 range out of
		// reach regardless of what this code decides.
		const target = new URL(doc.webhook_url!);

		const body = JSON.stringify(payload);
		// Authenticity: without a signature the webhook URL is an unauthenticated push
		// that anyone who learns it can forge.
		const signature = new Bun.CryptoHasher("sha256", doc.webhook_secret!).update(body).digest("hex");

		let lastError = "";
		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			const verdict = await resolvesPublicly(target.hostname);
			if (!verdict.ok) {
				recordFailure(db, doc.id, "refused: the endpoint is not a public address");
				inFlight.delete(doc.id);
				return;
			}

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
			try {
				const response = await fetch(doc.webhook_url!, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"vaiven-signature": `sha256=${signature}`,
						"user-agent": "vaiven/0.1",
					},
					body,
					// A redirect could walk us to a private address after validation passed.
					redirect: "manual",
					signal: controller.signal,
				});
				if (response.status >= 200 && response.status < 300) {
					inFlight.delete(doc.id);
					return;
				}
				// Deliberately coarse. This note is stored as an event and served from
				// /r/<read_key>.json, unauthenticated and with access-control-allow-origin
				// *, so an exact status code or a transport error message turns a webhook
				// into a port scanner whose results anyone with the read URL can collect.
				// "It answered and refused" is what an operator needs; which 4xx it was is
				// what an attacker needs.
				lastError = "the endpoint answered but did not accept it";
			} catch {
				lastError = "no usable response from the endpoint";
			} finally {
				// On the throw path this was never cleared, leaving a live timer per attempt.
				clearTimeout(timer);
			}

			if (attempt < ATTEMPTS) {
				await Bun.sleep(250 * 2 ** attempt);
			}
		}

		recordFailure(db, doc.id, `${ATTEMPTS} attempts failed: ${lastError}`);
		inFlight.delete(doc.id);
	})();
}

/** A dead endpoint should be visible in the log the agent already reads. */
function recordFailure(db: Database, docId: string, note: string): void {
	try {
		const version = db
			.query<{ version: number }, [string]>("SELECT version FROM docs WHERE id = ?")
			.get(docId)?.version;
		if (version === undefined) return;
		db.query(
			"INSERT INTO events (doc_id, version, actor, kind, note, ts) VALUES (?, ?, 'vaiven', 'webhook_failed', ?, ?)",
		).run(docId, version, note.slice(0, 200), Date.now());
	} catch {
		// Recording the failure must not itself become a failure.
	}
}

export { isForbiddenAddress };
