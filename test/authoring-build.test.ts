// `guide/authoring.md` publishes a build script. Whatever that script says becomes standing
// instruction for every agent that assembles a document, so it is executable content, not
// illustration — a broken snippet there ships to every user of the guide.
//
// The first draft was broken in ways that all survived careful reading: it wrote straight to
// `dist.html`, so a failure destroyed the last good build and left a truncated-but-publishable
// file; it used `sed Q`, a GNU extension BSD sed rejects; a `page.html` that had lost its
// marker built "successfully"; and the script landed in `<head>`, where every getElementById
// returns null.
//
// These tests EXTRACT the script from the shipped page and RUN it. Asserting against a copy
// pasted into the test would prove only that the copy works — the point is that the bytes an
// agent actually receives do.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGE = join(import.meta.dir, "..", "guide", "authoring.md");
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function workdir(): string {
	const d = mkdtempSync(join(tmpdir(), "vaiven-authoring-"));
	dirs.push(d);
	return d;
}

/** The first ```bash fence in the page: the build script as published. */
function publishedScript(): string {
	const text = readFileSync(PAGE, "utf8");
	const match = text.match(/```bash\n([\s\S]*?)```/);
	if (!match?.[1]) throw new Error("guide/authoring.md no longer contains a bash block");
	return match[1];
}

type Opts = {
	style?: boolean;
	script?: boolean;
	components?: boolean;
	stubAwk?: boolean;
	head?: string;
	foot?: string;
};

/** A shape-B source tree in `dir`, assembled by the published script. */
function build(dir: string, opts: Opts = {}) {
	const style = opts.head ?? (opts.style === false ? "" : "<!--STYLE-->");
	const script = opts.foot ?? (opts.script === false ? "" : "<!--SCRIPT-->");
	writeFileSync(
		join(dir, "page.html"),
		`<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n${style}\n</head>\n<body>\n<ul id="l"></ul>\n${script}\n</body>\n</html>\n`,
	);
	writeFileSync(join(dir, "theme.css"), ":root{--bg:#fff}\n");
	// Deliberately no trailing newline: `cat` would weld this onto the next file.
	writeFileSync(join(dir, "app.js"), "var app = 1;");
	if (opts.components === false) {
		rmSync(join(dir, "components"), { recursive: true, force: true });
	} else {
		mkdirSync(join(dir, "components"), { recursive: true });
		writeFileSync(join(dir, "components", "list.js"), "var list = 1;");
	}
	writeFileSync(join(dir, "build.sh"), publishedScript());

	const env = { ...process.env };
	if (opts.stubAwk) {
		// A splice that dies part-way through, to prove the rename is load-bearing. `awk 1`
		// (the concatenation call) is delegated to the real awk; the splice call writes
		// partial output and fails, exactly like a full disk or a killed process.
		const bin = join(dir, "stub");
		mkdirSync(bin, { recursive: true });
		const real = execFileSync("sh", ["-c", "command -v awk"], { encoding: "utf8" }).trim();
		writeFileSync(
			join(bin, "awk"),
			`#!/bin/sh\nif [ "$1" = "1" ]; then exec ${real} "$@"; fi\nprintf '<!doctype html>\\n<html><head><partial'\nexit 1\n`,
		);
		chmodSync(join(bin, "awk"), 0o755);
		env.PATH = `${bin}:${env.PATH}`;
	}

	try {
		execFileSync("bash", ["build.sh"], { cwd: dir, stdio: "pipe", timeout: 30_000, env });
		return { ok: true as const };
	} catch {
		return { ok: false as const };
	}
}

