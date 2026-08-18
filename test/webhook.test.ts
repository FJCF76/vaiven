// The SSRF guard, which is the only thing standing between a document's webhook field and
// this box's own network.
//
// These are table tests on purpose: the first version of the guard matched textual prefixes
// and every case below marked "the prefix version allowed this" was reachable in production
// with a hostname the attacker controls.

import { describe, expect, test } from "bun:test";
import { isForbiddenAddress, validateWebhookUrl } from "../src/webhook.ts";

describe("isForbiddenAddress", () => {
	const forbidden = [
		["127.0.0.1", "loopback"],
		["127.9.9.9", "the rest of 127/8"],
		["0.0.0.0", "this network"],
		["10.1.2.3", "private"],
		["172.16.0.1", "private, low edge"],
		["172.31.255.255", "private, high edge"],
		["192.168.1.1", "private"],
		["169.254.169.254", "the metadata endpoint"],
		["100.64.0.1", "carrier-grade NAT"],
		["224.0.0.1", "multicast"],
		["255.255.255.255", "broadcast"],
		["192.0.2.5", "documentation"],
		["198.18.0.1", "benchmarking"],
		["::1", "IPv6 loopback"],
		["0:0:0:0:0:0:0:1", "IPv6 loopback, expanded — the prefix version allowed this"],
		["::", "unspecified"],
		["fd00::1", "unique local"],
		["fc00::1", "unique local, low edge"],
		["fe80::1", "link local"],
		["fec0::1", "site local — the prefix version allowed this"],
		["ff02::1", "multicast"],
		["::ffff:127.0.0.1", "v4-mapped loopback"],
		["::ffff:169.254.169.254", "v4-mapped metadata"],
		["64:ff9b::127.0.0.1", "NAT64 loopback — the prefix version allowed this"],
		["64:ff9b::a9fe:a9fe", "NAT64 metadata in hex — the prefix version allowed this"],
		["2001:db8::1", "documentation"],
		["not an address", "unparseable is refused, not allowed"],
		["1.2.3", "short quad"],
		["1.2.3.999", "out of range"],
	] as const;

	for (const [address, why] of forbidden) {
		test(`refuses ${address} (${why})`, () => {
			expect(isForbiddenAddress(address)).toBe(true);
		});
	}

	const allowed = [
		["8.8.8.8", "public"],
		["1.1.1.1", "public"],
		["93.184.216.34", "an ordinary public host"],
		["172.32.0.1", "just above the private block"],
		["172.15.255.255", "just below it"],
		["100.128.0.1", "just above CGNAT"],
		["223.255.255.255", "just below multicast"],
		["2606:4700::1111", "public IPv6"],
		["::ffff:8.8.8.8", "v4-mapped PUBLIC — the prefix version wrongly refused this"],
		["64:ff9b::8.8.8.8", "NAT64 onto a public address"],
	] as const;

	for (const [address, why] of allowed) {
		test(`allows ${address} (${why})`, () => {
			expect(isForbiddenAddress(address)).toBe(false);
		});
	}
});

describe("validateWebhookUrl", () => {
	test("refuses plaintext http", async () => {
		const verdict = await validateWebhookUrl("http://example.com/hook");
		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.reason).toContain("https");
	});

	test("refuses a non-URL", async () => {
		expect((await validateWebhookUrl("not a url")).ok).toBe(false);
	});

	test("refuses a literal loopback host without touching DNS", async () => {
		expect((await validateWebhookUrl("https://127.0.0.1/hook")).ok).toBe(false);
	});

	test("refuses the metadata address as a literal", async () => {
		expect((await validateWebhookUrl("https://169.254.169.254/latest/meta-data/")).ok).toBe(false);
	});

	test("refuses a bracketed IPv6 loopback", async () => {
		expect((await validateWebhookUrl("https://[::1]/hook")).ok).toBe(false);
	});

	test("refuses a hostname that does not resolve", async () => {
		const verdict = await validateWebhookUrl("https://nx.invalid/hook");
		expect(verdict.ok).toBe(false);
	});
});
