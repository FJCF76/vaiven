// Phase 0 blocking gates.
//
// Four things either work or they silently do not, and every one of them fails open:
//   1. Opaque origin under DIRECT navigation, not merely inside a frame.
//   2. Host partition — /c on the app host, /d on the sandbox host, forged Host.
//   3. Both CSP headers, byte-exact. A typo in frame-ancestors fails open silently.
//   4. The conformance canary — every capability A4 says is allowed still works.
//
// Plus one non-blocking probe: whether a framed document can navigate itself away.
//
// Run against the REAL deployment. Localhost proves the code; only a real request
// proves the headers, the proxy and the certificate.
//
//   bun run test/gate.ts

import { chromium, type Browser } from "playwright";
import { loadConfig } from "../src/config.ts";
import { contentCsp, shellCsp, SANDBOX_ATTRIBUTE } from "../src/headers.ts";

const config = loadConfig();
const BIND = `${config.bind}:${config.port}`;

let failures = 0;
let checks = 0;

function report(ok: boolean, label: string, detail = ""): void {
	checks++;
	if (!ok) failures++;
	const mark = ok ? "  ok  " : " FAIL ";
	console.log(`${mark} ${label}${detail ? `\n         ${detail}` : ""}`);
}

/** Raw HTTP through curl: `fetch` refuses to set Host, and Host is what we are testing. */
async function head(host: string, path: string): Promise<{ status: number; headers: Map<string, string> }> {
	const proc = Bun.spawn(
		["curl", "-s", "-o", "/dev/null", "-D", "-", "-H", `Host: ${host}`, `http://${BIND}${path}`],
		{ stdout: "pipe" },
	);
	const raw = await new Response(proc.stdout).text();
	const lines = raw.split(/\r?\n/);
	const status = Number(lines[0]?.split(" ")[1] ?? 0);
	const headers = new Map<string, string>();
	for (const line of lines.slice(1)) {
		const idx = line.indexOf(":");
		if (idx > 0) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
	}
	return { status, headers };
}

// ---------------------------------------------------------------- gate 2: partition

async function gateHostPartition(): Promise<void> {
	console.log("\nGATE 2 — host partition");

	const cases: Array<[string, string, string, number]> = [
		["/c on the app host is not served", config.appHost, "/c/probe", 404],
		["/d on the sandbox host is not served", config.sandboxHost, "/d/probe", 404],
		["/api on the sandbox host is not served", config.sandboxHost, "/api/docs", 404],
		["/r on the sandbox host is not served", config.sandboxHost, "/r/x.json", 404],
		["a forged Host is misdirected", "evil.example", "/", 421],
		["an unknown subdomain is misdirected", `x.${config.appHost}`, "/", 421],
		["/c on the sandbox host is served", config.sandboxHost, "/c/probe", 200],
		["/d on the app host is served", config.appHost, "/d/probe", 200],
	];

	for (const [label, host, path, want] of cases) {
		const { status } = await head(host, path);
		report(status === want, label, status === want ? "" : `got ${status}, want ${want}`);
	}

	// Case and port normalization: Host is attacker-controlled, so every equivalent
	// spelling must land on the same surface and no other spelling may.
	const upper = await head(config.sandboxHost.toUpperCase() + ":443", "/c/probe");
	report(upper.status === 200, "Host is compared case-insensitively and port-stripped",
		upper.status === 200 ? "" : `got ${upper.status}`);

	const trailing = await head(config.sandboxHost + ".", "/c/probe");
	report(trailing.status === 200, "a fully-qualified trailing dot is the same host",
		trailing.status === 200 ? "" : `got ${trailing.status}`);
}

// ------------------------------------------------------------------- gate 3: headers

async function gateHeaders(): Promise<void> {
	console.log("\nGATE 3 — CSP golden strings");

	const content = await head(config.sandboxHost, "/c/probe");
	const wantContent = contentCsp(config);
	const gotContent = content.headers.get("content-security-policy") ?? "";
	report(gotContent === wantContent, "content CSP is byte-exact",
		gotContent === wantContent ? "" : `got:  ${gotContent}\n         want: ${wantContent}`);

	// The directive that cannot be tested any other way: if it is wrong, the frame is
	// simply embeddable somewhere it should not be, and nothing else notices.
	report(gotContent.includes(`frame-ancestors ${config.appOrigin}`),
		"content frame-ancestors names the app origin exactly");
	report(gotContent.includes("connect-src 'none'"), "content cannot reach the network");
	report(gotContent.startsWith("sandbox "), "the sandbox directive is in the header, not only the attribute");

	const shell = await head(config.appHost, "/d/probe");
	const wantShell = shellCsp(config);
	const gotShell = shell.headers.get("content-security-policy") ?? "";
	report(gotShell === wantShell, "shell CSP is byte-exact",
		gotShell === wantShell ? "" : `got:  ${gotShell}\n         want: ${wantShell}`);
	report(gotShell.includes("frame-ancestors 'none'"), "the shell itself cannot be framed");

	for (const [name, want] of [
		["permissions-policy", "camera=()"],
		["cross-origin-resource-policy", "same-site"],
		["referrer-policy", "no-referrer"],
		["cache-control", "no-store"],
	] as const) {
		const got = content.headers.get(name) ?? "";
		report(got.includes(want), `content ${name} carries ${want}`, got ? "" : "header absent");
	}

	report((shell.headers.get("cross-origin-opener-policy") ?? "") === "same-origin",
		"shell Cross-Origin-Opener-Policy is same-origin");
}

