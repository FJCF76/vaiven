// The two policies, byte for byte, against literal expected strings.
//
// test/gate.ts checks the SERVED header against `contentCsp(config)` — the same function
// that produced it. A typo in `frame-ancestors` moves both sides of that comparison
// together and the gate still passes, which is precisely the failure A6 names: the shell
// CSP fails open and nothing else in the system notices. These strings are written out by
// hand so that changing the policy requires changing this file too, deliberately.

import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { SANDBOX_ATTRIBUTE, SANDBOX_FLAGS, contentCsp, shellCsp, baseHeaders, contentHeaders, shellHeaders } from "../src/headers.ts";

const config = {
	appHost: "vaiven.example",
	sandboxHost: "uc.vaiven.example",
	appOrigin: "https://vaiven.example",
	sandboxOrigin: "https://uc.vaiven.example",
	scheme: "https",
} as unknown as Config;

describe("the sandbox flag set", () => {
	test("is exactly these three, in this order", () => {
		expect(SANDBOX_FLAGS).toEqual(["allow-scripts", "allow-modals", "allow-pointer-lock"]);
	});

	test("does NOT grant top navigation", () => {
		// Reversed at the gate: the flag lets untrusted model-authored content navigate the
		// top-level tab anywhere, on any click it captures, with allow-modals supplying the
		// pretext. A host serving arbitrary generated HTML at stable HTTPS URLs with
		// top-nav is a phishing host, and a Safe Browsing listing attaches to the
		// registrable domain.
		expect(SANDBOX_FLAGS.join(" ")).not.toContain("allow-top-navigation");
	});

	test("does NOT grant same-origin, which would end the isolation entirely", () => {
		expect(SANDBOX_FLAGS.join(" ")).not.toContain("allow-same-origin");
	});

	test("the iframe attribute carries the same flags as the header (A4's union trap)", () => {
		// Sandbox restrictions compose as a UNION of the CSP directive and the attribute,
		// so an attribute listing fewer flags silently re-deletes what the header restored.
		expect(SANDBOX_ATTRIBUTE).toBe(SANDBOX_FLAGS.join(" "));
		for (const flag of SANDBOX_FLAGS) expect(contentCsp(config)).toContain(flag);
	});
});

describe("the content policy, byte-exact", () => {
	const expected =
		"sandbox allow-scripts allow-modals allow-pointer-lock; " +
		"default-src 'none'; " +
		"script-src 'unsafe-inline' 'unsafe-eval' blob:; " +
		"style-src 'unsafe-inline'; " +
		"img-src data: blob:; " +
		"font-src data:; " +
		"media-src data: blob:; " +
		"worker-src blob:; " +
		"child-src blob: data:; " +
		"frame-src data: blob:; " +
		"connect-src 'none'; " +
		"form-action 'none'; " +
		"frame-ancestors https://vaiven.example";

	test("matches exactly", () => {
		expect(contentCsp(config)).toBe(expected);
	});

	test("connect-src is 'none' — the prohibition IS the security model", () => {
		expect(contentCsp(config)).toContain("connect-src 'none'");
	});

	test("frame-ancestors names the APP origin, not the sandbox origin", () => {
		// If this ever named the sandbox origin, or dropped to '*', any site could frame
		// content and harvest the state the shell posts into it.
		expect(contentCsp(config)).toContain("frame-ancestors https://vaiven.example");
		expect(contentCsp(config)).not.toContain("frame-ancestors *");
	});

	test("the restored capabilities are all present (A4's audit)", () => {
		const csp = contentCsp(config);
		for (const restored of ["media-src data: blob:", "worker-src blob:", "font-src data:", "frame-src data: blob:"]) {
			expect(csp).toContain(restored);
		}
	});
});

describe("the shell policy, byte-exact", () => {
	const expected =
		"default-src 'self'; " +
		"script-src 'self'; " +
		"style-src 'self'; " +
		"img-src 'self' data:; " +
		"connect-src 'self'; " +
		"frame-src https://uc.vaiven.example; " +
		"frame-ancestors 'none'; " +
		"base-uri 'none'; " +
		"form-action 'none'";

	test("matches exactly", () => {
		expect(shellCsp(config)).toBe(expected);
	});

	test("frame-src names the SANDBOX origin — this is what bounds the frame", () => {
		expect(shellCsp(config)).toContain("frame-src https://uc.vaiven.example");
	});

	test("the shell itself cannot be framed", () => {
		// The page holds a write key in location.hash. Framing it is clickjacking.
		expect(shellCsp(config)).toContain("frame-ancestors 'none'");
	});

	test("no 'unsafe-inline' anywhere — one innerHTML here is same-origin XSS with a key on the page", () => {
		expect(shellCsp(config)).not.toContain("unsafe-inline");
		expect(shellCsp(config)).not.toContain("unsafe-eval");
	});
});

describe("the headers around the policies", () => {
	test("every response carries no-referrer and nosniff", () => {
		expect(baseHeaders()["referrer-policy"]).toBe("no-referrer");
		expect(baseHeaders()["x-content-type-options"]).toBe("nosniff");
	});

	test("content responses carry the content policy and the permissions policy", () => {
		const headers = contentHeaders(config);
		expect(headers["content-security-policy"]).toBe(contentCsp(config));
		expect(headers["permissions-policy"]).toContain("camera=()");
		expect(headers["cache-control"]).toBe("private, no-store");
	});

	test("shell responses carry the shell policy and COOP", () => {
		const headers = shellHeaders(config);
		expect(headers["content-security-policy"]).toBe(shellCsp(config));
		expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
	});

	test("the two policies are never the same string", () => {
		expect(contentCsp(config)).not.toBe(shellCsp(config));
	});
});
