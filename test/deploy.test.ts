// Vaivén 0.3.2.0 was deployed to a host that had not rebooted since Phase 0, so nobody
// noticed that `deploy/sync.sh` enabled the backup timer and never enabled the service it
// backs up. `Restart=always` hides this completely: the service recovers from every crash,
// so it looks healthy for as long as the box stays up. The box rebooted on 2026-08-20 and
// came back serving 502 with the unit sitting at `disabled`.
//
// These tests EXECUTE the script's verification path (`--verify-only`) against a fake
// systemctl and curl on PATH. An earlier draft only grepped the source for the right
// strings, which proves text exists, not that control flow reaches an exit.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SYNC = join(ROOT, "deploy", "sync.sh");
const unit = readFileSync(join(ROOT, "deploy", "vaiven.service"), "utf8");

const DEFAULT_CONFIG = {
	VAIVEN_APP_HOST: "vaiven.example.com",
	VAIVEN_BIND: "127.0.0.1",
	VAIVEN_PORT: "8080",
};

/**
 * Run `sync.sh --verify-only` against a stubbed systemctl and curl.
 *
 * `codes` is the sequence of HTTP status codes the fake curl returns, one per call, so a
 * test can model "answered once, then died" as well as flat success or failure. The fake
 * also records its own argv: that is the only way to assert the script really requested
 * the right URL with the right Host header, since a stub that ignores its arguments
 * passes just as happily when the script drops them.
 */
function verifyOnly(opts: {
	enabledState: string;
	codes?: string[];
	config?: Record<string, string>;
	settle?: string;
	attempts?: string;
}) {
	const { enabledState, codes = ["200", "200"], config = DEFAULT_CONFIG, settle = "0", attempts = "1" } = opts;
	const bin = mkdtempSync(join(tmpdir(), "vaiven-deploy-test-"));
	const curlLog = join(bin, "curl.log");
	const sudoMarker = join(bin, "sudo-was-called");

	// Exits 0 even for `disabled`/`static`, which IS real systemd behaviour. Seeing past
	// that is the whole job of the guard under test.
	writeFileSync(
		join(bin, "systemctl"),
		`#!/usr/bin/env bash\nif [ "$1" = "is-enabled" ]; then echo "${enabledState}"; fi\nexit 0\n`,
	);
	writeFileSync(
		join(bin, "curl"),
		[
			"#!/usr/bin/env bash",
			`printf '%s\\n' "$*" >> "${curlLog}"`,
			`n=$(wc -l < "${curlLog}" | tr -d ' ')`,
			`codes=(${codes.join(" ")})`,
			"idx=$((n - 1))",
			"last=$(( ${#codes[@]} - 1 ))",
			'[ "$idx" -gt "$last" ] && idx=$last',
			'printf %s "${codes[$idx]}"',
			"",
		].join("\n"),
	);
	// Verification must not need root. Reaching read_env leaves proof here.
	writeFileSync(join(bin, "sudo"), `#!/usr/bin/env bash\ntouch "${sudoMarker}"\nexit 99\n`);
	for (const f of ["systemctl", "curl", "sudo"]) chmodSync(join(bin, f), 0o755);

	const proc = Bun.spawnSync(["bash", SYNC, "--verify-only"], {
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			VAIVEN_HEALTH_ATTEMPTS: attempts,
			VAIVEN_HEALTH_SETTLE: settle,
			...config,
		},
	});
	const curlArgs = existsSync(curlLog)
		? readFileSync(curlLog, "utf8").split("\n").filter(Boolean)
		: [];
	return {
		code: proc.exitCode,
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
		curlArgs,
		sudoCalled: existsSync(sudoMarker),
	};
}

describe("sync.sh --verify-only: boot survival", () => {
	test("passes when the unit is enabled and serving", () => {
		const r = verifyOnly({ enabledState: "enabled" });
		expect(r.code).toBe(0);
		expect(r.out).toContain("enabled at boot");
	});

	test("fails when the unit is disabled", () => {
		const r = verifyOnly({ enabledState: "disabled" });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("reboot");
	});

	// These three states all make `systemctl is-enabled` exit 0, and none of them starts
	// the unit at boot the way `enabled` does, so an exit-code-only check passes on every
	// one. `static` is not hypothetical: vaiven-backup.service is static, and
	// `is-enabled --quiet` exits 0 for it on the production host.
	for (const state of ["static", "enabled-runtime", "indirect"]) {
		test(`fails on '${state}', which exits 0 but is not 'enabled'`, () => {
			const r = verifyOnly({ enabledState: state });
			expect(r.code).not.toBe(0);
			expect(r.err).toContain(state);
		});
	}

	test("fails when systemctl reports nothing at all", () => {
		const r = verifyOnly({ enabledState: "" });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("unknown");
	});
});

