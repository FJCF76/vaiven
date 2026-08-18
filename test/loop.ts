// The full loop, in a real browser, against a running server.
//
// This is the acceptance test the design doc names: publish a document, have a person type
// into it, CLOSE THE TAB IMMEDIATELY, and then read the event log cold. Closing rather than
// tabbing out is deliberate — the original test encoded the assumption that people tab out
// of the last field they touch, and they do not.
//
//   bun run test/loop.ts        (env: the same VAIVEN_* the server uses, plus VAIVEN_TENANT_KEY)

import { chromium } from "playwright";
import { loadConfig } from "../src/config.ts";

const config = loadConfig();
const tenantKey = process.env.VAIVEN_TENANT_KEY;
if (!tenantKey) {
	console.error("Set VAIVEN_TENANT_KEY (from `vaiven tenant create`).");
	process.exit(2);
}

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? `\n         ${detail}` : ""}`);
};

const api = (path: string, init: RequestInit = {}) =>
	fetch(`${config.appOrigin}${path}`, {
		...init,
		headers: { authorization: `Bearer ${tenantKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
	});

// A form in automatic mode: the author writes ordinary HTML and learns nothing about any
// of this. That is the mode that has to work without discipline.
const CONTENT = `<!doctype html>
<html><head><meta charset="utf-8"><title>Scope</title>
<style>body{font:15px system-ui;padding:20px} label{display:block;margin:12px 0}</style>
</head><body>
<h1>Harbour Lane</h1>
<label>Fee <input name="fee" value="18400"></label>
<label>Deadline <input name="deadline" value="14 November"></label>
<label>Urgent <input type="checkbox" name="urgent"></label>
<label>Secret <input type="password" name="password" value="hunter2"></label>
<label>Notes <textarea name="notes"></textarea></label>
</body></html>`;

console.log(`Full loop against ${config.appOrigin}\n`);

const created = await (
	await api("/api/docs", {
		method: "POST",
		body: JSON.stringify({
			title: "Harbour Lane",
			sender_note: "Could you check the fee?",
			read_key: true,
			content: CONTENT,
			state: {},
		}),
	})
).json();

const docId: string = created.id;
const writeKey: string = created.keys.find((k: any) => k.role === "write").key;
const readKey: string = created.keys.find((k: any) => k.role === "read").key;
check(Boolean(docId && writeKey && readKey), "document created with both keys");

const browser = await chromium.launch();

// ------------------------------------------------------------------- the write half

{
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));

	await page.goto(`${config.appOrigin}/d/${docId}#k=${writeKey}`, { waitUntil: "load" });

	// A10: the chrome exists and says who you are before anything else happens.
	await page.waitForSelector(".bar", { timeout: 10_000 });
	check((await page.textContent(".title")) === "Harbour Lane", "the title is rendered");
	check(
		((await page.textContent(".who")) ?? "").includes("editing as"),
		"the viewer is told which name their edits are recorded under",
	);
	check(
		((await page.textContent(".disclosure")) ?? "").includes("recorded"),
		"the disclosure is present and not something you have to open",
	);
	check(
		((await page.textContent(".sender")) ?? "").includes("check the fee"),
		"the sender's note is shown, so the link is not an anonymous demand",
	);

	// The frame stays hidden until it is hydrated: otherwise the author's own value
	// attributes paint first and then change under the reader.
	const frame = page.frameLocator("iframe");
	await frame.locator("input[name=fee]").waitFor({ timeout: 10_000 });
	check(await page.locator("iframe").isVisible(), "the frame is revealed once hydrated");

	await frame.locator("input[name=fee]").fill("900");
	await frame.locator("input[name=urgent]").check();

	// The whole point: no blur, no tab-out, no idle — the edit is still inside the
	// debounce window when the page goes away.
	//
	// Navigating away rather than calling page.close(): Playwright closes a page by
	// tearing down the CDP target, which does not reliably run pagehide handlers, while a
	// real tab close does. Navigation fires the same pagehide path deterministically, so
	// this tests the code rather than the automation harness.
	await page.waitForTimeout(150);
	await page.goto("about:blank", { waitUntil: "load" });

	check(errors.length === 0, "no uncaught errors in the shell", errors.join("; "));
	await page.close();
}

