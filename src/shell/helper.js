// The Vaivén helper. Injected into every `content` document, inside the sandbox.
//
// Architecture note that corrects §7's wording: the spec says "the shell listens for input
// and change across the document." It cannot. The content document has an OPAQUE origin,
// so the shell can neither read its DOM nor attach listeners to it. Everything that
// observes the document lives here and reports upward over postMessage. The shell owns the
// write pipeline (versioning, debounce, conflict merge); the helper owns observation.

(() => {
	"use strict";

	// Substituted at injection time with the app origin. Both ends of this channel used to
	// be unauthenticated at the message layer and rested entirely on `frame-ancestors`: the
	// helper broadcast every keystroke to whatever framed it, and trusted the state and the
	// mode it was handed from the same unchecked source. Now the trust decision is made
	// twice, independently of the header — so a proxy or a refactor that drops the header
	// does not silently open the channel.
	const PARENT_ORIGIN = "__VAIVEN_APP_ORIGIN__";

	const send = (message) => {
		try {
			parent.postMessage(message, PARENT_ORIGIN);
		} catch {
			// Direct navigation to /c/:id has no parent. That is a supported way to view
			// content; it simply records nothing.
		}
	};

	let mode = "read";
	let state = null;
	let paint = null;
	let painting = false;
	let appMode = false;

	// ---------------------------------------------------------------- error capture
	// A12: the agent publishes JavaScript it cannot execute. Without this, a syntax error
	// means the human sees a blank page and the agent learns nothing until somebody
	// complains. Six lines turn /r/ into a debugging channel.

	const reportError = (kind, detail) =>
		send({ type: "error", kind, detail: String(detail ?? "").slice(0, 400) });

	addEventListener("error", (event) => {
		const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
		reportError("script_error", `${event.message}${where}`);
	});

	addEventListener("unhandledrejection", (event) => {
		const reason = event.reason;
		reportError("unhandled_rejection", reason && reason.message ? reason.message : reason);
	});

	// ------------------------------------------------------------- link interception
	// A4: the sandbox denies top-navigation deliberately, so an ordinary <a> would do
	// nothing and look broken. Anchors are handed to the shell, which shows the
	// destination and opens it on the viewer's confirmation.

	addEventListener(
		"click",
		(event) => {
			if (event.defaultPrevented || event.button !== 0) return;
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

			const anchor = event.target?.closest?.("a[href]");
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

	// ---------------------------------------------------------------- automatic mode
	//
	// §7's default: the author writes ordinary HTML with `name` attributes and never
	// learns any of this happened. A10 fills in the cases the spec left to three examples.

	/** A10: these never enter the document. State is readable from a bearer URL, so a
	 *  password captured "helpfully" is a password published. */
	const NEVER_CAPTURE = new Set(["password", "file", "hidden"]);

	function capturable(element) {
		if (element.disabled) return false;
		if (element.closest("[data-vaiven-ignore]")) return false;
		if (NEVER_CAPTURE.has(element.type)) return false;
		const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
		if (autocomplete === "off" || autocomplete.startsWith("cc-") || autocomplete.includes("password")) {
			return false;
		}
		return true;
	}

	/** A3: a field with no `name` gets a structural path, prefixed so it is visibly
	 *  distinct from an author-chosen key and can be reported as a warning. */
	function pathOf(element) {
		// `element.name` is a PROPERTY, and only form controls have one. A
		// `<div contenteditable name="summary">` — the natural way to build the living
		// document this system is named after — has the attribute and not the property, so
		// it fell through to a structural path and could never have a stable key. Read the
		// attribute when the property is absent.
		const named = element.name || element.getAttribute("name");
		if (named) return named;

		const parts = [];
		let node = element;
		while (node && node !== document.body && parts.length < 8) {
			const parent = node.parentElement;
			if (!parent) break;
			const index = [...parent.children].indexOf(node) + 1;
			parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
			node = parent;
		}
		return `~${parts.join(">")}`;
	}

	const FIELDS = "input, textarea, select, [contenteditable]";

	/** Read the whole document into a state object. */
	function readFields() {
		const next = {};

		for (const element of document.querySelectorAll(FIELDS)) {
			if (!capturable(element)) continue;
			const key = pathOf(element);

			if (element.matches("[contenteditable]")) {
				next[key] = element.innerText;
				continue;
			}

			if (element.tagName === "SELECT") {
				// A10: multi-select is array-valued and had no rule at all.
				next[key] = element.multiple
					? [...element.selectedOptions].map((option) => option.value)
					: element.value;
				continue;
			}

			if (element.type === "radio") {
				// A10: a radio group is many elements sharing one name. Last-write-wins
				// would simply record the wrong answer.
				if (element.checked) next[key] = element.value;
				else if (!(key in next)) next[key] = next[key] ?? "";
				continue;
			}

			if (element.type === "checkbox") {
				// Same name on several boxes means a set; a lone box means a boolean.
				const group = document.querySelectorAll(`input[type=checkbox][name="${CSS.escape(element.name)}"]`);
				if (element.name && group.length > 1) {
					next[key] = [...group].filter((box) => box.checked).map((box) => box.value);
				} else {
					next[key] = element.checked;
				}
				continue;
			}

			next[key] = element.value;
		}

		return next;
	}

	/** Put values back after a reload or a remote change. */
	function writeFields(source) {
		if (!source) return;

		for (const element of document.querySelectorAll(FIELDS)) {
			if (!capturable(element)) continue;
			const key = pathOf(element);
			if (!(key in source)) continue;
			const value = source[key];

			// A7/A10: never write to the field someone is typing in. This runs on init,
			// on every poll-applied change and on conflict recovery, in a system that
			// polls every three seconds — an intermittent caret jump is among the most
			// expensive bugs to diagnose later.
			if (element === document.activeElement) continue;

			if (element.matches("[contenteditable]")) {
				if (element.innerText !== value) element.innerText = String(value ?? "");
			} else if (element.tagName === "SELECT" && element.multiple) {
				const wanted = new Set(Array.isArray(value) ? value : []);
				for (const option of element.options) option.selected = wanted.has(option.value);
			} else if (element.type === "radio") {
				element.checked = element.value === value;
			} else if (element.type === "checkbox") {
				element.checked = Array.isArray(value) ? value.includes(element.value) : Boolean(value);
			} else if (element.value !== String(value ?? "")) {
				element.value = String(value ?? "");
			}
		}
	}

	function onFieldEvent() {
		if (appMode || mode !== "write") return;
		state = readFields();
		// The shell debounces and derives the diff. The helper only reports the current
		// truth of the document.
		send({ type: "mutate", state });
	}

	// `input` and `change` both, because autofill fires `change` without `input` in some
	// browsers, and a select fires only `change`.
	document.addEventListener("input", onFieldEvent, true);
	document.addEventListener("change", onFieldEvent, true);

	// -------------------------------------------------------------------- read-only
	// A10: /c/:id needs no auth, so the document renders whether or not the viewer can
	// write. Without this a read-key holder gets a fully interactive form and every
	// keystroke is silently discarded.

	// Reversible, and it only ever touches what IT disabled. The mode is not known until
	// the shell says so, and defaulting to read-only-and-permanent meant a write key
	// opened a document whose every field was dead.
	let modeKnown = false;

	function applyReadonly() {
		if (!modeKnown) return;

		const readonly = mode !== "write";
		for (const element of document.querySelectorAll(FIELDS + ", button")) {
			if (readonly) {
				if (element.hasAttribute("contenteditable")) {
					if (element.getAttribute("contenteditable") !== "false") {
						element.dataset.vaivenWasEditable = "1";
						element.setAttribute("contenteditable", "false");
					}
				} else if (!element.disabled) {
					element.dataset.vaivenDisabled = "1";
					element.disabled = true;
				}
			} else {
				// Restore only what we disabled: a field the author disabled on purpose
				// stays that way.
				if (element.dataset.vaivenWasEditable) {
					element.setAttribute("contenteditable", "true");
					delete element.dataset.vaivenWasEditable;
				}
				if (element.dataset.vaivenDisabled) {
					element.disabled = false;
					delete element.dataset.vaivenDisabled;
				}
			}
		}
	}

	// ------------------------------------------------------------------ height report

	let lastHeight = 0;
	function reportHeight() {
		const height = Math.ceil(document.documentElement.scrollHeight);
		if (height !== lastHeight && height > 0) {
			lastHeight = height;
			send({ type: "resize", height });
		}
	}

	// ------------------------------------------------------- structural change notice

	let warnedDynamic = false;
	const observer = new MutationObserver((records) => {
		applyReadonly();
		reportHeight();

		if (appMode || warnedDynamic) return;
		// A3/§7: automatic mode cannot restore elements the app created, so the author
		// should have used app mode. The signal is that nodes appeared after load.
		const added = records.some((record) =>
			[...record.addedNodes].some((node) => node.nodeType === 1 && node.querySelector?.(FIELDS)),
		);
		if (added) {
			warnedDynamic = true;
			send({
				type: "error",
				kind: "dynamic_fields",
				detail:
					"Fields were added after load while in automatic mode. Automatic mode restores values but not structure, so those rows will be missing on reload. Call Vaiven.render() to take over.",
			});
		}
	});

	/**
	 * A10: shadow DOM is the one field-type case automatic mode cannot serve at all.
	 * `querySelectorAll` does not pierce a shadow root, and an `input` event that crosses
	 * one is retargeted to the HOST, so the path recorded would name the wrong element.
	 * Rather than capture nothing and say nothing, say so once.
	 */
	let warnedShadow = false;
	function checkShadowFields() {
		if (appMode || warnedShadow) return;
		for (const element of document.querySelectorAll("*")) {
			if (!element.shadowRoot) continue;
			if (!element.shadowRoot.querySelector(FIELDS)) continue;
			warnedShadow = true;
			send({
				type: "error",
				kind: "shadow_dom",
				detail:
					"Fields inside a shadow root are not captured by automatic mode: the DOM cannot be read across the boundary and events are retargeted to the host. Call Vaiven.render() and manage that state yourself.",
			});
			return;
		}
	}

	// ----------------------------------------------------------------- public surface

	window.Vaiven = {
		get state() {
			return state;
		},
		get readonly() {
			return mode !== "write";
		},

		render(fn) {
			// Calling render is the opt-out: from here the app owns the DOM and automatic
			// capture stops, because the two would fight over the same document.
			appMode = true;
			paint = () => {
				painting = true;
				try {
					fn(state);
				} finally {
					painting = false;
					reportHeight();
				}
			};
			if (state !== null) paint();
		},

		mutate(fn) {
			if (mode !== "write") return;
			if (painting) {
				// A7: mutate inside render is the natural next thing an author writes, and
				// it writes every debounce interval forever. The shell has a circuit
				// breaker too; this is the polite first line.
				console.warn(
					"[vaiven] Vaiven.mutate() was called from inside Vaiven.render(). Ignored — it would loop forever. Move the mutation into an event handler.",
				);
				return;
			}
			const next = structuredClone(state ?? {});
			fn(next);
			state = next;
			send({ type: "mutate", state: next });
			if (paint) paint();
		},

		/**
		 * Append a note to the document's log.
		 *
		 * The honest name. `log(kind, payload)` shipped first and its `kind` is not a kind —
		 * the shell forces `kind: "note"` and carries the caller's word as the note TEXT, so
		 * `Vaiven.log("error", …)` silently is not an error event and filtering on
		 * `kind === "error"` never matches it. An API whose first parameter lies is a trap
		 * documentation can only mitigate, and the manual has been mitigating it.
		 */
		note(text, payload) {
			send({ type: "event", kind: String(text).slice(0, 60), payload: payload ?? {} });
		},

		/** The old name for `note`. Kept forever, not deprecated at runtime: published
		 *  `content` is served from the database and never rebuilt, so every document already
		 *  calling this must keep working. A console warning would fire in the person's
		 *  browser, not the agent's, so it would scold the wrong party. */
		log(kind, payload) {
			send({ type: "event", kind: String(kind).slice(0, 60), payload: payload ?? {} });
		},
	};

	// ------------------------------------------------------------------- handshake

	addEventListener("message", (event) => {
		if (event.source !== parent) return;
		if (event.origin !== PARENT_ORIGIN) return;
		const message = event.data;
		if (!message || typeof message !== "object") return;

		if (message.type === "init" || message.type === "state") {
			if (typeof message.mode === "string") {
				mode = message.mode;
				modeKnown = true;
			}
			state = message.state ?? {};
			applyReadonly();
			if (appMode) {
				if (paint) paint();
			} else {
				writeFields(state);
			}
			reportHeight();
		}
	});

	const announceReady = () => {
		applyReadonly();
		checkShadowFields();
		observer.observe(document.documentElement, { childList: true, subtree: true });
		addEventListener("resize", reportHeight);
		reportHeight();
		send({ type: "ready" });
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", announceReady, { once: true });
	} else {
		announceReady();
	}
})();
