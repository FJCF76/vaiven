// Identifiers.
//
// A5: at least 128 bits from a CSPRNG. `/c/:id` needs no authentication by design, so a
// short or guessable document id makes every tenant's content enumerable and scrapable.
// Never Math.random.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford-ish: no i, l, o, u

/** 26 chars of base32 = 130 bits. Lowercase and unambiguous, so it survives being read
 *  aloud, pasted from a chat, or retyped from a screenshot. */
function randomBody(): string {
	const bytes = new Uint8Array(17); // 136 bits, truncated to 130 by the 26-char output
	crypto.getRandomValues(bytes);

	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5 && out.length < 26) {
			bits -= 5;
			out += ALPHABET[(value >>> bits) & 31];
		}
	}
	return out;
}

export const newTenantId = () => `t_${randomBody()}`;
export const newDocId = () => `d_${randomBody()}`;
export const newKeyId = () => `k_${randomBody()}`;

const ID_PATTERN = /^[tdk]_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;

/**
 * Shape check before any lookup. Rejecting malformed ids early keeps them out of query
 * parameters and log lines, and makes "not found" mean one thing.
 */
export function isValidId(id: string, prefix?: "t" | "d" | "k"): boolean {
	if (!ID_PATTERN.test(id)) return false;
	return prefix ? id.startsWith(`${prefix}_`) : true;
}