// -------------------------------------------------------- gates 1 and 4: the browser

async function gateBrowser(browser: Browser): Promise<void> {
	console.log("\nGATE 1 — opaque origin under direct navigation");

	const page = await browser.newPage();
	await page.goto(`${config.sandboxOrigin}/c/probe`, { waitUntil: "load", timeout: 30_000 });
	await page.waitForSelector("html[data-probe='done']", { timeout: 10_000 });
	const probe = await page.evaluate(() => (window as any).__probe);

	// If this is not "null", §3's isolation argument is wrong and everything built on
	// top of it inherits a hole. There is no graceful degradation here.
	report(probe.origin === "null", "window.origin is null with no frame involved",
		probe.origin === "null" ? "" : `got ${probe.origin}`);
	report(probe.storageThrows === true, "localStorage access throws",
		probe.storageThrows ? "" : "storage was readable");
	report(probe.cookieEmpty === true, "document.cookie is empty");
	report(probe.hasParent === false, "this was genuinely a top-level navigation");

	// The iframe attribute must not be narrower than the header (A4's union trap).
	const shellHtml = await (await fetch(`${config.appOrigin}/d/probe`)).text();
	const attr = shellHtml.match(/sandbox="([^"]*)"/)?.[1] ?? "";
	report(attr === SANDBOX_ATTRIBUTE, "iframe sandbox attribute matches the header flags",
		attr === SANDBOX_ATTRIBUTE ? "" : `attr: "${attr}"\n         hdr:  "${SANDBOX_ATTRIBUTE}"`);

	console.log("\nGATE 4 — conformance canary");

	const canaryPage = await browser.newPage();
	const consoleErrors: string[] = [];
	canaryPage.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

	await canaryPage.goto(`${config.sandboxOrigin}/c/canary`, { waitUntil: "load", timeout: 30_000 });
	await canaryPage.waitForSelector("html[data-canary='done']", { timeout: 20_000 });
	const canary = await canaryPage.evaluate(() => (window as any).__canary);

	const expected = [
		"compatMode", "eval", "canvas", "webgl", "animation", "modalsPresent",
		"pointerLockPresent", "blobScript", "worker", "audioDataUri",
		"fontDataUriAllowed", "nestedFrame", "networkBlocked",
	];
	for (const name of expected) {
		report(canary.checks[name] === true, `canary: ${name}`,
			canary.checks[name] === true ? "" : `got ${canary.checks[name]}`);
	}

	// A dialog EVENT is the only way to tell "allow-modals granted" from "confirm()
	// returned false instantly because it was suppressed".
	let dialogSeen = false;
	canaryPage.on("dialog", async (d) => { dialogSeen = true; await d.dismiss(); });
	await canaryPage.evaluate(() => (window as any).__testModal());
	await canaryPage.waitForTimeout(500);
	report(dialogSeen, "canary: modals actually open (allow-modals is in effect)");

	if (canary.violations.length) {
		console.log(`         CSP violations observed: ${JSON.stringify(canary.violations)}`);
	}

	await page.close();
	await canaryPage.close();
}

// ------------------------------------------------------- probe: frame self-navigation

async function probeSelfNavigation(browser: Browser): Promise<void> {
	console.log("\nPROBE — frame self-navigation (recorded, not blocking)");

	const page = await browser.newPage();
	await page.goto(`${config.appOrigin}/d/probe`, { waitUntil: "load", timeout: 30_000 });
	await page.waitForTimeout(1500);

	const frame = page.frames().find((f) => f !== page.mainFrame());
	if (!frame) {
		console.log("         no child frame found — skipped");
		await page.close();
		return;
	}

	const before = frame.url();
	try {
		await frame.evaluate(() => { location.href = "https://example.com/?vaiven-selfnav=1"; });
	} catch (error) {
		console.log(`         evaluate threw: ${(error as Error).message.slice(0, 120)}`);
	}
	await page.waitForTimeout(3000);

	const after = page.frames().find((f) => f !== page.mainFrame())?.url() ?? "(frame gone)";
	const navigated = after.includes("example.com");
	console.log(`         before: ${before}`);
	console.log(`         after:  ${after}`);
	console.log(
		navigated
			? "         RESULT: the frame CAN navigate itself. The A4 onload counter is load-bearing."
			: "         RESULT: self-navigation did not take effect here.",
	);
	console.log("         Either way the onload counter ships — the probe records, it does not decide.");

	await page.close();
}

// ------------------------------------------------------------------------------ main

console.log(`Phase 0 gates against ${config.appOrigin} / ${config.sandboxOrigin}`);

await gateHostPartition();
await gateHeaders();

const browser = await chromium.launch();
try {
	await gateBrowser(browser);
	await probeSelfNavigation(browser);
} finally {
	await browser.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
	console.error(`\n${failures} BLOCKING failure(s). Phase 1 does not start.`);
	process.exit(1);
}
console.log("\nAll Phase 0 gates pass.");
