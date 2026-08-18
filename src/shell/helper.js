// The Vaivén helper. Injected into every `content` document, inside the sandbox.
//
// Architecture note that corrects §7's wording: the spec says "the shell listens for
// input and change across the document." It cannot. The content document has an OPAQUE
// origin, so the shell can neither read its DOM nor attach listeners to it. Everything
// that observes the document has to live in here and report upward over postMessage.
// The shell owns the write pipeline (versioning, debounce, conflict merge); the helper
// owns observation and rendering.
//
// Phase 0 scope: handshake, error capture, link interception, read-only enforcement.
// Phase 4 adds automatic-mode capture, coalescing and the app-mode render/mutate API.

(() => {
	"use strict";

	const send = (message) => {
		try {
			parent.postMessage(message, "*");
		} catch {
			// A frame with no parent (direct navigation to /c/:id) has nowhere to report.
			// That is a supported way to view content; it simply does nothing.
		}
	};

	let mode = "read";
	let state = null;
	let paint = null;
	let painting = false;

	// ---------------------------------------------------------------- error capture
	// A12: the agent publishes JavaScript it cannot execute. Without this, a syntax
	// error means the human sees a blank page and the agent learns nothing until
	// somebody complains. Six lines turn /r/ into a debugging channel.

	const reportError = (kind, detail) => {
		send({ type: "error", kind, detail: String(detail ?? "").slice(0, 400) });
	};

	addEventListener("error", (event) => {
		const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
		reportError("script_error", `${event.message}${where}`);
	});

	addEventListener("unhandledrejection", (event) => {
		const reason = event.reason;
		reportError(
			"unhandled_rejection",
			reason && reason.message ? reason.message : reason,
		);
	});

	// ------------------------------------------------------------- link interception
	// A4: the sandbox denies top-navigation deliberately, so an ordinary <a> would just
	// do nothing and look broken. Anchors are intercepted and handed to the shell, which
	// shows the destination and opens it on the viewer's confirmation. Links keep
	// working; nothing untrusted holds a navigation primitive.

	addEventListener(
		"click",
		(event) => {
			if (event.defaultPrevented || event.button !== 0) return;
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

			const anchor = event.target && event.target.closest && event.target.closest("a[href]");
			if (!anchor) return;

			const href = anchor.getAttribute("href");
			if (!href || href.startsWith("#")) return;

			let url;
			try {
				url = new URL(href, "https://content.invalid/");
			} catch {
				return;
			}
			if (url.protocol !== "https:" && url.protocol !== "mailto:") return;

			event.preventDefault();
			send({ type: "open", url: url.href });
		},
		true,
	);

	// ------------------------------------------------------------------ read-only UI
	// A10: /c/:id needs no auth, so the document renders whether or not the viewer can
	// write. Without this a read-key holder gets a fully interactive form and every
	// keystroke is silently discarded.

	const EDITABLE = "input, textarea, select, button, [contenteditable]";

	function applyReadonly() {
		if (mode === "write") return;
		for (const element of document.querySelectorAll(EDITABLE)) {
			if (element.hasAttribute("contenteditable")) {
				element.setAttribute("contenteditable", "false");
			} else {
				element.disabled = true;
			}
		}
	}

	// Content that adds nodes after load would otherwise escape the sweep.
	const readonlyObserver = new MutationObserver(() => applyReadonly());

	// ----------------------------------------------------------------- public surface

	window.Vaiven = {
		get state() {
			return state;
		},
		get readonly() {
			return mode !== "write";
		},

		render(fn) {
			paint = () => {
				// A7: `mutate` inside `render` is the natural next thing an author writes
				// and produces a write every debounce interval, forever.
				painting = true;
				try {
					fn(state);
				} finally {
					painting = false;
				}
			};
			if (state !== null) paint();
		},

		mutate(fn) {
			if (mode !== "write") return;
			if (painting) {
				console.warn(
					"[vaiven] Vaiven.mutate() was called from inside Vaiven.render(). Ignored — " +
						"it would loop forever. Move the mutation into an event handler.",
				);
				return;
			}
			const next = structuredClone(state ?? {});
			fn(next);
			state = next;
			send({ type: "mutate", state: next });
			if (paint) paint();
		},

		log(kind, payload) {
			send({ type: "event", kind: String(kind).slice(0, 60), payload: payload ?? {} });
		},
	};

	// ------------------------------------------------------------------- handshake

	addEventListener("message", (event) => {
		if (event.source !== parent) return;
		const message = event.data;
		if (!message || typeof message !== "object") return;

		if (message.type === "init" || message.type === "state") {
			if (typeof message.mode === "string") mode = message.mode;
			state = message.state ?? {};
			applyReadonly();
			if (paint) paint();
		}
	});

	const announceReady = () => {
		applyReadonly();
		readonlyObserver.observe(document.documentElement, { childList: true, subtree: true });
		send({ type: "ready" });
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", announceReady, { once: true });
	} else {
		announceReady();
	}
})();
