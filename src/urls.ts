// A12: never make the agent construct a URL.
//
// Three unguessable single letters across two hostnames with two different key
// placements is not something to document and hope for. Every response that mentions a
// document carries the URLs for it, `/r/` included — a cold agent handed only a read URL
// otherwise gets field names and no way to reach the app they belong to.

import type { KeyMaterial } from "./auth.ts";
import type { Config } from "./config.ts";

export interface DocUrls {
	/** The human's link. The key rides in the fragment, so it never reaches the server:
	 *  no access log, no Referer, no proxy cache. */
	view_url?: string;
	/** The universal read. A bearer secret in a path, deliberately, because the weakest
	 *  possible reader cannot set a header (I2). */
	read_url?: string;
	/** The content itself, on the sandbox host. */
	content_url: string;
	api_url: string;
	guide: string;
}

export function docUrls(
	config: Config,
	docId: string,
	// `shell` is ANY key that opens `/d/:id` — a read-role key opens the same page in
	// read-only mode. It was called `write` until a review pointed out that the name reads as
	// "a key with role write", and that a fix written against that reading would have omitted
	// `read_url` for read-role keys. The name was the trap, so the name changed.
	keys: { shell?: KeyMaterial; read?: KeyMaterial } = {},
): DocUrls {
	return {
		// Built with the same class the consumer parses with: `shell.js` reads this fragment as
		// `new URLSearchParams(location.hash.slice(1)).get("k")`, so constructing it the same
		// way means producer and consumer cannot drift apart.
		//
		// Correcting a claim an earlier draft of this comment made: `encodeURIComponent` DOES
		// escape `+`, to `%2B`, which `URLSearchParams` decodes back correctly — the previous
		// construction was not broken. `URLSearchParams` is preferred for symmetry, not as a
		// bug fix. A raw `+` in the fragment would decode as a space, which is why neither side
		// should ever concatenate one in by hand.
		...(keys.shell
			? { view_url: `${config.appOrigin}/d/${docId}#${new URLSearchParams({ k: keys.shell.reveal() })}` }
			: {}),
		// The key is a PATH segment here and `.json` is parsed off the end, so it is encoded
		// even though base64url needs none. `read.ts` decodes it back before hashing — encode
		// here without decoding there and a key needing escapes would simply never resolve.
		...(keys.read
			? { read_url: `${config.appOrigin}/r/${encodeURIComponent(keys.read.reveal())}.json` }
			: {}),
		content_url: `${config.sandboxOrigin}/c/${docId}`,
		api_url: `${config.appOrigin}/api/docs/${docId}`,
		guide: `${config.appOrigin}/guide.md`,
	};
}

/**
 * The one place a minted key becomes a response body.
 *
 * `reveal()` is called only where a secret is deliberately crossing out of the process: here
 * in `urls.ts` when a URL is built, in `api.ts` where document creation serializes the keys it
 * just minted, and in `cli.ts` where the operator is shown a key on their own terminal. Grep
 * for it — the call sites ARE the audit list. The compiler stops another appearing by
 * accident, because `KeyMaterial` is not a string.
 *
 * (An earlier version of this comment counted the sites per file and got the counts wrong,
 * which is a good argument for describing a boundary rather than tallying one.)
 *
 * Role matters. A write key opens the shell and is deliberately NOT a `/r/` key — `read.ts`
 * returns the opaque miss for it. A read key is both: it opens the shell read-only AND
 * answers at `/r/<key>.json`. Getting this wrong in either direction hands the caller a URL
 * that 404s, or withholds one they need and sends them back to building it themselves.
 */
export function mintedKeyBody(
	config: Config,
	docId: string,
	minted: { id: string; label: string; role: "read" | "write"; plaintext: KeyMaterial },
): Record<string, unknown> {
	const keys =
		minted.role === "read"
			? { shell: minted.plaintext, read: minted.plaintext }
			: minted.role === "write"
				? { shell: minted.plaintext }
				: assertNever(minted.role);
	return {
		id: minted.id,
		label: minted.label,
		role: minted.role,
		key: minted.plaintext.reveal(),
		...docUrls(config, docId, keys),
	};
}

/** A third role must not silently inherit the write shape. */
function assertNever(role: never): never {
	throw new Error(`unhandled key role: ${String(role)}`);
}