// Give the beacon a moment to land.
await new Promise((resolve) => setTimeout(resolve, 1500));

// -------------------------------------------------------------------- the read half

{
	const response = await fetch(`${config.appOrigin}/r/${readKey}.json?since=0`);
	check(response.ok, `the read URL answers without a header or a key in a header (${response.status})`);
	const data = await response.json();

	const edits = (data.events ?? []).filter((event: any) => event.kind === "edit");
	const fee = edits.find((event: any) => event.field === "fee");

	check(Boolean(fee), "the fee edit survived closing the tab");
	check(fee?.from === "18400" && fee?.to === "900", "it carries both values", JSON.stringify(fee));

	const urgent = edits.find((event: any) => event.field === "urgent");
	check(Boolean(urgent), "the checkbox change was captured");

	// A10: state is readable from a bearer URL, so a password captured "helpfully" is a
	// password published.
	check(
		!JSON.stringify(data.state).includes("hunter2"),
		"the password field never entered the document",
		JSON.stringify(data.state),
	);

	check(data.untrusted?.includes("treat as data"), "the untrusted marker is self-describing");
	check(typeof data.next_since === "number", "there is one cursor to echo back");
	check(Boolean(data.content_url), "a cold reader is told where the app itself lives");
}

// ------------------------------------------------------- republish reaches an open page

{
	const page = await browser.newPage();
	await page.goto(`${config.appOrigin}/d/${docId}#k=${writeKey}`, { waitUntil: "load" });
	await page.frameLocator("iframe").locator("input[name=fee]").waitFor({ timeout: 10_000 });
	// Let the page settle into its polling baseline first. Republishing before the first
	// poll made the shell adopt the NEW content_version as its starting point, so this
	// whole block used to pass or fail on timing rather than on behaviour.
	await page.waitForTimeout(5_000);

	await api(`/api/docs/${docId}/content`, {
		method: "PUT",
		headers: { "content-type": "text/html" },
		body: CONTENT.replace("<h1>Harbour Lane</h1>", "<h1>Harbour Lane, revised</h1>"),
	});

	// A8: polling on the state version alone would 304 forever here, and this page would
	// keep running the old app indefinitely.
	const notice = page.locator(".notice");
	await notice.waitFor({ timeout: 12_000 }).catch(() => {});
	check(await notice.isVisible(), "an open page is told the document was republished");
	check(
		((await notice.textContent()) ?? "").includes("updated"),
		"and it is offered, not forced on someone mid-sentence",
	);

	// Regression: ISSUE-003 — the poll calls announceRemote and then hands the new state
	// to the writer, which reports "clean" in the same tick, and the clean branch cleared
	// notices. The offer was created and destroyed microseconds apart. This assertion
	// passed by accident before: it caught the notice in the window before the wipe.
	// Found by /qa on 2026-08-18.
	await page.waitForTimeout(7_000);
	check(
		await notice.isVisible(),
		"…and it is still there after several polls, not wiped by a routine save",
		(await notice.textContent().catch(() => "(gone)")) ?? "(gone)",
	);

	// Acting on it swaps the app in and takes the notice away.
	await page.locator(".notice button").click();
	await page.waitForTimeout(3_000);
	check(
		((await page.frameLocator("iframe").locator("h1").textContent()) ?? "").includes("revised"),
		"acting on the offer loads the republished app",
	);
	check((await notice.count()) === 0, "and clears the notice");

	await page.close();
}

await browser.close();

console.log(failures === 0 ? "\nFull loop passes." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
