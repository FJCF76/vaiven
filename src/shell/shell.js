// The shell.
//
// It owns everything the content cannot be trusted with: the key, the network, the
// version, and the one place a person can be told what is being recorded about them.
//
// Two rules hold this file up:
//   1. NO innerHTML, ever. This page holds a write key in location.hash and renders
//      strings other people wrote (title, sender_note, key labels, event values). One
//      innerHTML here is a same-origin XSS with a credential on the page. textContent only.
//   2. Nothing from the frame is trusted. Messages are checked by source, the frame is
//      allowed exactly one load, and state is never posted to a frame that has not
//      announced itself since its last load.

import { Writer, threeWayMerge } from "../writer.ts";

const POLL_MS = 3_000;

// ------------------------------------------------------------------ page parameters

const docId = location.pathname.slice("/d/".length);
const key = new URLSearchParams(location.hash.slice(1)).get("k");

const el = (tag, className, text) => {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
};

function terminal(heading, body) {
	document.body.replaceChildren();
	const wrap = el("div", "terminal");
	wrap.append(el("h1", null, heading), el("p", null, body));
	document.body.append(wrap);
	document.title = heading;
}

if (!key) {
	// A10: a truncated paste is indistinguishable from a revoked link to the person
	// holding it, so both get the same honest answer and neither renders the document.
	terminal(
		"This link is incomplete",
		"The part after the # is missing, which is the part that opens the document. Ask whoever shared it to send the whole link.",
	);
	throw new Error("no key");
}

// ------------------------------------------------------------------------ the chrome

const bar = el("div", "bar");
const identity = el("div", "identity");
const titleEl = el("div", "title", "Loading…");
const whoEl = el("div", "who", "");
identity.append(titleEl, whoEl);

const statusEl = el("div", "status", "");
statusEl.dataset.kind = "clean";

const recordedButton = el("button", "link", "What's recorded");
const doneButton = el("button", "primary", "Done for now");
doneButton.disabled = true;

bar.append(identity, statusEl, recordedButton, doneButton);

const disclosure = el("div", "disclosure");
const senderEl = el("div", "sender");
senderEl.hidden = true;
const noticeSlot = el("div");
const skeleton = el("div", "skeleton", "Opening the document…");

const frame = document.createElement("iframe");
frame.title = "Document";
// A4's union trap: sandbox restrictions are the UNION of this attribute and the CSP
// sandbox directive on the response. The flag set has ONE definition, in headers.ts, and
// travels here through the markup so the two cannot drift. Omitting the attribute would
// leave the frame confined only by the header — which holds, until something strips it.
frame.setAttribute("sandbox", document.documentElement.dataset.sandboxFlags ?? "allow-scripts");
frame.setAttribute("allow", "");
frame.setAttribute("referrerpolicy", "no-referrer");
frame.hidden = true;

document.body.replaceChildren(bar, disclosure, senderEl, noticeSlot, skeleton, frame);

function setStatus(text, kind) {
	statusEl.textContent = text;
	statusEl.dataset.kind = kind;
}

function showNotice(text, actionLabel, onAction, accent) {
	noticeSlot.replaceChildren();
	const notice = el("div", accent ? "notice accent" : "notice");
	notice.append(el("span", "grow", text));
	if (actionLabel) {
		const button = el("button", null, actionLabel);
		button.addEventListener("click", onAction);
		notice.append(button);
	}
	noticeSlot.append(notice);
	return notice;
}

const clearNotice = () => noticeSlot.replaceChildren();

// --------------------------------------------------------------------- API plumbing

const api = (path, init = {}) =>
	fetch(`/api/docs/${encodeURIComponent(docId)}${path}`, {
		...init,
		headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
	});

let unloading = false;
let doc = null;
let mode = "read";
let frameReady = false;
let loadCount = 0;

// ------------------------------------------------------------------- the write path

