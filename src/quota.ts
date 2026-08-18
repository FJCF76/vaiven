// Byte accounting and rate limiting.
//
// A13 rewrote both. The limiter as specified was keyed on the socket peer, which behind a
// proxy is always 127.0.0.1 — so every client shared one bucket and the first heavy user
// would 429 everybody, presenting as "the site is down" rather than as a limit.

import type { Config } from "./config.ts";
import { fail } from "./errors.ts";

// --------------------------------------------------------------------------- the caps

export const LIMITS = {
	contentBytes: 4 * 1024 * 1024, // A4
	stateBytes: 1 * 1024 * 1024, // A4
	eventsPerWrite: 200, // A1's collapse rule backstop
	eventBytes: 8 * 1024,
	titleChars: 200,
	senderNoteChars: 500,
	labelChars: 80,
} as const;

export const RATES = {
	/** Writes per minute per tenant. */
	write: 120,
	/** `/r/` reads per minute per key. */
	publicRead: 600,
	/** Authenticated API reads per minute per key — the 3 s poll lives here and had no
	 *  budget at all, so a stuck tab looped unbounded. */
	apiRead: 400,
	/** Everything unauthenticated: /c/, /d/, /guide.md, and failed auth attempts. */
	anonymous: 300,
} as const;

// ---------------------------------------------------------------------- the client IP

/**
 * A13: take the client address from the proxy header, counting hops from the RIGHT.
 *
 * Caddy appends the real peer to any `X-Forwarded-For` the client sent, so a forged
 * header pushes the attacker's value leftward and the genuine address is still at
 * position `length - hops`. Counting from the left would let anyone pick their own
 * bucket, and an unbounded set of buckets is a memory exhaustion primitive.
 */
export function clientIp(request: Request, config: Config): string {
	const header = request.headers.get("x-forwarded-for");
	if (!header) return "unknown";

	const hops = header
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	if (hops.length === 0) return "unknown";

	const index = hops.length - config.trustedProxyHops;
	return (index >= 0 && index < hops.length ? hops[index] : hops[0]) ?? "unknown";
}

// -------------------------------------------------------------------- the rate limiter

interface Bucket {
	count: number;
	/** Monotonic window start. */
	start: number;
	touched: number;
}

/**
 * A13: a MONOTONIC clock.
 *
 * `Date.now()` moves when NTP corrects a freshly-provisioned VPS, and a backwards step
 * either resets every window at once or, worse, puts every window's start in the future
 * and locks everyone out until wall-clock catches up.
 */
const now = (): number => Math.floor(performance.now());

const WINDOW_MS = 60_000;
/** Bounded so the map cannot grow without limit (A13). */
const MAX_BUCKETS = 20_000;

const buckets = new Map<string, Bucket>();

function sweep(): void {
	if (buckets.size <= MAX_BUCKETS) return;
	// Evict least-recently-touched first. Map preserves insertion order, and every touch
	// re-inserts, so the head is the coldest quarter.
	const excess = buckets.size - Math.floor(MAX_BUCKETS * 0.75);
	let removed = 0;
	for (const key of buckets.keys()) {
		buckets.delete(key);
		if (++removed >= excess) break;
	}
}

export interface RateVerdict {
	allowed: boolean;
	remaining: number;
	retryAfterSeconds: number;
}

export function rateCheck(key: string, limit: number): RateVerdict {
	const time = now();
	let bucket = buckets.get(key);

	if (!bucket || time - bucket.start >= WINDOW_MS) {
		bucket = { count: 0, start: time, touched: time };
	} else {
		buckets.delete(key); // re-insert to refresh LRU order
	}

	bucket.count++;
	bucket.touched = time;
	buckets.set(key, bucket);
	sweep();

	const allowed = bucket.count <= limit;
	const elapsed = time - bucket.start;
	return {
		allowed,
		remaining: Math.max(0, limit - bucket.count),
		retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000)),
	};
}

/** Throws the A9 error, with `Retry-After` in the header AND the body — an agent's HTTP
 *  tool may not surface headers at all. */
export function enforceRate(key: string, limit: number, what: string): void {
	const verdict = rateCheck(key, limit);
	if (verdict.allowed) return;

	fail("rate_limited", `Too many ${what}.`, {
		hint: `Wait ${verdict.retryAfterSeconds}s and retry. The limit is ${limit} per minute. If you are polling, read once per turn rather than on a timer.`,
		limit,
		extra: { retry_after: verdict.retryAfterSeconds },
		headers: { "retry-after": String(verdict.retryAfterSeconds) },
	});
}

/** Test seam: the limiter is process-global by design (one process, v1). */
export function resetRateLimiter(): void {
	buckets.clear();
}

// -------------------------------------------------------------------------- body size

/**
 * A13: check `Content-Length` BEFORE reading the body. Without this a 100 MB upload is
 * buffered into memory so that a 413 can be computed about it.
 */
export function enforceContentLength(request: Request, limit: number, what: string): void {
	const header = request.headers.get("content-length");
	if (header === null) return; // chunked; the runtime's maxRequestBodySize still applies
	const length = Number(header);
	if (!Number.isFinite(length)) return;

	if (length > limit) {
		fail("too_large", `That ${what} is larger than the limit.`, {
			hint: `Send at most ${limit} bytes. Nothing was stored, so the document is unchanged — resend a smaller ${what}.`,
			limit,
			actual: length,
		});
	}
}
