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

// Every save-state transition and every warning, including "don't close this tab", was
// announced to nobody.
statusEl.setAttribute("role", "status");
statusEl.setAttribute("aria-live", "polite");

bar.append(identity, statusEl, recordedButton, doneButton);

const disclosure = el("div", "disclosure");
disclosure.hidden = true;
const senderEl = el("div", "sender");
senderEl.hidden = true;
const noticeSlot = el("div", "notices");
noticeSlot.setAttribute("aria-live", "assertive");
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

/**
 * One slot, eight meanings. A single `sticky` boolean was not enough to say which of two
 * notices matters more, and three separate failures came out of that:
 *
 *   - Marking the agent-updated toast sticky let it destroy the `blocked` notice, which is
 *     TERMINAL — the writer stops, so that notice never comes back and the only escape
 *     hatch for the unsaved work is gone for good.
 *   - Once every caller passed sticky, the `clean` branch's clearNotice() became dead, so
 *     "your changes aren't saving" sat on screen after the save succeeded.
 *   - The republish offer could be replaced and never re-offered, leaving the page running
 *     the old app — the exact failure the composite ETag exists to prevent.
 *
 * So notices carry a TOPIC and a rank. A notice may only replace one of equal or lower
 * rank, and a topic is only cleared by something that actually resolves it.
 *
 *   security (3) — a question about leaving the page or a frame that misbehaved
 *   saving   (2) — the person's work is at risk
 *   update   (1) — something changed that they may want to act on
 */
const NOTICE_RANK = { security: 3, saving: 2, update: 1 };

function showNotice(text, actionLabel, onAction, accent, topic = "update") {
	const rank = NOTICE_RANK[topic] ?? 1;
	const live = noticeSlot.firstElementChild;

	if (live) {
		const liveRank = NOTICE_RANK[live.dataset.topic] ?? 1;
		if (rank < liveRank) return null;
		// The retry loop re-asserts the same warning on every attempt. Rebuilding it wiped
		// anything added beside it, including the confirmation for its own button.
		if (live.dataset.text === text) return live;
	}

	noticeSlot.replaceChildren();
	const notice = el("div", accent ? "notice accent" : "notice");
	notice.dataset.text = text;
	notice.dataset.topic = topic;
	notice.append(el("span", "grow", text));
	if (actionLabel) {
		const button = el("button", null, actionLabel);
		button.addEventListener("click", onAction);
		notice.append(button);
	}
	noticeSlot.append(notice);
	return notice;
}

/** Clear only what the caller actually resolved. A successful save resolves "saving"; it
 *  says nothing about a pending security question or an unanswered republish offer. */
function clearNotice(topic) {
	const live = noticeSlot.firstElementChild;
	if (!live) return;
	if (topic && live.dataset.topic !== topic) return;
	noticeSlot.replaceChildren();
}

// --------------------------------------------------------------------- API plumbing

const api = (path, init = {}) =>
	fetch(`/api/docs/${encodeURIComponent(docId)}${path}`, {
		...init,
		headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
	});

let unloading = false;
/** Deduped and capped: see the `error` case below. */
const reportedErrors = new Set();
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

	async put({ state, events, ifMatch, requestId }) {
		try {
			// A7: the writer mints this so a timeout that the server actually committed
			// comes back as a replay instead of a 409, and the recovery path stops
			// discarding edits that were already saved. It was generated, handed to this
			// function, and then left out of the body — so the entire server-side dedupe
			// path was unreachable from the only client there is.
			const payload = JSON.stringify({ state, events, request_id: requestId });
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
				// Only the saving warning. A pending "open this URL?" question and an
				// unanswered republish offer both outlive a successful save.
				clearNotice("saving");
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
						false,
						"saving",
					);
				}
				break;
			case "blocked":
				setStatus("Not saved", "blocked");
				showNotice(status.reason, "Copy my changes", copyPending, false, "saving");
				break;
			case "readonly":
				setStatus("Read-only", "readonly");
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

/** The bar said "7:27 AM" and the panel said "8/18/2026, 7:27:17 AM" for the same instant,
 *  and the long one sat in the narrowest column in the product. Same clock, and the date
 *  only when it is not today. */
