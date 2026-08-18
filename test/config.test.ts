// The startup refusals, in a real subprocess.
//
// These are the assertions that decide whether the process is allowed to exist at all, and
// the most important of them — `appHost === sandboxHost` — is the invariant the entire
// security design rests on: if the two origins collapse, model-authored JavaScript runs on
// the same origin as the page holding the write key. Nothing executed that branch until
// now, so a refactor turning fatal() into a warning would have shipped in silence.
//
// A subprocess, because these call process.exit(2). Importing them would take the test
// runner down with them.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "vaiven-config-"));
const probe = join(dir, "probe.ts");
writeFileSync(
	probe,
	`import { loadConfig } from ${JSON.stringify(join(import.meta.dir, "..", "src", "config.ts"))};\n` +
		`const c = loadConfig();\nconsole.log(JSON.stringify({ appOrigin: c.appOrigin, sandboxOrigin: c.sandboxOrigin }));\n`,
);

function boot(env: Record<string, string>) {
	const result = spawnSync(process.execPath, ["run", probe], {
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", VAIVEN_DB: join(dir, "probe.sqlite"), ...env },
		encoding: "utf8",
		timeout: 20_000,
	});
	return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const LOCAL = { VAIVEN_APP_HOST: "vaiven.localhost", VAIVEN_SANDBOX_HOST: "uc.vaiven.localhost", VAIVEN_SCHEME: "http" };

describe("the two hosts", () => {
	test("identical hosts REFUSE to start", () => {
		const r = boot({ ...LOCAL, VAIVEN_SANDBOX_HOST: "vaiven.localhost" });
		expect(r.code).toBe(2);
		expect(r.out).toContain("both");
	});

	test("a missing app host refuses, rather than guessing one", () => {
		const r = boot({ VAIVEN_SANDBOX_HOST: "uc.vaiven.localhost", VAIVEN_SCHEME: "http" });
		expect(r.code).toBe(2);
		expect(r.out).toContain("VAIVEN_APP_HOST");
	});

	test("a missing sandbox host refuses", () => {
		const r = boot({ VAIVEN_APP_HOST: "vaiven.localhost", VAIVEN_SCHEME: "http" });
		expect(r.code).toBe(2);
		expect(r.out).toContain("VAIVEN_SANDBOX_HOST");
	});

	test("two distinct hosts start", () => {
		expect(boot(LOCAL).code).toBe(0);
	});
});

describe("the hostname itself", () => {
	// appOrigin is spliced into `frame-ancestors`, into `frame-src`, into every URL handed
	// to an agent, and into the manual. A malformed value fails OPEN in the CSP rather than
	// loudly, and `$` sequences are interpreted as replacement patterns by String.replace,
	// so an origin containing `$'` silently truncated the served manual.
	for (const bad of ["x$&y.localhost", "a$'b.localhost", "has space.localhost", "evil/../.localhost", "a;b.localhost"]) {
		test(`refuses ${JSON.stringify(bad)}`, () => {
			const r = boot({ ...LOCAL, VAIVEN_APP_HOST: bad });
			expect(r.code).toBe(2);
			expect(r.out).toContain("not a hostname");
		});
	}

	test("accepts an ordinary name", () => {
		expect(boot(LOCAL).code).toBe(0);
	});

	test("accepts a bracketed IPv6 literal", () => {
		// Over https: an IPv6 literal does not end in `.localhost`, so under `http` the
		// plaintext refusal fires first — correctly, and for a different reason.
		expect(boot({ VAIVEN_APP_HOST: "[::1]", VAIVEN_SANDBOX_HOST: "[::2]", VAIVEN_SCHEME: "https" }).code).toBe(0);
	});
});

describe("plaintext", () => {
	test("http with BOTH hosts on .localhost is allowed", () => {
		expect(boot(LOCAL).code).toBe(0);
	});

	test("http with only ONE host on .localhost refuses", () => {
		// Regression: the check was `!a.endsWith(".localhost") && !b.endsWith(".localhost")`,
		// so this arrangement — the shell reachable in the clear with a write key in its
		// fragment — started happily.
		const r = boot({ ...LOCAL, VAIVEN_SANDBOX_HOST: "uc.example.com" });
		expect(r.code).toBe(2);
		expect(r.out).toContain("localhost");
	});

	test("http with neither host on .localhost refuses", () => {
		const r = boot({ VAIVEN_APP_HOST: "a.example.com", VAIVEN_SANDBOX_HOST: "b.example.com", VAIVEN_SCHEME: "http" });
		expect(r.code).toBe(2);
	});

	test("https with ordinary hosts starts", () => {
		expect(boot({ VAIVEN_APP_HOST: "a.example.com", VAIVEN_SANDBOX_HOST: "b.example.com", VAIVEN_SCHEME: "https" }).code).toBe(0);
	});
});

describe("binding", () => {
	test("a wildcard bind refuses without the explicit override", () => {
		const r = boot({ ...LOCAL, VAIVEN_BIND: "0.0.0.0" });
		expect(r.code).toBe(2);
		expect(r.out).toContain("VAIVEN_BIND");
	});

	test("…and starts with it, because that is a decision someone made on purpose", () => {
		expect(boot({ ...LOCAL, VAIVEN_BIND: "0.0.0.0", VAIVEN_ALLOW_PUBLIC_BIND: "1" }).code).toBe(0);
	});

	test("loopback needs no override", () => {
		expect(boot({ ...LOCAL, VAIVEN_BIND: "127.0.0.1" }).code).toBe(0);
	});
});

describe("the public port lands in the origin", () => {
	test("a non-default port appears, so CSP host-sources match", () => {
		// A host-source with no port means the scheme default, so an origin missing its
		// port silently matches nothing anywhere else.
		const r = boot({ ...LOCAL, VAIVEN_PORT: "8080", VAIVEN_PUBLIC_PORT: "8080" });
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out).appOrigin).toBe("http://vaiven.localhost:8080");
	});

	test("the scheme default is omitted", () => {
		const r = boot({ VAIVEN_APP_HOST: "a.example.com", VAIVEN_SANDBOX_HOST: "b.example.com", VAIVEN_SCHEME: "https", VAIVEN_PUBLIC_PORT: "443" });
		expect(JSON.parse(r.out).appOrigin).toBe("https://a.example.com");
	});
});
