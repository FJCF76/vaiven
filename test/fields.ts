// A10's field-type table, exercised in a real browser against a running server.
//
// Automatic mode was specified by three text inputs. Everything else — radio groups, same
// name on several checkboxes, <select multiple>, contenteditable, the fields that must
// NEVER be captured — was undefined, and "undefined" in a system that publishes state to a
// bearer URL means a password could end up in it. This is the table, executed.
//
//   bun run test/fields.ts     (env: the server's VAIVEN_*, plus VAIVEN_TENANT_KEY)

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

const content = await Bun.file(new URL("./fixtures/fields.html", import.meta.url)).text();

console.log(`Field-type coverage against ${config.appOrigin}\n`);

const created = await (
	await api("/api/docs", {
		method: "POST",
		body: JSON.stringify({ title: "Field coverage", read_key: true, content, state: {} }),
	})
).json();

const docId: string = created.id;
const writeKey: string = created.keys.find((k: any) => k.role === "write").key;
const readKey: string = created.keys.find((k: any) => k.role === "read").key;

// Seeding runs at publish time, so the defaults in the markup are state before anyone
// touches the document.
const seeded = created.state_keys ?? [];
check(Array.isArray(seeded) && seeded.includes("plain"), "publishing seeded the authored defaults");

const browser = await chromium.launch();
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));

await page.goto(`${config.appOrigin}/d/${docId}#k=${writeKey}`, { waitUntil: "load" });
const frame = page.frameLocator("iframe");
await frame.locator("input[name=plain]").waitFor({ timeout: 15_000 });

// Touch one control of every shape.
// type(), not fill(): fill() sets a value in one shot and never exercises the
// keystroke-by-keystroke path. This fixture is automatic mode, which does not repaint, so
// the app-mode repaint hazard is NOT covered here — test/repaint.ts covers that.
await frame.locator("input[name=plain]").fill("");
await frame.locator("input[name=plain]").type("changed", { delay: 30 });
await frame.locator("textarea[name=notes]").fill("first line\nsecond line");
await frame.locator('input[name=size][value="l"]').check();
await frame.locator('input[name=extras][value="salad"]').check();
await frame.locator('input[name=extras][value="fries"]').uncheck();
await frame.locator("input[name=agreed]").check();
await frame.locator("select[name=city]").selectOption("madrid");
await frame.locator("select[name=days]").selectOption(["tue", "wed"]);
await frame.locator("#summary").fill("rewritten by hand");

await page.waitForTimeout(200);
await page.goto("about:blank", { waitUntil: "load" });
check(errors.length === 0, "no uncaught errors in the shell", errors.join("; "));
await page.close();
await browser.close();

await new Promise((resolve) => setTimeout(resolve, 1500));

const data = await (await fetch(`${config.appOrigin}/r/${readKey}.json?since=0`)).json();
const state = data.state ?? {};
const shown = (key: string) => JSON.stringify(state[key]);

// ------------------------------------------------------------------ shapes per type

check(state.plain === "changed", "text input", shown("plain"));
check(state.notes === "first line\nsecond line", "textarea keeps its newlines", shown("notes"));
check(state.size === "l", "a radio group records the CHOSEN value, not the last element", shown("size"));
check(
	Array.isArray(state.extras) && state.extras.length === 1 && state.extras[0] === "salad",
	"same-name checkboxes are a set, and unchecking removes",
	shown("extras"),
);
check(state.agreed === true, "a lone checkbox is a boolean", shown("agreed"));
check(state.city === "madrid", "single select", shown("city"));
check(
	Array.isArray(state.days) && state.days.join(",") === "tue,wed",
	"<select multiple> is array-valued",
	shown("days"),
);
check(state.summary === "rewritten by hand", "contenteditable is captured by its name", shown("summary"));
check(state.count === "3" && state.when === "2026-01-01", "number and date seeded from the markup");
check(state.slider === "5", "range seeded from the markup", shown("slider"));

// -------------------------------------------------------------- what must NEVER appear

const serialized = JSON.stringify(state);
check(!serialized.includes("hunter2"), "a password never enters the document");
check(!("secret" in state), "not even as an empty key");
check(!("upload" in state), "type=file is skipped: it cannot be restored, so capturing it would lie");
check(!("csrf" in state), "hidden inputs are skipped");
check(!("offswitch" in state), 'autocomplete="off" is honoured');
check(!("ignored" in state), "data-vaiven-ignore is honoured");
check(!serialized.includes("private"), "neither opt-out leaked its value");
check(!("frozen" in state), "a field the author disabled is not captured");

// ---------------------------------------------------------------- unnamed fields (A3)

const structural = Object.keys(state).filter((key) => key.startsWith("~"));
check(structural.length === 1, "an unnamed field gets a structural key", structural.join(", "));
const warnings = data.warnings ?? [];
check(
	Array.isArray(warnings) && warnings.some((w: any) => String(w.code ?? w).includes("unnamed")),
	"and the agent is told, rather than finding a ~ key and guessing",
	JSON.stringify(warnings),
);

// ------------------------------------------------------------------------- the events

const edits = (data.events ?? []).filter((event: any) => event.kind === "edit");
const named = new Set(edits.map((event: any) => event.field));
for (const field of ["plain", "size", "city", "summary"]) {
	check(named.has(field), `the log names the ${field} change`, [...named].join(", "));
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
