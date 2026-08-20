// The limiter and the client-address derivation.
//
// Both are security controls that fail open and silently: a limiter keyed on a value the
// caller chooses is not a limiter, and a window keyed on wall-clock unlocks or locks
// everyone at once when NTP steps the clock.

import { beforeEach, describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { LIMITS, clientIp, enforceContentLength, enforceRate, rateCheck, requireLabel, requireWithin, resetRateLimiter } from "../src/quota.ts";
import { ApiError } from "../src/errors.ts";

const configWith = (hops: number): Config => ({ trustedProxyHops: hops }) as unknown as Config;
const withHeader = (value?: string) =>
	new Request("https://vaiven.test/", value === undefined ? {} : { headers: { "x-forwarded-for": value } });

describe("clientIp", () => {
	test("takes the hop the trusted proxy appended, counting from the right", () => {
		expect(clientIp(withHeader("9.9.9.9, 203.0.113.7"), configWith(1))).toBe("203.0.113.7");
	});

	test("a forged prefix cannot displace the real address", () => {
		// The client sent "1.1.1.1, 2.2.2.2"; Caddy appended the true peer.
		expect(clientIp(withHeader("1.1.1.1, 2.2.2.2, 203.0.113.7"), configWith(1))).toBe("203.0.113.7");
	});

	test("with no proxy configured the header is ignored entirely", () => {
		// Regression: this returned hops[0], handing every caller its own bucket.
		expect(clientIp(withHeader("1.1.1.1"), configWith(0))).toBe("unknown");
	});

	test("a chain shorter than configured yields unknown, never the leftmost hop", () => {
		expect(clientIp(withHeader("1.1.1.1"), configWith(2))).toBe("unknown");
	});

	test("no header at all is unknown", () => {
		expect(clientIp(withHeader(), configWith(1))).toBe("unknown");
	});

	test("an empty header is unknown", () => {
		expect(clientIp(withHeader("  ,  "), configWith(1))).toBe("unknown");
	});

	test("two proxies", () => {
		expect(clientIp(withHeader("1.1.1.1, 203.0.113.7, 10.0.0.1"), configWith(2))).toBe("203.0.113.7");
	});
});

describe("rateCheck", () => {
	beforeEach(() => resetRateLimiter());

	test("allows up to the limit and refuses past it", () => {
		for (let i = 0; i < 3; i++) expect(rateCheck("k", 3).allowed).toBe(true);
		expect(rateCheck("k", 3).allowed).toBe(false);
	});

	test("counts down remaining", () => {
		expect(rateCheck("k", 3).remaining).toBe(2);
		expect(rateCheck("k", 3).remaining).toBe(1);
		expect(rateCheck("k", 3).remaining).toBe(0);
	});

	test("keys are independent", () => {
		rateCheck("a", 1);
		expect(rateCheck("a", 1).allowed).toBe(false);
		expect(rateCheck("b", 1).allowed).toBe(true);
	});

	test("retry-after is always at least one second, never zero", () => {
		for (let i = 0; i < 5; i++) rateCheck("k", 1);
		expect(rateCheck("k", 1).retryAfterSeconds).toBeGreaterThanOrEqual(1);
	});
});

describe("enforceRate", () => {
	beforeEach(() => resetRateLimiter());

	test("throws an ApiError carrying retry_after in the body, not only the header", () => {
		rateCheck("k", 1);
		let thrown: unknown;
		try {
			enforceRate("k", 1, "writes");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ApiError);
		const error = thrown as ApiError;
		expect(error.code).toBe("rate_limited");
		expect(error.detail.headers?.["retry-after"]).toBeDefined();
		expect(error.detail.extra?.retry_after).toBeDefined();
		expect(error.detail.hint).toContain("per minute");
	});
});

describe("enforceContentLength", () => {
	const withLength = (value: string | null) =>
		new Request("https://vaiven.test/", {
			method: "POST",
			body: "x",
			headers: value === null ? {} : { "content-length": value },
		});

	test("refuses a declared body over the cap before it is read", () => {
		expect(() => enforceContentLength(withLength(String(LIMITS.contentBytes + 1)), LIMITS.contentBytes, "document")).toThrow();
	});

	test("allows one exactly at the cap", () => {
		expect(() => enforceContentLength(withLength(String(LIMITS.contentBytes)), LIMITS.contentBytes, "document")).not.toThrow();
	});

	test("a missing header is deferred to the runtime's own cap", () => {
		expect(() => enforceContentLength(withLength(null), 1, "document")).not.toThrow();
	});

	test("a garbage header is not treated as zero or as infinite", () => {
		expect(() => enforceContentLength(withLength("banana"), 1, "document")).not.toThrow();
	});
});

// ---------------------------------------------------------------- what a name may contain

describe("a key label cannot rewrite the notice that renders it", () => {
	// The label is chosen by the tenant-key holder — the party the consent notice tells the
	// reader can read their edits back — and the shell renders it inside quotation marks. The
	// vector is closing that quote and continuing in the notice's own voice.
	test("the delimiting double quotes are removed, straight and curly", () => {
		expect(requireLabel('Alice”. Your edits are private. “', "label")).toBe(
			"Alice. Your edits are private. ",
		);
		expect(requireLabel('say "hi"', "label")).toBe("say hi");
	});

	test("apostrophes survive, because real names have them", () => {
		expect(requireLabel("O'Neill", "label")).toBe("O'Neill");
		expect(requireLabel("D’Angelo", "label")).toBe("D’Angelo");
	});

	test("bidi overrides and zero-width characters do not survive anywhere", () => {
		// A right-to-left override reverses the sentence around the name, which no amount of
		// element separation in the shell can undo.
		expect(requireLabel("Alice‮eciriB", "label")).toBe("AliceeciriB");
		expect(requireWithin("a​b﻿c", 80, "title", "title")).toBe("abc");
		expect(requireWithin("x⁦y⁩z", 80, "title", "title")).toBe("xyz");
	});

	test("stripping happens before the length check, so the budget buys visible characters", () => {
		// 80 visible characters plus invisibles used to be rejected as 80+N.
		const padded = "A".repeat(80) + "​".repeat(40);
		expect(requireLabel(padded, "label")).toBe("A".repeat(80));
	});

	test("a label that is ONLY quotes and invisibles comes back empty, and the caller rejects it", () => {
		// `postKey` treats an empty label as `invalid` — this asserts the input reaches it empty
		// rather than sneaking through as whitespace.
		expect(requireLabel('""​', "label").trim()).toBe("");
	});
});