describe("sync.sh --verify-only: actually serving", () => {
	test("fails when the port is up but the app does not answer", () => {
		const r = verifyOnly({ enabledState: "enabled", codes: ["000"] });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("not serving");
		expect(r.out).not.toContain("enabled at boot");
	});

	// `curl -f` exits 0 on a 3xx, so an earlier draft counted a redirect away from the app
	// as a healthy response. Only a 200 is health.
	for (const code of ["302", "301", "204", "500"]) {
		test(`treats ${code} as not serving`, () => {
			const r = verifyOnly({ enabledState: "enabled", codes: [code] });
			expect(r.code).not.toBe(0);
		});
	}

	// Type=simple plus Restart=always means a dying service can be sampled while it
	// happens to be up. One good response is not health.
	test("rejects a service that answers once and then dies", () => {
		const r = verifyOnly({ enabledState: "enabled", codes: ["200", "000"] });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("restart loop");
	});

	test("asks twice before believing the service is healthy", () => {
		expect(verifyOnly({ enabledState: "enabled" }).curlArgs.length).toBe(2);
	});

	// A stub that ignores its arguments would pass even if the script dropped the URL or
	// the Host header, so assert on what was actually requested.
	test("requests /guide.md on the configured bind and port, with the app Host", () => {
		const [first] = verifyOnly({ enabledState: "enabled" }).curlArgs;
		expect(first).toContain("http://127.0.0.1:8080/guide.md");
		expect(first).toContain("Host: vaiven.example.com");
		expect(first).toContain("--max-time");
	});

	test("brackets an IPv6 bind address", () => {
		// Unbracketed, ::1 builds http://::1:8080/guide.md, which curl cannot parse.
		const r = verifyOnly({
			enabledState: "enabled",
			config: { ...DEFAULT_CONFIG, VAIVEN_BIND: "::1" },
		});
		expect(r.curlArgs[0]).toContain("http://[::1]:8080/guide.md");
	});

	// Without a named key the loop just fails and prints "not serving http://:/guide.md
	// as ", which tells a self-hoster with an incomplete env file nothing at all.
	for (const missing of ["VAIVEN_APP_HOST", "VAIVEN_BIND", "VAIVEN_PORT"]) {
		test(`names ${missing} when it is missing from the config`, () => {
			const r = verifyOnly({
				enabledState: "enabled",
				config: { ...DEFAULT_CONFIG, [missing]: "" },
			});
			expect(r.code).not.toBe(0);
			expect(r.err).toContain(missing);
			expect(r.err).not.toContain("http://:/");
		});
	}
});

describe("sync.sh --verify-only: does not need root", () => {
	// Config is supplied through the environment, so read_env and its sudo must never be
	// reached. An empty value counted as unset under `${VAR:-...}` and silently fell
	// through to sudo, making the missing-key tests above pass for the wrong reason.
	test("never invokes sudo, even when a config value is empty", () => {
		expect(verifyOnly({ enabledState: "enabled" }).sudoCalled).toBe(false);
		expect(
			verifyOnly({
				enabledState: "enabled",
				config: { ...DEFAULT_CONFIG, VAIVEN_APP_HOST: "" },
			}).sudoCalled,
		).toBe(false);
	});
});

describe("sync.sh --verify-only: retry budget", () => {
	// errexit is disabled inside a function called on the left of `||`, so a junk value
	// cannot abort the script. It has to be clamped, or the health check is skipped and
	// the deploy reports a failure it never actually measured.
	for (const attempts of ["0", "abc", ""]) {
		test(`still performs a request when VAIVEN_HEALTH_ATTEMPTS is ${JSON.stringify(attempts)}`, () => {
			const r = verifyOnly({ enabledState: "enabled", attempts });
			expect(r.curlArgs.length).toBeGreaterThan(0);
			expect(r.code).toBe(0);
		});
	}
});

describe("sync.sh: argument handling", () => {
	test("rejects an unknown flag instead of deploying", () => {
		const proc = Bun.spawnSync(["bash", SYNC, "--wat"], { env: process.env });
		expect(proc.exitCode).toBe(2);
		expect(proc.stderr.toString()).toContain("usage");
	});
});

// Not executable from a test, so assert on the source.
describe("deploy/sync.sh source", () => {
	const code = readFileSync(SYNC, "utf8")
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");

	test("enables the service, not only the backup timer", () => {
		expect(code).toMatch(/systemctl\s+enable\s+(--now\s+)?vaiven(\s|$)/m);
	});

	test("still restarts, so a deploy picks up the new code", () => {
		expect(code).toMatch(/systemctl\s+restart\s+vaiven/);
	});

	test("keeps the backup timer enabled", () => {
		expect(code).toMatch(/systemctl\s+enable\s+--now\s+vaiven-backup\.timer/);
	});

	test("proves the service serves before writing it into the boot path", () => {
		// Ordering matters: enabling a broken deploy makes it come back broken at boot.
		expect(code.indexOf("verify_running ||")).toBeLessThan(code.indexOf("systemctl enable vaiven"));
	});

	test("guards restart so the journal dump is reachable", () => {
		// Bare `systemctl restart` under `set -e` exits before any diagnostics can print.
		expect(code).toMatch(/systemctl\s+restart\s+vaiven\s*\|\|/);
	});
});

describe("deploy/vaiven.service", () => {
	test("has an install target, so `enable` has something to link", () => {
		expect(unit).toMatch(/^\[Install\]/m);
		expect(unit).toMatch(/^WantedBy=multi-user\.target$/m);
	});

	test("still restarts on crash", () => {
		expect(unit).toMatch(/^Restart=always$/m);
	});
});