describe("the build script published in guide/authoring.md", () => {
	test("assembles sources into a document the sandbox renders in standards mode", () => {
		const dir = workdir();
		expect(build(dir).ok).toBe(true);
		const dist = readFileSync(join(dir, "dist.html"), "utf8");

		// A14: anything before the doctype puts the document into quirks mode.
		expect(dist.indexOf("<!doctype html>")).toBe(0);
		expect(dist).toContain(":root{--bg:#fff}");
		expect(dist).toContain("var app = 1;");
		expect(dist).toContain("var list = 1;");
		// Both wrappers must be complete: a missing closing tag is unusable HTML that an
		// index comparison alone would happily accept.
		expect(dist).toContain("<style>");
		expect(dist).toContain("</style>");
		expect(dist).toContain("<script>");
		expect(dist).toContain("</script>");
		// The markers are consumed, not shipped.
		expect(dist).not.toContain("<!--STYLE-->");
		expect(dist).not.toContain("<!--SCRIPT-->");
	});

	test("puts the script after the elements it will query, not in <head>", () => {
		// An inline classic script runs where it is parsed. In <head> it executes before the
		// body exists and every getElementById returns null, which is the quietest way for an
		// assembled document to do nothing at all.
		const dir = workdir();
		expect(build(dir).ok).toBe(true);
		const dist = readFileSync(join(dir, "dist.html"), "utf8");
		for (const tag of ["<style>", "</style>", "<script>", "</script>", "</head>", "</body>"]) {
			expect(dist).toContain(tag);
		}
		expect(dist.indexOf("<style>")).toBeLessThan(dist.indexOf("</head>"));
		expect(dist.indexOf("<script>")).toBeGreaterThan(dist.indexOf('<ul id="l">'));
		expect(dist.indexOf("</script>")).toBeLessThan(dist.indexOf("</body>"));
	});

	test("separates concatenated sources so one without a trailing newline cannot weld", () => {
		const dir = workdir();
		expect(build(dir).ok).toBe(true);
		const dist = readFileSync(join(dir, "dist.html"), "utf8");
		expect(dist).not.toContain("var list = 1;var app = 1;");
		expect(dist).toContain("var list = 1;\nvar app = 1;");
	});

	test("a missing source fails loudly and leaves the last good build in place", () => {
		const dir = workdir();
		expect(build(dir).ok).toBe(true);
		const good = readFileSync(join(dir, "dist.html"), "utf8");

		expect(build(dir, { components: false }).ok).toBe(false);
		expect(readFileSync(join(dir, "dist.html"), "utf8")).toBe(good);
	});

	// One case per guard: removing both markers at once would let either guard alone
	// account for the failure, so neither would actually be under test.
	test("a page missing its style marker fails instead of shipping an unstyled document", () => {
		const dir = workdir();
		expect(build(dir).ok).toBe(true);
		const good = readFileSync(join(dir, "dist.html"), "utf8");
		expect(build(dir, { style: false }).ok).toBe(false);
		expect(readFileSync(join(dir, "dist.html"), "utf8")).toBe(good);
	});

	test("a page missing its script marker fails instead of shipping a dead document", () => {
		const dir = workdir();
		expect(build(dir).ok).toBe(true);
		const good = readFileSync(join(dir, "dist.html"), "utf8");
		expect(build(dir, { script: false }).ok).toBe(false);
		expect(readFileSync(join(dir, "dist.html"), "utf8")).toBe(good);
	});

	test("a splice that dies part-way through cannot leave a truncated dist.html", () => {
		// This is what the part-file-and-rename buys. Without it the partial bytes the failing
		// splice already wrote would be sitting in dist.html, closing tags absent, still
		// valid enough for `curl --data-binary @dist.html` to publish.
		const dir = workdir();
		expect(build(dir).ok).toBe(true);
		const good = readFileSync(join(dir, "dist.html"), "utf8");

		expect(build(dir, { stubAwk: true }).ok).toBe(false);
		expect(readFileSync(join(dir, "dist.html"), "utf8")).toBe(good);
	});

	test("leaves no part file behind, on success or on failure", () => {
		const dir = workdir();
		expect(build(dir).ok).toBe(true);
		expect(build(dir, { stubAwk: true }).ok).toBe(false);
		for (const leftover of ["dist.html.part", "style.part", "script.part"]) {
			expect({ leftover, present: existsSync(join(dir, leftover)) }).toEqual({
				leftover,
				present: false,
			});
		}
	});

	// The two guards overlap deliberately, and these are the cases where they diverge —
	// without both, one of them could be deleted with no test noticing.
	test("both markers sharing one line is rejected, not silently half-spliced", () => {
		// `grep -c` counts lines, so the count guard sees one of each and passes. The splice
		// then matches the style rule, skips the line, and the script never lands at all.
		// Only re-reading the assembled file catches this.
		const dir = workdir();
		expect(build(dir).ok).toBe(true);
		const good = readFileSync(join(dir, "dist.html"), "utf8");
		expect(build(dir, { head: "<!--STYLE--><!--SCRIPT-->", foot: "" }).ok).toBe(false);
		expect(readFileSync(join(dir, "dist.html"), "utf8")).toBe(good);
	});

	test("a duplicated marker is rejected, not left as a stray comment in the output", () => {
		// Here the output check passes — the first marker does get its fragment — so only
		// counting catches the second one shipping as a literal comment.
		const dir = workdir();
		expect(build(dir).ok).toBe(true);
		const good = readFileSync(join(dir, "dist.html"), "utf8");
		expect(build(dir, { foot: "<!--SCRIPT-->\n<!--SCRIPT-->" }).ok).toBe(false);
		expect(readFileSync(join(dir, "dist.html"), "utf8")).toBe(good);
	});

	test("uses no GNU-only text tooling, so it runs where the document is authored", () => {
		// Agents author on macOS constantly, where BSD sed has no `Q` and base64 has no `-w`.
		const script = publishedScript();
		expect(script).not.toMatch(/\bsed\b[^\n]*\bQ\b/);
		expect(script).not.toContain("base64 -w");
		expect(script).not.toContain("grep -P");
	});
});
