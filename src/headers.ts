// The two Content-Security-Policy headers, plus the security headers that ride along.
//
// A4 established that this file is a product spec, not only a threat model: every
// directive here is a category of app that can or cannot be built. A6 established that
// the shell needs its own policy, because it is the page that holds the write key.
//
// Both policies are asserted byte-exactly in test/headers.test.ts against literal
// expected strings, NOT against these functions — comparing the served header to the
// module that produced it is a tautology that moves with any typo. A typo in
// `frame-ancestors` fails open and nothing else in the system would notice.

import type { Config } from "./config.ts";

/**
 * The sandbox flags, in one place.
 *
 * A4's implementation trap: sandbox restrictions compose as a UNION of the CSP `sandbox`
 * directive and the `<iframe sandbox>` attribute. If the attribute is narrower than the
 * header, it silently re-deletes every capability the header restored. Both are built
 * from this array so they cannot drift.
 *
 * Deliberately absent, each for a reason:
 *   allow-same-origin  — the whole point; grants an opaque origin instead
 *   allow-forms        — form-action 'none' already covers it; forms are handled in JS
 *   allow-popups       — window.open needs no gesture, so it is a silent exfil channel
 *   allow-top-navigation-by-user-activation — reversed at the gate: it lets untrusted
 *                        content navigate the top-level tab (the shell, on our real
 *                        domain) anywhere it likes, which is a phishing primitive
 *                        attached to the registrable domain. Links go through the shell
 *                        via postMessage({type:'open'}) instead.
 *   allow-downloads    — no capability lost; the viewer sandbox blocks them anyway
 */
export const SANDBOX_FLAGS = ["allow-scripts", "allow-modals", "allow-pointer-lock"] as const;

export const SANDBOX_ATTRIBUTE = SANDBOX_FLAGS.join(" ");

/** `Permissions-Policy` for content. Opaque origins already deny most of these; this is
 *  one header against a browser-behaviour assumption. */
export const PERMISSIONS_POLICY =
	"camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=(), display-capture=()";

/**
 * CSP for `/c/:id` — the sandbox host, serving model-authored HTML.
 *
 * The `sandbox` directive is in the RESPONSE HEADER rather than only the iframe
 * attribute so that direct navigation to this URL is confined too. Without it, anyone
 * who opens the content URL outside a frame gets a real origin.
 */
export function contentCsp(config: Config): string {
	return [
		`sandbox ${SANDBOX_FLAGS.join(" ")}`,
		"default-src 'none'",
		"script-src 'unsafe-inline' 'unsafe-eval' blob:",
		"style-src 'unsafe-inline'",
		"img-src data: blob:",
		"font-src data:",
		"media-src data: blob:",
		"worker-src blob:",
		"child-src blob: data:",
		"frame-src data: blob:",
		"connect-src 'none'",
		"form-action 'none'",
		`frame-ancestors ${config.appOrigin}`,
	].join("; ");
}

/**
 * CSP for `/d/:id` — the shell. This page holds the write key in `location.hash` and
 * renders strings written by other people (`title`, `sender_note`, key labels, event
 * fields). One `innerHTML` here is a same-origin XSS with a write key on the page, so
 * the shell renders exclusively with `textContent` and this policy is the backstop.
 */
export function shellCsp(config: Config): string {
	return [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self'",
		"img-src 'self' data:",
		"connect-src 'self'",
		`frame-src ${config.sandboxOrigin}`,
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ");
}

/** Applied to every response on every host. */
export function baseHeaders(): Record<string, string> {
	return {
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
	};
}

export function contentHeaders(config: Config): Record<string, string> {
	return {
		...baseHeaders(),
		"content-type": "text/html; charset=utf-8",
		"content-security-policy": contentCsp(config),
		"permissions-policy": PERMISSIONS_POLICY,
		"cross-origin-resource-policy": "same-site",
		"cache-control": "private, no-store",
	};
}

export function shellHeaders(config: Config): Record<string, string> {
	return {
		...baseHeaders(),
		"content-type": "text/html; charset=utf-8",
		"content-security-policy": shellCsp(config),
		"cross-origin-opener-policy": "same-origin",
		"cache-control": "private, no-store",
	};
}