const writer = new Writer({
	now: () => Date.now(),
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: (handle) => clearTimeout(handle),
	randomId: () => crypto.randomUUID(),
	merge: threeWayMerge,

	async put({ state, events, ifMatch }) {
		try {
			const payload = JSON.stringify({ state, events });
			// A1: a normal fetch is cancelled when the page goes away, so an edit made
			// inside the debounce window and followed by a tab close was simply lost.
			// keepalive survives unload. It caps at 64 KiB across all in-flight requests,
			// which is why large states are flushed eagerly rather than held (see below).
			const useKeepalive = unloading && payload.length < 60_000;
			const response = await api("/state", {
				method: "PUT",
				keepalive: useKeepalive,
				headers: { "content-type": "application/json", "if-match": `"${ifMatch}"` },
				body: payload,
			});

			if (response.ok) return { ok: true, version: (await response.json()).version };

			const body = await response.json().catch(() => ({}));
			if (response.status === 409) {
				return { ok: false, conflict: { version: body.version, state: body.state } };
			}

			const fatal = response.status === 401 || response.status === 403 || response.status === 404;
			return {
				ok: false,
				error: {
					code: body.error?.code ?? String(response.status),
					message: body.error?.message ?? "Your changes could not be saved.",
					fatal,
				},
			};
		} catch {
			// Offline or the server went away. Transient by definition.
			return { ok: false, error: { code: "offline", message: "offline", fatal: false } };
		}
	},

	onStatus(status) {
		switch (status.kind) {
			case "clean":
				setStatus(status.at ? `Saved ${timeOf(status.at)}` : "Saved", "clean");
				clearNotice();
				break;
			case "dirty":
				setStatus("Unsaved changes", "dirty");
				break;
			case "saving":
				setStatus("Saving…", "saving");
				break;
			case "retrying":
				setStatus("Not saved — retrying", "retrying");
				if (status.attempt >= 3) {
					// A10: after repeated failures this stops being a status and becomes
					// something the person has to be able to act on.
					showNotice(
						"Your changes aren't saving. Don't close this tab.",
						"Copy my changes",
						copyPending,
					);
				}
				break;
			case "blocked":
				setStatus("Not saved", "blocked");
				showNotice(status.reason, "Copy my changes", copyPending);
				break;
			case "readonly":
				setStatus("Read-only", "clean");
				break;
		}
	},

	onAdopt(state, version) {
		if (doc) doc.version = version;
		postToFrame({ type: "state", state, version, mode });
	},
});

const timeOf = (ms) =>
	new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The last thing standing between a failed save and someone losing an afternoon. */
async function copyPending() {
	const snapshot = JSON.stringify(latestState ?? {}, null, 2);
	try {
		await navigator.clipboard.writeText(snapshot);
		showNotice("Copied. Paste it somewhere safe before closing this tab.", null, null, true);
	} catch {
		showNotice("Could not copy automatically — select the text in the console instead.", null, null);
		console.log(snapshot);
	}
}

let latestState = null;

// ------------------------------------------------------------------ frame lifecycle

/**
 * A4: the frame gets exactly one load per navigation we asked for.
 *
 * After a frame navigates itself away, `iframe.contentWindow` is the SAME WindowProxy, so
 * an `e.source === frame.contentWindow` check still passes and the shell would keep
 * posting state to whatever now lives there — turning one document's state in one URL
 * into a permanent push channel. Counting loads closes that regardless of what any
 * particular browser does about self-navigation.
 */
let expectedLoads = 0;

frame.addEventListener("load", () => {
	loadCount++;
	if (loadCount > expectedLoads) {
		frameReady = false;
		frame.remove();
		showNotice(
			"This document tried to navigate somewhere else, so it has been closed. Nothing was sent to it.",
			null,
			null,
		);
		return;
	}
	// `ready` from the helper is what actually unblocks us; load only bounds the count.
});

function attachFrame() {
	expectedLoads++;
	frameReady = false;
	frame.hidden = true;
	skeleton.hidden = false;
	frame.src = `${SANDBOX_ORIGIN}/c/${encodeURIComponent(docId)}`;
	document.body.append(frame);
}

function postToFrame(message) {
	// Never post to a frame that has not announced itself since its last load.
	if (!frameReady || !frame.contentWindow) return;
	// targetOrigin must be "*": the frame's origin is opaque, so there is no name to
	// address. Identity comes from the source check on the way back in, and from the
	// load counter above.
	frame.contentWindow.postMessage(message, "*");
}

// ------------------------------------------------------------------ messages inward