const whenOf = (iso) => {
	const at = new Date(iso);
	const today = new Date();
	const sameDay =
		at.getFullYear() === today.getFullYear() &&
		at.getMonth() === today.getMonth() &&
		at.getDate() === today.getDate();
	return sameDay
		? timeOf(at.getTime())
		: `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${timeOf(at.getTime())}`;
};

/** The last thing standing between a failed save and someone losing an afternoon. */
async function copyPending() {
	const snapshot = JSON.stringify(latestState ?? {}, null, 2);
	// Both outcomes are sticky. The notice this replaces is sticky, so without that flag
	// the guard refused them and clicking "Copy my changes" produced NO feedback at all —
	// in the one moment where silence reads as "the button is broken" and the person is
	// deciding whether it is safe to close the tab.
	// Captured BEFORE the await: a poll tick in that window can replace the slot, and the
	// confirmation would land on whatever notice is there now.
	const target = noticeSlot.firstElementChild;

	let message;
	try {
		await navigator.clipboard.writeText(snapshot);
		message = "Copied — paste it somewhere safe.";
	} catch {
		console.log(snapshot);
		message = "Could not copy automatically. Your changes are in the browser console.";
	}

	// Said INSIDE the warning, not instead of it: the changes still are not saved, so
	// replacing that sentence with a cheerful one would be a lie by omission. Replacing
	// the notice outright also lost the message a second later, because the retry loop
	// re-asserts its own warning on every attempt.
	if (!target || !target.isConnected) {
		showNotice(message, null, null, true, "saving");
		return;
	}
	const existing = target.querySelector(".confirm");
	if (existing) existing.textContent = message;
	else target.append(el("span", "confirm", message));
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
		// Otherwise everything below the notice is blank ground with no route back.
		skeleton.hidden = false;
		skeleton.textContent = "The document was closed. Reload the page to open it again.";
		showNotice(
			"This document tried to navigate somewhere else, so it has been closed. Nothing was sent to it.",
			null,
			null,
			false,
			"security",
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

		case "event": {
			// `Vaiven.log(kind, payload)`. The kind an app chooses is its own label, not one
			// of the kinds a client may assert, so it travels as the note — but the payload
			// used to be dropped here, which made `Vaiven.log("submitted", {total: 42})`
			// record the word "submitted" and nothing else. The payload is the part the
			// agent reads.
			if (mode !== "write") return;
			const label = String(message.kind ?? "").slice(0, 60);
			const annotation = { kind: "note", note: label };
			if (message.payload !== undefined && message.payload !== null) {
				try {
					annotation.payload = JSON.stringify(message.payload);
				} catch {
					annotation.payload = String(message.payload);
				}
			}
			writer.localChange(latestState ?? {}, [annotation]);
			break;
		}

		case "error": {
			// A12: the agent published JavaScript it cannot run. Without this the human
			// sees a blank page and the agent learns nothing until somebody complains.
			//
			// But content is not obliged to use the helper: it can post this itself, in a
			// loop, and each one was an authenticated write. That let a buggy or hostile
			// document exhaust the person's own write budget and 429 their real edits,
			// while writing attacker-chosen text into the log the agent reads.
			if (mode !== "write") break;
			if (typeof message.kind !== "string" || typeof message.detail !== "string") break;
			const note = `${message.kind}: ${message.detail}`.slice(0, 200);
			if (reportedErrors.has(note) || reportedErrors.size >= 10) break;
			reportedErrors.add(note);
			void api("/events", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ events: [{ kind: "error", note }] }),
			});
			break;
		}

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

	// Show the whole URL. Showing only the host let content encode everything the person
	// typed into the query string of a benign-looking domain: they approve "example.com"
	// and open https://example.com/?s=<their answers>. With connect-src 'none' and popups
	// denied, this is the last egress path, so it has to be legible.
	const where = url.href.length > 120 ? `${url.href.slice(0, 119)}…` : url.href;
	// Sticky: this asks a security question, and a background save completing must not
	// answer it by making it disappear.
	showNotice(
		`This document wants to open ${where}`,
		"Open in a new tab",
		() => {
			window.open(url.href, "_blank", "noopener,noreferrer");
			clearNotice("security");
		},
		false,
		"security",
	);
}

