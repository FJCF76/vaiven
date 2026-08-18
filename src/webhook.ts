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

const CONNECT_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

/** One in flight per document, so a slow endpoint cannot pile up. */
const inFlight = new Set<string>();

/**
 * SSRF containment. The webhook URL is attacker-influenced in the sense that whoever can
 * create a document chooses it, and this process sits on a VPS with a metadata endpoint
 * and a loopback-bound database server.
 */
function isForbiddenAddress(address: string): boolean {
	if (isIP(address) === 6) {
		const lower = address.toLowerCase();
		return (
			lower === "::1" ||
			lower === "::" ||
			lower.startsWith("fc") || // unique local
			lower.startsWith("fd") ||
			lower.startsWith("fe80") || // link local
			lower.startsWith("::ffff:") // IPv4-mapped: check the mapped half separately
		);
	}

	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = parts;

	return (
		a === 0 || // this network
		a === 10 || // private
		a === 127 || // loopback
		(a === 169 && b === 254) || // link-local, including the 169.254.169.254 metadata endpoint
		(a === 172 && b >= 16 && b <= 31) || // private
		(a === 192 && b === 168) || // private
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
		a >= 224 // multicast and reserved
	);
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

	try {
		const resolved = await lookup(url.hostname, { all: true });
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
		const body = JSON.stringify(payload);
		// Authenticity: without a signature the webhook URL is an unauthenticated push
		// that anyone who learns it can forge.
		const signature = new Bun.CryptoHasher("sha256", doc.webhook_secret!).update(body).digest("hex");

		let lastError = "";
		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
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
				clearTimeout(timer);

				if (response.status >= 200 && response.status < 300) {
					inFlight.delete(doc.id);
					return;
				}
				lastError = `HTTP ${response.status}`;
			} catch (error) {
				lastError = (error as Error).name === "AbortError" ? "timed out" : (error as Error).message;
			}

			if (attempt < ATTEMPTS) {
				await Bun.sleep(250 * 2 ** attempt);
			}
		}

		try {
			const version = db
				.query<{ version: number }, [string]>("SELECT version FROM docs WHERE id = ?")
				.get(doc.id)?.version;
			if (version !== undefined) {
				db.query(
					"INSERT INTO events (doc_id, version, actor, kind, note, ts) VALUES (?, ?, 'vaiven', 'webhook_failed', ?, ?)",
				).run(doc.id, version, `${ATTEMPTS} attempts failed: ${lastError}`.slice(0, 200), Date.now());
			}
		} catch {
			// Recording the failure must not itself become a failure.
		}
		inFlight.delete(doc.id);
	})();
}

export { CONNECT_TIMEOUT_MS };