addEventListener("message", (event) => {
	if (!frame.contentWindow || event.source !== frame.contentWindow) return;
	const message = event.data;
	if (!message || typeof message !== "object") return;

	switch (message.type) {
		case "ready":
			frameReady = true;
			// A10: hydrate, THEN reveal. Otherwise the author's markup paints its own
			// value attributes first and the values change under the reader — and any
			// keystroke in that window is overwritten.
			postToFrame({ type: "init", state: latestState ?? {}, version: doc?.version ?? 0, mode });
			skeleton.hidden = true;
			frame.hidden = false;
			doneButton.disabled = mode !== "write";
			break;

		case "mutate":
			if (mode !== "write") return;
			latestState = message.state;
			writer.localChange(message.state);
			break;

		case "event":
			if (mode !== "write") return;
			writer.localChange(latestState ?? {}, [{ kind: "note", note: String(message.kind ?? "") }]);
			break;

		case "error":
			// A12: the agent published JavaScript it cannot run. Without this the human
			// sees a blank page and the agent learns nothing until somebody complains.
			void api("/events", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ events: [{ kind: "error", note: `${message.kind}: ${message.detail}` }] }),
			});
			break;

		case "open":
			// A4: content cannot navigate anything itself. It asks, we show where, the
			// person decides.
			confirmOpen(message.url);
			break;

		case "resize":
			if (typeof message.height === "number" && message.height > 0) {
				frame.style.height = `${Math.min(message.height, 20000)}px`;
			}
			break;
	}
});

function confirmOpen(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		return;
	}
	if (url.protocol !== "https:" && url.protocol !== "mailto:") return;

	const where = url.protocol === "mailto:" ? url.pathname : url.host;
	showNotice(`This document wants to open ${where}`, "Open in a new tab", () => {
		window.open(url.href, "_blank", "noopener,noreferrer");
		clearNotice();
	});
}

// --------------------------------------------------------------------------- render

function renderChrome() {
	titleEl.textContent = doc.title || "Untitled document";
	document.title = doc.title || "Vaiven document";

	const label = doc.actor_label ?? "you";
	whoEl.textContent = mode === "write" ? `editing as ${label}` : `read-only · ${label}`;

	// A10: persistent, not dismissible, and outside the frame so content cannot suppress
	// it. In automatic mode the author never knows this is happening, which makes the
	// shell the only thing that can say so.
	disclosure.replaceChildren(
		el(
			"span",
			null,
			`Edits here are recorded as “${label}” and shared with whoever sent you this link.`,
		),
	);

	if (doc.sender_note) {
		senderEl.hidden = false;
		senderEl.replaceChildren(el("strong", null, "Note: "), document.createTextNode(doc.sender_note));
	}
}

// -------------------------------------------------------------- what's recorded panel

const panel = document.createElement("dialog");
const panelBody = el("div", "panel-body");
{
	const head = el("div", "panel-head");
	const close = el("button", null, "Close");
	close.addEventListener("click", () => panel.close());
	head.append(el("h2", null, "What's recorded"), close);
	panel.append(head, panelBody);
	document.body.append(panel);
}

recordedButton.addEventListener("click", async () => {
	panelBody.replaceChildren(el("p", null, "Loading…"));
	panel.showModal();

	const response = await api("?since=0").catch(() => null);
	if (!response || !response.ok) {
		panelBody.replaceChildren(el("p", null, "Could not load the record just now."));
		return;
	}
	const data = await response.json();
	renderRecord(data.events ?? []);
});

function renderRecord(events) {
	panelBody.replaceChildren();
	panelBody.append(
		el(
			"p",
			null,
			"Everything this document has recorded, including who made each change. The person who shared the link can read all of it.",
		),
	);

	if (events.length === 0) {
		panelBody.append(el("p", null, "Nothing recorded yet."));
		return;
	}

	for (const event of events) {
		const row = el("div", "event");
		row.append(el("div", "when", new Date(event.at).toLocaleString()));

		const what = el("div", "what");
		what.append(el("span", "field", event.field ?? event.kind), document.createTextNode(" "));
		if (event.op) {
			what.append(document.createTextNode(`${event.op} ${event.item ?? ""}`));
		} else if (event.from !== undefined || event.to !== undefined) {
			what.append(el("span", "from", event.from || "(empty)"));
			what.append(document.createTextNode(" → "));
			what.append(document.createTextNode(event.to || "(empty)"));
		} else if (event.note) {
			what.append(document.createTextNode(event.note));
		}
		what.append(el("div", "when", `by ${event.actor}`));
		row.append(what);
		panelBody.append(row);
	}
}

