// The app-mode repaint hazard, executed against the example the manual actually serves.
//
// guide.md is now the single page an agent gets, so its worked example is copy-paste bait:
// whatever it does wrong propagates into every document built from it. Two defects shipped
// in it and neither was caught by test/fields.ts, because that fixture is automatic mode
// (no repaint at all) and drives inputs with fill(), which sets a value once.
//
//   1. `render` re-runs synchronously inside `mutate`. A painter that rebuilds its nodes
//      destroys the input being typed into: one character, focus lost, the rest dropped.
//   2. Mutating on `change` instead moves the bug rather than fixing it. Clicking another
//      row's button shifts focus, which fires `change`, which repaints and re-inserts the
//      button before the click lands. The first click does nothing.
//
// So this reads the example OUT OF guide.md, publishes it, and drives it the way a person
// does. If someone edits the example into something that looks fine but breaks under a
// real cursor, this fails.
//
//   bun run test/repaint.ts     (env: the server's VAIVEN_*, plus VAIVEN_TENANT_KEY)

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

// From the manual itself, not a copy of it. A copy would drift and still pass.
const guide = await Bun.file(new URL("../guide.md", import.meta.url)).text();
const example = guide.match(/```html\n(<ul id="list">[\s\S]*?)```/)?.[1];
if (!example) {
	console.error("Could not find the worked example in guide.md. If it moved, update this test.");
	process.exit(2);
}
const content = `<!doctype html>\n<html><head><meta charset="utf-8"></head><body>\n${example}</body></html>`;

const api = (path: string, init: RequestInit = {}) =>
	fetch(`${config.appOrigin}${path}`, {
		...init,
		headers: { authorization: `Bearer ${tenantKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
	});

console.log(`App-mode repaint, guide.md's own example, against ${config.appOrigin}\n`);

const created = await (
	await api("/api/docs", {
		method: "POST",
		body: JSON.stringify({
			title: "Repaint regression",
			content,
			state: { items: [{ id: "seed-1", text: "first" }] },
		}),
	})
).json();

if (!created.id) {
	// A quota-exhausted tenant used to surface here as a product failure; say what the
	// server actually said instead.
	console.error(`Could not create the document: ${created.code ?? "?"} — ${created.message ?? ""}`);
	console.error(created.hint ?? "");
	process.exit(2);
}

const docId: string = created.id;
const writeKey: string = created.keys.find((k: any) => k.role === "write").key;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));

await page.goto(`${config.appOrigin}/d/${docId}#k=${writeKey}`, { waitUntil: "load" });
const frame = page.frameLocator("iframe");
await frame.locator("#add").waitFor({ timeout: 15_000 });

const rows = () => frame.locator("#list li").count();
const firstField = () => frame.locator("#list li input").first();

// 1. Typing, one keystroke at a time, the way a person does.
await firstField().click();
await firstField().fill("");
await firstField().type("hello world", { delay: 50 });
check(
	await firstField().evaluate((el) => el === document.activeElement),
	"focus survives a repaint mid-typing",
);
check((await firstField().inputValue()) === "hello world", "every keystroke lands", await firstField().inputValue());

// 2. Structural changes still work.
await frame.locator("#add").click();
await page.waitForTimeout(400);
await frame.locator("#add").click();
await page.waitForTimeout(900);
check((await rows()) === 3, "two adds produce two rows", `${await rows()} rows`);

// 3. The swallowed click: press Remove while another field is dirty and unblurred.
await firstField().click();
await firstField().fill("");
await firstField().type("dirty", { delay: 40 });
await frame.locator("#list li").nth(1).locator("button").click();
await page.waitForTimeout(1400);
check((await rows()) === 2, "Remove acts on the FIRST click while a field is dirty", `${await rows()} rows`);
check((await firstField().inputValue()) === "dirty", "the pending edit is not lost by the removal");

// 4. And a removal with nothing pending takes the row the person aimed at.
await frame.locator("#list li").nth(1).locator("button").click();
await page.waitForTimeout(1200);
check((await rows()) === 1, "a plain Remove works", `${await rows()} rows`);
check((await firstField().inputValue()) === "dirty", "the surviving row is the one that was not removed");

await page.waitForTimeout(3500);
const status = (await page.textContent(".status"))?.trim() ?? "";
check(/Saved/.test(status), "the shell reports the work saved", status);
check(errors.length === 0, "no page errors", errors.join("; "));

// 5. What the agent reads back must match what the person did.
const readBack = await (await api(`/api/docs/${docId}`)).json();
const items = readBack.state?.items ?? [];
check(items.length === 1 && items[0].text === "dirty", "the state an agent reads matches the screen", JSON.stringify(items));

await browser.close();
await api(`/api/docs/${docId}`, { method: "DELETE" });

console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