// --------------------------------------------------------------------------- render

function renderChrome() {
	titleEl.textContent = doc.title || "Untitled document";
	document.title = doc.title || "Vaivén document";

	const label = doc.actor_label ?? "you";
	whoEl.textContent = mode === "write" ? `editing as ${label}` : `read-only · ${label}`;
	// Both of these truncate with an ellipsis in a narrow bar.
	whoEl.title = whoEl.textContent;
	titleEl.title = titleEl.textContent;

	// A10: persistent, not dismissible, and outside the frame so content cannot suppress
	// it. In automatic mode the author never knows this is happening, which makes the
	// shell the only thing that can say so.
	// Read-only viewers were told their edits are recorded. They cannot edit, and nothing
	// they do is recorded — so the one sentence whose entire job is to be accurate about
	// recording was inaccurate for everyone holding a read link.
	disclosure.hidden = false;
	disclosure.replaceChildren(
		el(
			"span",
			null,
			mode === "write"
				? `Edits here are recorded as “${label}” and shared with whoever sent you this link. Anyone who has the link can edit it too. Vaivén.`
				: `You can read this document but not change it. Nothing you do here is recorded. Anyone who has the link can read it too. Vaivén.`,
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
		row.append(el("div", "when", whenOf(event.at)));

		const what = el("div", "what");
		what.append(el("span", "field", event.field ?? event.kind), document.createTextNode(" "));
		if (event.op) {
			what.append(document.createTextNode(`${event.op} ${event.item ?? ""}`));
		} else if (event.from !== undefined || event.to !== undefined) {
			what.append(el("span", "from", event.from || "(empty)"));
			what.append(document.createTextNode(" → "));
			what.append(el("span", "to", event.to || "(empty)"));
		} else if (event.note) {
			what.append(document.createTextNode(event.note));
		}

		// The panel says "everything this document has recorded" and then dropped this on
		// the floor. `Vaiven.log("submitted", {email: "..."})` stores a payload, returns it
		// from the API, and showed the person nothing. Overclaiming is bad anywhere; inside
		// the transparency panel it is the worst place to do it.
		if (event.payload) {
			what.append(el("div", "payload", String(event.payload)));
		}

		what.append(el("div", "by", `by ${event.actor}`));
		row.append(what);
		panelBody.append(row);
	}
}

// ----------------------------------------------------------------- done for now

/**
 * The exit interaction, which the design doc calls the strongest moment in the product:
 * the person says they are finished and, optionally, what they changed. It was a native
 * `prompt()`, which Chrome renders as "vaiven.owncompute.com says:" — the browser
 * affordance most associated with scams, unstyled and untranslatable, on the one page
 * whose whole problem is convincing a stranger it is safe.
 */
const doneDialog = document.createElement("dialog");
const doneNote = document.createElement("textarea");
{
	const head = el("div", "panel-head");
	const cancel = el("button", null, "Not yet");
	cancel.addEventListener("click", () => doneDialog.close());
	head.append(el("h2", null, "Send this back"), cancel);

	const body = el("div", "panel-body");
	const label = el("label", "field-label", "Anything you want to say about what you changed?");
	label.setAttribute("for", "vaiven-done-note");
	doneNote.id = "vaiven-done-note";
	doneNote.rows = 3;
	doneNote.placeholder = "Optional";

	const send = el("button", "primary", "Send");
	send.addEventListener("click", () => doneDialog.close("send"));
	const actions = el("div", "panel-actions");
	actions.append(send);

	body.append(label, doneNote, actions);
	doneDialog.append(head, body);
	document.body.append(doneDialog);
}

doneButton.addEventListener("click", async () => {
	doneNote.value = "";
	doneDialog.showModal();
	doneNote.focus();
	const answered = await new Promise((resolve) =>
		doneDialog.addEventListener("close", () => resolve(doneDialog.returnValue === "send"), { once: true }),
	);
	if (!answered) return;

	const note = doneNote.value.trim();
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
/** Event-id cursor, echoed from the server's next_since. Not the document version. */
let cursor = 0;
/** The republished content_version, held until the person accepts the reload. */
let pendingContentVersion = null;

async function poll() {
	if (!polling) return;
	if (document.visibilityState === "hidden") return;

	try {
		// `since` is an EVENT ID, not a version. Passing doc.version meant the cursor was a
		// small number forever, so every 200 returned the document's whole event history
		// and the "Claude updated …" toast re-announced edits from an hour ago. The server
		// hands back next_since for exactly this; echo it.
		const response = await api(`?since=${cursor}`, {
			headers: doc ? { "if-none-match": `W/"${doc.version}.${doc.content_version}"` } : {},
		});

		if (response.status === 304) return;
		// 403 matters here: a disabled tenant now answers 403 rather than 401, and without
		// it a reader sat on a dead document polling silently every three seconds.
		if (response.status === 401 || response.status === 403 || response.status === 404) {
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
		// Announce first, then the reload offer, so that when a republish does both the
		// offer is what remains: it is the one that needs an answer.
		if (data.events?.length) announceRemote(data.events);
		if (typeof data.next_since === "number") cursor = data.next_since;

		if (doc && data.content_version !== doc.content_version) {
			// Re-offered on every poll until answered. showNotice is idempotent on the same
			// text, so this rebuilds nothing while the offer stands, and it self-heals if a
			// higher-ranked notice ever displaced it.
			pendingContentVersion = data.content_version;
			offerReload();
		}

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
	// Sticky. `observeServer` transitions the writer to "clean" in the same tick as this
	// call, and the clean branch clears notices — so this offer was created and destroyed
	// microseconds apart, on every republish, and nobody ever saw it.
	showNotice(
		"This document has been updated.",
		"Reload it",
		() => {
			if (writer.snapshot().pending) writer.flush("before reload");
			// Assimilate ONLY now. Taking the new content_version at poll time meant that
			// if anything replaced this offer before the person answered it, the condition
			// was false forever and the page kept running the old app.
			if (pendingContentVersion !== null) doc.content_version = pendingContentVersion;
			pendingContentVersion = null;
			clearNotice("update");
			attachFrame();
		},
		true,
		"update",
	);
}

/** A10: the strongest moment in the product — the person seeing the agent respond. */
function announceRemote(events) {
	const fromAgent = events.filter((event) => event.actor === "claude" && event.kind === "edit");
	if (fromAgent.length === 0) return;

	const first = fromAgent[0].field ?? "the document";
	const rest = fromAgent.length - 1;
	// Sticky, for the same reason as offerReload: the poll hands the new state to the
	// writer immediately after this, the writer reports "clean", and the clean branch
	// cleared the toast in the same tick. A10 calls this the strongest moment in the
	// product — the person seeing the agent respond — and it was invisible.
	showNotice(
		rest > 0 ? `Claude updated ${first} and ${rest} other field${rest > 1 ? "s" : ""}.` : `Claude updated ${first}.`,
		"Dismiss",
		() => clearNotice("update"),
		true,
		"update",
	);
}

// ---------------------------------------------------------------------------- boot

const SANDBOX_ORIGIN = document.documentElement.dataset.sandboxOrigin ?? "";

(async () => {
	let response;
	try {
		// events=0 so next_since comes back as the newest id rather than the 500th oldest.
		// Seeding from a paged cursor meant a document with more than 500 events announced
		// several pages of week-old edits as if they had just arrived.
		response = await api("?since=0&events=0");
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
	// Start the cursor past everything that already happened. Without this the first poll
	// re-reads the whole history and announces edits from last week as if they just
	// arrived.
	if (typeof doc.next_since === "number") cursor = doc.next_since;

	// The key's own role decides what this view can do. `keys` is tenant-only, so a
	// document key learns its role from whether writing is permitted at all.
	mode = doc.mode ?? "write";

	renderChrome();
	writer.adopt(latestState, doc.version);
	if (mode !== "write") writer.setReadonly(true);
	attachFrame();
})();