// ----------------------------------------------------------------- done for now

doneButton.addEventListener("click", async () => {
	const note = prompt("Anything you want to say about what you changed? (optional)") ?? "";
	writer.flush("done");
	await api("/events", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ events: [{ kind: "done", note }] }),
	}).catch(() => {});

	doneButton.disabled = true;
	doneButton.textContent = "Sent";
	setStatus("Sent — thank you", "clean");
});

// ------------------------------------------------------------------------- unload

// A10/A1: closing a tab within the debounce window must not lose the last edit. Only the
// POLL pauses on visibility; the write pipeline never does.
addEventListener("pagehide", () => {
	unloading = true;
	writer.flush("pagehide");
});
addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") {
		unloading = true;
		writer.flush("hidden");
	} else {
		unloading = false;
	}
});

// ---------------------------------------------------------------------------- poll

let polling = true;

async function poll() {
	if (!polling) return;
	if (document.visibilityState === "hidden") return;

	try {
		const response = await api(`?since=${doc?.version ?? 0}`, {
			headers: doc ? { "if-none-match": `W/"${doc.version}.${doc.content_version}"` } : {},
		});

		if (response.status === 304) return;
		if (response.status === 401 || response.status === 404) {
			polling = false;
			terminal(
				"This link is no longer active",
				"The person who shared it can send you a new one. Anything you had already saved is safe.",
			);
			return;
		}
		if (!response.ok) return;

		const data = await response.json();

		// A8: the composite ETag. Republishing content bumps content_version, not
		// version, so polling on version alone would 304 forever and this page would keep
		// running the old app.
		if (doc && data.content_version !== doc.content_version) {
			doc.content_version = data.content_version;
			offerReload();
		}

		if (data.events?.length) announceRemote(data.events);

		doc.title = data.title;
		doc.version = data.version;
		writer.observeServer(data.version, data.state);
		latestState = data.state;
		renderChrome();
	} catch {
		// Offline. The next tick tries again; the writer surfaces its own failures.
	}
}

setInterval(poll, POLL_MS);

/** A10: never yank the frame out from under someone. */
function offerReload() {
	// Always a click, never automatic: reloading the frame under someone mid-sentence is
	// the same violence as a 409 that overwrites what they typed.
	showNotice(
		"This document has been updated.",
		"Reload it",
		() => {
			if (writer.snapshot().pending) writer.flush("before reload");
			clearNotice();
			attachFrame();
		},
		true,
	);
}

/** A10: the strongest moment in the product — the person seeing the agent respond. */
function announceRemote(events) {
	const fromAgent = events.filter((event) => event.actor === "claude" && event.kind === "edit");
	if (fromAgent.length === 0) return;

	const first = fromAgent[0].field ?? "the document";
	const rest = fromAgent.length - 1;
	showNotice(
		rest > 0 ? `Claude updated ${first} and ${rest} other field${rest > 1 ? "s" : ""}.` : `Claude updated ${first}.`,
		"Dismiss",
		clearNotice,
		true,
	);
}

// ---------------------------------------------------------------------------- boot

const SANDBOX_ORIGIN = document.documentElement.dataset.sandboxOrigin ?? "";

(async () => {
	let response;
	try {
		response = await api("?since=0");
	} catch {
		terminal("Can't reach the server", "Check your connection and reload the page.");
		return;
	}

	// A10: validate BEFORE attaching the frame. /c/:id needs no auth, so a revoked key
	// would otherwise render a perfectly interactive document that silently discards
	// every keystroke.
	if (response.status === 401 || response.status === 403 || response.status === 404) {
		terminal(
			"This link is no longer active",
			"It may have been revoked, or the document may have been deleted. Ask whoever shared it for a new link.",
		);
		return;
	}
	if (!response.ok) {
		terminal("Something went wrong", "The document could not be opened. Try again in a moment.");
		return;
	}

	doc = await response.json();
	latestState = doc.state ?? {};

	// The key's own role decides what this view can do. `keys` is tenant-only, so a
	// document key learns its role from whether writing is permitted at all.
	mode = doc.mode ?? "write";

	renderChrome();
	writer.adopt(latestState, doc.version);
	if (mode !== "write") writer.setReadonly(true);
	attachFrame();
})();
